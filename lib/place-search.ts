import proj4 from "proj4";
import { raceWithAbort } from "./abort-race.ts";
import { readBoundedJson } from "./bounded-json.ts";
import {
  PLACE_SEARCH_RESULT_LIMIT,
  pointInsidePlaceSearchArea,
  type OnlinePlaceResult,
  type PlaceSearchAreaId,
} from "./place-search-contract.ts";
import type { PilotArea } from "./routes.ts";

const OS_NAMES_URL = "https://api.os.uk/search/names/v1/find";
const GEOAPIFY_URL = "https://api.geoapify.com/v1/geocode/autocomplete";
const PROVIDER_TIMEOUT_MS = 2_500;
const MAX_PROVIDER_RESPONSE_BYTES = 256_000;
const PROVIDER_RESULT_LIMIT = 16;

const OSGB36_DEFINITION =
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
  "+ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.2470,0.8421,-20.4894 +units=m +no_defs";

proj4.defs("EPSG:27700", OSGB36_DEFINITION);

type PilotSearchArea = { id: PlaceSearchAreaId; bbox: PilotArea["bbox"] };

interface ProviderFetchOptions {
  fetchImplementation?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OnlineProviderKeys {
  osNamesKey?: string;
  geoapifyKey?: string;
}

export interface OnlinePlaceSearchOptions extends ProviderFetchOptions {
  keys: OnlineProviderKeys;
}

export interface OnlinePlaceSearchOutcome {
  status: "available" | "unavailable";
  results: OnlinePlaceResult[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function replaceUnsafeControls(value: string) {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
      ? " "
      : character;
  }).join("");
}

function cleanProviderText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null;
  const text = replaceUnsafeControls(value.normalize("NFKC"))
    .replace(/\s+/g, " ")
    .trim();
  return text && text.length <= maximumLength ? text : null;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function humaniseKind(value: unknown, fallback: string) {
  const clean = cleanProviderText(value, 60);
  if (!clean) return fallback;
  return clean
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stableResultId(prefix: "os" | "geo", source: string) {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function bngBounds(area: PilotSearchArea) {
  const [west, south, east, north] = area.bbox;
  const corners = [
    [west, south],
    [west, north],
    [east, south],
    [east, north],
  ].map((coordinate) => proj4("EPSG:4326", "EPSG:27700", coordinate));
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs)), Math.ceil(Math.max(...ys))];
}

async function fetchProviderJson(
  url: URL,
  init: RequestInit,
  options: ProviderFetchOptions,
) {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number.");
  }

  const controller = new AbortController();
  const abortForCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", abortForCaller, { once: true });
  const timeoutId = setTimeout(
    () => controller.abort(new DOMException("The place search timed out.", "TimeoutError")),
    timeoutMs,
  );

  try {
    const response = await raceWithAbort(
      (options.fetchImplementation ?? fetch)(url, {
        ...init,
        cache: "no-store",
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (!response.ok) throw new Error("Place provider request failed.");
    return await raceWithAbort(
      readBoundedJson(response, MAX_PROVIDER_RESPONSE_BYTES),
      controller.signal,
    );
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortForCaller);
  }
}

export function parseOsNamesResults(payload: unknown, area: PilotSearchArea) {
  const root = record(payload);
  if (!root || !Array.isArray(root.results) || root.results.length > 100) {
    throw new Error("OS Names response was not in the expected format.");
  }

  return root.results.slice(0, PROVIDER_RESULT_LIMIT).flatMap((value): OnlinePlaceResult[] => {
    const wrapper = record(value);
    const entry = record(wrapper?.GAZETTEER_ENTRY) ?? wrapper;
    if (!entry) return [];

    const name = cleanProviderText(entry.NAME1, 160);
    const x = finiteNumber(entry.GEOMETRY_X);
    const y = finiteNumber(entry.GEOMETRY_Y);
    if (!name || x === null || y === null || x < 0 || x > 700_000 || y < -100_000 || y > 1_300_000) {
      return [];
    }

    let coordinate: number[];
    try {
      coordinate = proj4("EPSG:27700", "EPSG:4326", [x, y]);
    } catch {
      return [];
    }
    const [lon, lat] = coordinate;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !pointInsidePlaceSearchArea(lon, lat, area)) {
      return [];
    }

    const localType = humaniseKind(entry.LOCAL_TYPE, "Named place");
    const sourceId = cleanProviderText(entry.ID, 160) ?? `${name}:${x}:${y}`;
    return [{
      id: stableResultId("os", sourceId),
      name,
      kind: `OS Names · ${localType}`,
      lon,
      lat,
    }];
  });
}

export function parseGeoapifyResults(payload: unknown, area: PilotSearchArea) {
  const root = record(payload);
  if (!root || !Array.isArray(root.results) || root.results.length > 100) {
    throw new Error("Geoapify response was not in the expected format.");
  }

  return root.results.slice(0, PROVIDER_RESULT_LIMIT).flatMap((value): OnlinePlaceResult[] => {
    const result = record(value);
    if (!result) return [];
    const lon = finiteNumber(result.lon);
    const lat = finiteNumber(result.lat);
    const countryCode = cleanProviderText(result.country_code, 3)?.toLowerCase();
    const name = cleanProviderText(result.formatted, 180)
      ?? [
        cleanProviderText(result.address_line1, 120),
        cleanProviderText(result.address_line2, 120),
      ].filter(Boolean).join(", ");
    if (
      !name ||
      lon === null ||
      lat === null ||
      (countryCode && countryCode !== "gb") ||
      !pointInsidePlaceSearchArea(lon, lat, area)
    ) return [];

    const sourceId = cleanProviderText(result.place_id, 180) ?? `${name}:${lon}:${lat}`;
    return [{
      id: stableResultId("geo", sourceId),
      name,
      kind: `Geoapify · ${humaniseKind(result.result_type, "Address")}`,
      lon,
      lat,
    }];
  });
}

export async function fetchOsNamesResults(
  query: string,
  area: PilotSearchArea,
  apiKey: string,
  options: ProviderFetchOptions = {},
) {
  const url = new URL(OS_NAMES_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("maxresults", String(PROVIDER_RESULT_LIMIT));
  url.searchParams.set("bounds", bngBounds(area).join(","));
  const payload = await fetchProviderJson(url, {
    headers: {
      Accept: "application/json",
      key: apiKey,
    },
  }, options);
  return parseOsNamesResults(payload, area);
}

export async function fetchGeoapifyResults(
  query: string,
  area: PilotSearchArea,
  apiKey: string,
  options: ProviderFetchOptions = {},
) {
  const url = new URL(GEOAPIFY_URL);
  url.searchParams.set("text", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("lang", "en");
  url.searchParams.set("limit", String(PROVIDER_RESULT_LIMIT));
  url.searchParams.set("filter", `rect:${area.bbox.join(",")}|countrycode:gb`);
  url.searchParams.set("apiKey", apiKey);
  const payload = await fetchProviderJson(url, {
    headers: { Accept: "application/json" },
  }, options);
  return parseGeoapifyResults(payload, area);
}

function deduplicateResults(results: OnlinePlaceResult[]) {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = `${result.name.toLocaleLowerCase("en-GB")}:${result.lon.toFixed(5)}:${result.lat.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, PLACE_SEARCH_RESULT_LIMIT);
}

/**
 * Search every configured provider concurrently. A single valid provider keeps
 * online search available; failures stay private and are never reflected in
 * the public error contract.
 */
export async function searchOnlinePlaces(
  query: string,
  area: PilotSearchArea,
  options: OnlinePlaceSearchOptions,
): Promise<OnlinePlaceSearchOutcome> {
  if (options.signal?.aborted) throw options.signal.reason;
  const usableKey = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length <= 512 ? trimmed : null;
  };
  const searches: Array<Promise<OnlinePlaceResult[]>> = [];
  const osNamesKey = usableKey(options.keys.osNamesKey);
  const geoapifyKey = usableKey(options.keys.geoapifyKey);
  if (osNamesKey) {
    searches.push(fetchOsNamesResults(query, area, osNamesKey, options));
  }
  if (geoapifyKey) {
    searches.push(fetchGeoapifyResults(query, area, geoapifyKey, options));
  }
  if (!searches.length) return { status: "unavailable", results: [] };

  const settled = await Promise.allSettled(searches);
  if (options.signal?.aborted) throw options.signal.reason;
  const successful = settled.filter(
    (result): result is PromiseFulfilledResult<OnlinePlaceResult[]> => result.status === "fulfilled",
  );
  if (!successful.length) return { status: "unavailable", results: [] };
  return {
    status: "available",
    results: deduplicateResults(successful.flatMap((result) => result.value)),
  };
}
