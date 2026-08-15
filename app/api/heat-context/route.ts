import {
  parseUkhsaHeatContext,
  staleHeatContext,
  UKHSA_HEAT_METRIC_URL,
  unavailableHeatContext,
  type HeatContextCacheable,
} from "../../../lib/heat-context.ts";
import { readBoundedJson } from "../../../lib/bounded-json.ts";
import { raceWithAbort } from "../../../lib/abort-race.ts";
import {
  emitOperationalEvent,
  type OperationalDeliveryPath,
} from "../../../lib/operational-events.ts";

const UPSTREAM_TIMEOUT_MS = 4_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 256_000;
const SERVER_CACHE_TTL_MS = 10 * 60 * 1_000;
const SERVER_STALE_TTL_MS = 60 * 60 * 1_000;

const AVAILABLE_RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=120, s-maxage=600, stale-while-revalidate=1800",
  "X-Content-Type-Options": "nosniff",
};
const UNAVAILABLE_RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=30, s-maxage=60",
  "X-Content-Type-Options": "nosniff",
};

interface CachedContext {
  value: HeatContextCacheable;
  freshUntil: number;
  staleUntil: number;
}

let cachedContext: CachedContext | undefined;
let refreshInFlight: Promise<HeatContextCacheable> | undefined;

interface HeatContextFetchOptions {
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchHeatContext(options: HeatContextFetchOptions = {}) {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number.");
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new DOMException("The UKHSA request timed out.", "TimeoutError")),
    timeoutMs,
  );

  try {
    const response = await raceWithAbort(
      fetchImplementation(UKHSA_HEAT_METRIC_URL, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      }),
      controller.signal,
    );

    if (!response.ok) throw new Error("UKHSA heat-health request failed");

    const parsed = parseUkhsaHeatContext(
      await raceWithAbort(
        readBoundedJson(response, MAX_UPSTREAM_RESPONSE_BYTES),
        controller.signal,
      ),
    );
    if (!parsed) throw new Error("UKHSA heat-health response was invalid");
    return parsed;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function refreshHeatContext(now: number) {
  if (!refreshInFlight) {
    refreshInFlight = fetchHeatContext()
      .then((value) => {
        cachedContext = {
          value,
          freshUntil: now + SERVER_CACHE_TTL_MS,
          staleUntil: now + SERVER_STALE_TTL_MS,
        };
        return value;
      })
      .finally(() => {
        refreshInFlight = undefined;
      });
  }
  return refreshInFlight;
}

interface CurrentHeatContext {
  value: HeatContextCacheable | null;
  delivery: OperationalDeliveryPath;
}

async function currentHeatContext(): Promise<CurrentHeatContext> {
  const now = Date.now();
  if (cachedContext && cachedContext.freshUntil > now) {
    return { value: cachedContext.value, delivery: "cache" };
  }

  try {
    return { value: await refreshHeatContext(now), delivery: "upstream" };
  } catch {
    if (cachedContext && cachedContext.staleUntil > now) {
      return { value: staleHeatContext(cachedContext.value), delivery: "stale_cache" };
    }
    return { value: null, delivery: "none" };
  }
}

export async function GET() {
  const startedAt = performance.now();
  const context = await currentHeatContext();
  const statusCode = context.value ? 200 : 503;
  const outcome = !context.value
    ? "unavailable"
    : context.value.stale
      ? "stale"
      : context.value.status;

  emitOperationalEvent({
    event: "heat_context_response",
    outcome,
    delivery: context.delivery,
    durationMs: performance.now() - startedAt,
    statusCode,
  });

  if (context.value) {
    return Response.json(context.value, { headers: AVAILABLE_RESPONSE_HEADERS });
  }

  return Response.json(unavailableHeatContext(), {
    status: 503,
    headers: UNAVAILABLE_RESPONSE_HEADERS,
  });
}
