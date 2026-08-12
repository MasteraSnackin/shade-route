import {
  compactValhallaResponse,
  type PilotArea,
  type WalkingRoute,
} from "../../../lib/routes.ts";
import { BoundedJsonError, readBoundedJson } from "../../../lib/bounded-json.ts";
import type { RouteApiErrorCode } from "../../../lib/route-api-contract.ts";

const AREAS: Array<Pick<PilotArea, "id" | "bbox">> = [
  { id: "waterloo", bbox: [-0.13, 51.4915, -0.0975, 51.5095] },
  { id: "kings-cross", bbox: [-0.145, 51.517, -0.109, 51.5365] },
];

type RoutePoint = { lat: number; lon: number };

const TOTAL_UPSTREAM_TIMEOUT_MS = 8_000;
const PER_ENDPOINT_TIMEOUT_MS = 3_500;
const MAX_REQUEST_BYTES = 4_096;
const MAX_UPSTREAM_RESPONSE_BYTES = 1_500_000;
const PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

function privateJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: PRIVATE_RESPONSE_HEADERS });
}

function privateError(
  code: RouteApiErrorCode,
  message: string,
  status: number,
  retryable = false,
) {
  return privateJson({ error: message, code, retryable }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validPoint(value: unknown): value is RoutePoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.lat === "number" &&
    typeof point.lon === "number" &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon)
  );
}

function areaForPoints(origin: RoutePoint, destination: RoutePoint) {
  return AREAS.find(({ bbox }) => {
    const [west, south, east, north] = bbox;
    const inside = (point: RoutePoint) =>
      point.lon >= west && point.lon <= east && point.lat >= south && point.lat <= north;
    return inside(origin) && inside(destination);
  });
}

function isSafeRoutingEndpoint(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function routingEndpoints() {
  const configured = [
    process.env.VALHALLA_URL ?? "https://valhalla1.openstreetmap.de/route",
    process.env.VALHALLA_FALLBACK_URL,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(configured)].filter(isSafeRoutingEndpoint);
}

interface RoutingAttemptOptions {
  endpoints?: string[];
  totalTimeoutMs?: number;
  perEndpointTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

/**
 * Try independent routing endpoints within one bounded deadline. Each endpoint
 * receives a shorter attempt window so a hanging primary cannot consume the
 * fallback's entire budget. Client cancellation aborts the active attempt.
 */
export async function fetchWalkingRoutesWithFallback(
  origin: RoutePoint,
  destination: RoutePoint,
  area: Pick<PilotArea, "id" | "bbox">,
  clientSignal: AbortSignal,
  options: RoutingAttemptOptions = {},
): Promise<WalkingRoute[] | null> {
  const endpoints = [...new Set(options.endpoints ?? routingEndpoints())]
    .filter(isSafeRoutingEndpoint);
  const totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_UPSTREAM_TIMEOUT_MS;
  const perEndpointTimeoutMs = options.perEndpointTimeoutMs ?? PER_ENDPOINT_TIMEOUT_MS;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const totalController = new AbortController();
  const deadline = Date.now() + totalTimeoutMs;
  const totalTimeoutId = setTimeout(() => totalController.abort(), totalTimeoutMs);
  const abortForClient = () => totalController.abort(clientSignal.reason);
  if (clientSignal.aborted) totalController.abort(clientSignal.reason);
  else clientSignal.addEventListener("abort", abortForClient, { once: true });

  try {
    for (const upstream of endpoints) {
      if (totalController.signal.aborted) break;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      const attemptController = new AbortController();
      const abortForTotal = () => attemptController.abort(totalController.signal.reason);
      totalController.signal.addEventListener("abort", abortForTotal, { once: true });
      const attemptTimeoutId = setTimeout(
        () => attemptController.abort(),
        Math.min(perEndpointTimeoutMs, remainingMs),
      );

      try {
        const response = await fetchImplementation(upstream, {
          method: "POST",
          cache: "no-store",
          signal: attemptController.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Client-Id": "shaderoute-hackathon",
          },
          body: JSON.stringify({
            locations: [origin, destination],
            costing: "pedestrian",
            alternates: 2,
            units: "kilometers",
            language: "en-GB",
          }),
        });
        if (!response.ok) continue;
        return compactValhallaResponse(
          await readBoundedJson(response, MAX_UPSTREAM_RESPONSE_BYTES),
          area.id,
          { origin, destination, bbox: area.bbox },
        );
      } catch {
        if (totalController.signal.aborted) break;
        // A configured independent endpoint may still provide a valid response.
      } finally {
        clearTimeout(attemptTimeoutId);
        totalController.signal.removeEventListener("abort", abortForTotal);
      }
    }
    return null;
  } finally {
    clearTimeout(totalTimeoutId);
    clientSignal.removeEventListener("abort", abortForClient);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BoundedJsonError && error.code === "payload_too_large") {
      return privateError(
        "REQUEST_TOO_LARGE",
        "The route request is too large. Choose the two points again.",
        413,
      );
    }
    return privateError(
      "INVALID_REQUEST",
      "The route request was not valid JSON.",
      400,
    );
  }

  if (!isRecord(body) || !validPoint(body.origin) || !validPoint(body.destination)) {
    return privateError(
      "INVALID_POINTS",
      "Choose a valid start and destination.",
      400,
    );
  }

  const area = areaForPoints(body.origin, body.destination);
  if (!area) {
    return privateError(
      "OUTSIDE_PILOT_AREA",
      "Both points must be inside the same ShadeRoute pilot area.",
      400,
    );
  }

  const routes = await fetchWalkingRoutesWithFallback(
    body.origin,
    body.destination,
    area,
    request.signal,
  );
  if (routes) return privateJson({ areaId: area.id, routes });
  return privateError(
    "ROUTING_UNAVAILABLE",
    "Walking routes are temporarily unavailable. Try again or use a pilot journey.",
    503,
    true,
  );
}
