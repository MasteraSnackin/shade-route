import { BoundedJsonError, readBoundedJson } from "../../../lib/bounded-json.ts";
import {
  PLACE_SEARCH_MAX_QUERY_LENGTH,
  PLACE_SEARCH_MIN_QUERY_LENGTH,
  normalisePlaceSearchQuery,
  placeSearchArea,
  type OnlinePlaceSearchResponse,
} from "../../../lib/place-search-contract.ts";
import { searchOnlinePlaces, type OnlineProviderKeys } from "../../../lib/place-search.ts";

const MAX_REQUEST_BYTES = 1_024;
const MAX_REQUEST_URL_LENGTH = 2_048;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_CLIENT = 30;
const RATE_LIMIT_PER_INSTANCE = 300;
const MAX_RATE_BUCKETS = 2_000;
const CACHE_CAPACITY = 128;
const AVAILABLE_CACHE_TTL_MS = 5 * 60_000;
const UNAVAILABLE_CACHE_TTL_MS = 15_000;

const PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

type PlaceSearchErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_AREA"
  | "INVALID_QUERY"
  | "REQUEST_TOO_LARGE"
  | "RATE_LIMITED";

interface RateBucket {
  count: number;
  windowStartedAt: number;
}

interface CacheEntry {
  expiresAt: number;
  value: OnlinePlaceSearchResponse;
}

const rateBuckets = new Map<string, RateBucket>();
let instanceRateBucket: RateBucket = { count: 0, windowStartedAt: 0 };
const searchCache = new Map<string, CacheEntry>();

function privateJson(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: { ...PRIVATE_RESPONSE_HEADERS, ...extraHeaders },
  });
}

function privateError(code: PlaceSearchErrorCode, message: string, status: number) {
  return privateJson({ error: message, code }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function opaqueDigest(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resetBucket(bucket: RateBucket, now: number) {
  if (now - bucket.windowStartedAt >= RATE_WINDOW_MS) {
    bucket.windowStartedAt = now;
    bucket.count = 0;
  }
}

function pruneRateBuckets(now: number) {
  if (rateBuckets.size < MAX_RATE_BUCKETS) return;
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStartedAt >= RATE_WINDOW_MS) rateBuckets.delete(key);
  }
  while (rateBuckets.size >= MAX_RATE_BUCKETS) {
    const oldest = rateBuckets.keys().next().value as string | undefined;
    if (!oldest) break;
    rateBuckets.delete(oldest);
  }
}

async function consumeRateLimit(request: Request, now: number) {
  resetBucket(instanceRateBucket, now);
  instanceRateBucket.count += 1;
  if (instanceRateBucket.count > RATE_LIMIT_PER_INSTANCE) return false;

  const forwardedAddress = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",", 1)[0]
    ?? "local-or-unknown";
  const clientKey = await opaqueDigest(forwardedAddress.trim().slice(0, 128));
  pruneRateBuckets(now);
  const bucket = rateBuckets.get(clientKey) ?? { count: 0, windowStartedAt: now };
  resetBucket(bucket, now);
  bucket.count += 1;
  rateBuckets.delete(clientKey);
  rateBuckets.set(clientKey, bucket);
  return bucket.count <= RATE_LIMIT_PER_CLIENT;
}

function configuredProviderKeys(): OnlineProviderKeys {
  const usable = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length <= 512 ? trimmed : undefined;
  };
  return {
    osNamesKey: usable(process.env.OS_NAMES_API_KEY ?? process.env.OS_DATA_HUB_API_KEY),
    geoapifyKey: usable(process.env.GEOAPIFY_API_KEY),
  };
}

function pruneSearchCache(now: number) {
  for (const [key, entry] of searchCache) {
    if (entry.expiresAt <= now) searchCache.delete(key);
  }
  while (searchCache.size >= CACHE_CAPACITY) {
    const oldest = searchCache.keys().next().value as string | undefined;
    if (!oldest) break;
    searchCache.delete(oldest);
  }
}

async function cachedSearch(
  query: string,
  area: NonNullable<ReturnType<typeof placeSearchArea>>,
  keys: OnlineProviderKeys,
  signal: AbortSignal,
) {
  const key = await opaqueDigest(`${area.id}\n${query.toLocaleLowerCase("en-GB")}\n${Boolean(keys.osNamesKey)}\n${Boolean(keys.geoapifyKey)}`);
  const now = Date.now();
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) searchCache.delete(key);

  const value = await searchOnlinePlaces(query, area, { keys, signal });
  pruneSearchCache(now);
  searchCache.set(key, {
    value,
    expiresAt: now + (value.status === "available" ? AVAILABLE_CACHE_TTL_MS : UNAVAILABLE_CACHE_TTL_MS),
  });
  return value;
}

/** Only used by deterministic route tests; production callers never need it. */
export function resetPlaceSearchRouteStateForTests() {
  rateBuckets.clear();
  instanceRateBucket = { count: 0, windowStartedAt: 0 };
  searchCache.clear();
}

export async function POST(request: Request) {
  if (request.url.length > MAX_REQUEST_URL_LENGTH) {
    return privateError("INVALID_REQUEST", "The place search request was not valid.", 400);
  }
  if (!await consumeRateLimit(request, Date.now())) {
    return privateJson(
      { error: "Too many place searches. Wait a minute and try again.", code: "RATE_LIMITED" },
      429,
      { "Retry-After": "60" },
    );
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BoundedJsonError && error.code === "payload_too_large") {
      return privateError("REQUEST_TOO_LARGE", "The place search request is too large.", 413);
    }
    return privateError("INVALID_REQUEST", "The place search request was not valid JSON.", 400);
  }

  if (
    !isRecord(body) ||
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, "areaId") ||
    !Object.hasOwn(body, "query")
  ) {
    return privateError("INVALID_REQUEST", "The place search request was not valid.", 400);
  }

  const area = placeSearchArea(body.areaId);
  if (!area) {
    return privateError("INVALID_AREA", "Choose one of the two ShadeRoute pilot areas.", 400);
  }
  const query = normalisePlaceSearchQuery(body.query);
  if (!query) {
    return privateError(
      "INVALID_QUERY",
      `Type between ${PLACE_SEARCH_MIN_QUERY_LENGTH} and ${PLACE_SEARCH_MAX_QUERY_LENGTH} characters to search.`,
      400,
    );
  }

  const result = await cachedSearch(query, area, configuredProviderKeys(), request.signal);
  return privateJson(result);
}
