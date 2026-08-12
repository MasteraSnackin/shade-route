import {
  parseUkhsaHeatContext,
  staleHeatContext,
  UKHSA_HEAT_METRIC_URL,
  unavailableHeatContext,
  type HeatContextAvailable,
} from "../../../lib/heat-context";

const UPSTREAM_TIMEOUT_MS = 4_000;
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
  value: HeatContextAvailable;
  freshUntil: number;
  staleUntil: number;
}

let cachedContext: CachedContext | undefined;
let refreshInFlight: Promise<HeatContextAvailable> | undefined;

async function fetchHeatContext() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(UKHSA_HEAT_METRIC_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) throw new Error("UKHSA heat-health request failed");

    const parsed = parseUkhsaHeatContext(await response.json());
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

async function currentHeatContext() {
  const now = Date.now();
  if (cachedContext && cachedContext.freshUntil > now) return cachedContext.value;

  try {
    return await refreshHeatContext(now);
  } catch {
    if (cachedContext && cachedContext.staleUntil > now) {
      return staleHeatContext(cachedContext.value);
    }
    return null;
  }
}

export async function GET() {
  const context = await currentHeatContext();
  if (context) return Response.json(context, { headers: AVAILABLE_RESPONSE_HEADERS });

  return Response.json(unavailableHeatContext(), {
    status: 503,
    headers: UNAVAILABLE_RESPONSE_HEADERS,
  });
}
