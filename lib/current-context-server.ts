import { raceWithAbort } from "./abort-race.ts";
import { readBoundedJson } from "./bounded-json.ts";
import {
  CURRENT_CONTEXT_AREAS,
  disabledMetOfficeContext,
  disabledStreetManagerContext,
  disabledTflContext,
  markCurrentContextStale,
  parseMetOfficeCurrentContext,
  parseTflCurrentContext,
  unavailableMetOfficeContext,
  unavailableTflContext,
  type CurrentContextAreaId,
  type CurrentJourneyContextData,
  type MetOfficeCurrentContext,
  type TflCurrentContext,
} from "./current-context.ts";

const TFL_API_ROOT = "https://api.tfl.gov.uk";
const MET_OFFICE_HOURLY_URL = "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/hourly";
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_TFL_RESPONSE_BYTES = 512_000;
const MAX_WEATHER_RESPONSE_BYTES = 512_000;
const FRESH_TTL_MS = 5 * 60 * 1_000;
const STALE_TTL_MS = 30 * 60 * 1_000;

export interface CurrentContextEnvironment {
  TFL_API_KEY?: string;
  TFL_ALLOW_ANONYMOUS?: string;
  MET_OFFICE_API_KEY?: string;
}

interface FetchOptions {
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  now?: Date;
}

interface CacheRecord<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}

const providerCache = new Map<string, CacheRecord<TflCurrentContext | MetOfficeCurrentContext>>();
const refreshes = new Map<string, Promise<TflCurrentContext | MetOfficeCurrentContext>>();

function cleanServerSecret(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const hasControlCharacter = Array.from(trimmed).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  return trimmed.length >= 1 && trimmed.length <= 512 && !hasControlCharacter
    ? trimmed
    : null;
}

function configuredEnvironment(): CurrentContextEnvironment {
  return {
    TFL_API_KEY: process.env.TFL_API_KEY,
    TFL_ALLOW_ANONYMOUS: process.env.TFL_ALLOW_ANONYMOUS,
    MET_OFFICE_API_KEY: process.env.MET_OFFICE_API_KEY,
  };
}

async function fetchBoundedJson(
  url: URL,
  headers: Record<string, string>,
  maximumBytes: number,
  options: FetchOptions,
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new RangeError("timeoutMs must be between 1 and 30,000 milliseconds.");
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new DOMException("The provider request timed out.", "TimeoutError")),
    timeoutMs,
  );
  try {
    const response = await raceWithAbort(
      (options.fetchImplementation ?? fetch)(url, {
        cache: "no-store",
        headers: { Accept: "application/json", ...headers },
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (!response.ok) throw new Error("Current-context provider request failed.");
    return await raceWithAbort(readBoundedJson(response, maximumBytes), controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchTflCurrentContext(
  areaId: CurrentContextAreaId,
  environment: CurrentContextEnvironment,
  options: FetchOptions = {},
): Promise<TflCurrentContext> {
  const apiKey = cleanServerSecret(environment.TFL_API_KEY);
  const anonymousAccess = environment.TFL_ALLOW_ANONYMOUS?.trim().toLowerCase() === "true";
  if (!apiKey && !anonymousAccess) return disabledTflContext(areaId);
  const station = CURRENT_CONTEXT_AREAS[areaId].tflStation;
  const liftsUrl = new URL("/Disruptions/Lifts/", TFL_API_ROOT);
  const disruptionsUrl = new URL(`/StopPoint/${encodeURIComponent(station.naptanId)}/Disruption`, TFL_API_ROOT);
  if (apiKey) {
    liftsUrl.searchParams.set("app_key", apiKey);
    disruptionsUrl.searchParams.set("app_key", apiKey);
  }
  const [liftPayload, disruptionPayload] = await Promise.all([
    fetchBoundedJson(liftsUrl, {}, MAX_TFL_RESPONSE_BYTES, options),
    fetchBoundedJson(disruptionsUrl, {}, MAX_TFL_RESPONSE_BYTES, options),
  ]);
  const retrievedAt = (options.now ?? new Date()).toISOString();
  const parsed = parseTflCurrentContext(areaId, liftPayload, disruptionPayload, retrievedAt);
  if (!parsed) throw new Error("TfL returned an invalid current-context response.");
  return parsed;
}

export async function fetchMetOfficeCurrentContext(
  areaId: CurrentContextAreaId,
  environment: CurrentContextEnvironment,
  options: FetchOptions = {},
): Promise<MetOfficeCurrentContext> {
  const apiKey = cleanServerSecret(environment.MET_OFFICE_API_KEY);
  if (!apiKey) return disabledMetOfficeContext();
  const point = CURRENT_CONTEXT_AREAS[areaId].weatherPoint;
  const url = new URL(MET_OFFICE_HOURLY_URL);
  url.searchParams.set("latitude", String(point.latitude));
  url.searchParams.set("longitude", String(point.longitude));
  url.searchParams.set("dataSource", "BD1");
  url.searchParams.set("excludeParameterMetadata", "true");
  const payload = await fetchBoundedJson(url, { apikey: apiKey }, MAX_WEATHER_RESPONSE_BYTES, options);
  const now = options.now ?? new Date();
  const parsed = parseMetOfficeCurrentContext(payload, now.toISOString(), now);
  if (!parsed) throw new Error("Met Office returned an invalid current-context response.");
  return parsed;
}

async function cachedProvider<T extends TflCurrentContext | MetOfficeCurrentContext>(
  key: string,
  now: number,
  load: () => Promise<T>,
  fallback: () => T,
): Promise<T> {
  const cached = providerCache.get(key) as CacheRecord<T> | undefined;
  if (cached && cached.freshUntil > now) return cached.value;

  try {
    let refresh = refreshes.get(key) as Promise<T> | undefined;
    if (!refresh) {
      refresh = load();
      refreshes.set(key, refresh);
    }
    const value = await refresh;
    if (value.status === "available") {
      providerCache.set(key, {
        value,
        freshUntil: now + FRESH_TTL_MS,
        staleUntil: now + STALE_TTL_MS,
      });
    }
    return value;
  } catch {
    if (cached && cached.staleUntil > now) return markCurrentContextStale(cached.value);
    return fallback();
  } finally {
    refreshes.delete(key);
  }
}

export async function getCurrentJourneyContext(
  areaId: CurrentContextAreaId,
  environment: CurrentContextEnvironment = configuredEnvironment(),
  options: FetchOptions = {},
): Promise<CurrentJourneyContextData> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const [tfl, weather] = await Promise.all([
    cachedProvider(
      `${areaId}:tfl`,
      nowMs,
      () => fetchTflCurrentContext(areaId, environment, { ...options, now }),
      () => unavailableTflContext(areaId),
    ),
    cachedProvider(
      `${areaId}:weather`,
      nowMs,
      () => fetchMetOfficeCurrentContext(areaId, environment, { ...options, now }),
      unavailableMetOfficeContext,
    ),
  ]);
  const roadworks = disabledStreetManagerContext();

  return {
    contractVersion: 1,
    areaId,
    areaName: CURRENT_CONTEXT_AREAS[areaId].name,
    generatedAt: now.toISOString(),
    providers: { tfl, weather, roadworks },
    limitations: [
      "Current provider records may be incomplete, delayed or unavailable.",
      "They do not confirm that a footway is open or closed, or that a journey is step-free.",
      "Current context is informational and never changes ShadeRoute's shade ranking.",
    ],
  };
}

export function clearCurrentContextCacheForTests() {
  providerCache.clear();
  refreshes.clear();
}
