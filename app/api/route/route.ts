import {
  compactValhallaResponse,
  type PilotArea,
  type WalkingRoute,
} from "../../../lib/routes.ts";
import { BoundedJsonError, readBoundedJson } from "../../../lib/bounded-json.ts";
import { raceWithAbort } from "../../../lib/abort-race.ts";
import type { RouteApiErrorCode } from "../../../lib/route-api-contract.ts";
import {
  isRouteAccessPreference,
  type RouteAccessPreference,
} from "../../../lib/route-preferences.ts";
import {
  configuredRoutingEndpoints,
  isSafeRoutingEndpoint,
  type RoutingEndpointConfig,
} from "../../../lib/routing-config.ts";
import { createRouteRequestGate } from "../../../lib/request-gate.ts";
import {
  emitRouteOperationalEvent,
  type RouteOperationalArea,
  type RouteOperationalDelivery,
  type RouteOperationalOutcome,
} from "../../../lib/route-operational-events.ts";

const AREAS: Array<Pick<PilotArea, "id" | "bbox">> = [
  { id: "waterloo", bbox: [-0.13, 51.4915, -0.0975, 51.5095] },
  { id: "kings-cross", bbox: [-0.145, 51.517, -0.109, 51.5365] },
];

type RoutePoint = { lat: number; lon: number };

const TOTAL_UPSTREAM_TIMEOUT_MS = 8_000;
const PER_ENDPOINT_TIMEOUT_MS = 3_500;
const MAX_REQUEST_BYTES = 4_096;
const MAX_UPSTREAM_RESPONSE_BYTES = 1_500_000;
const routeRequestGate = createRouteRequestGate();
const PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

function privateJson(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: { ...PRIVATE_RESPONSE_HEADERS, ...Object.fromEntries(new Headers(headers)) },
  });
}

function privateError(
  code: RouteApiErrorCode,
  message: string,
  status: number,
  retryable = false,
  headers?: HeadersInit,
) {
  return privateJson({ error: message, code, retryable }, status, headers);
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

function routingEndpoints() {
  return configuredRoutingEndpoints();
}

interface RoutingAttemptOptions {
  endpoints?: Array<string | RoutingEndpointConfig>;
  totalTimeoutMs?: number;
  perEndpointTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  onDelivery?: (delivery: "primary" | "fallback", endpointUrl: string) => void;
  accessPreference?: RouteAccessPreference;
}

type RouteDeliverySource = "none" | "local-loopback" | "configured-primary" | "configured-fallback";

function routeDeliverySource(role: "primary" | "fallback", endpointUrl: string): RouteDeliverySource {
  const hostname = new URL(endpointUrl).hostname;
  return role === "primary" && (hostname === "127.0.0.1" || hostname === "localhost")
    ? "local-loopback"
    : role === "primary"
      ? "configured-primary"
      : "configured-fallback";
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
  const endpointCandidates = options.endpoints ?? routingEndpoints();
  const endpointUrls = new Set<string>();
  const endpoints = endpointCandidates
    .map((endpoint, index): RoutingEndpointConfig => typeof endpoint === "string"
      ? { url: endpoint, role: index === 0 ? "primary" : "fallback", headers: {} }
      : endpoint)
    .filter((endpoint) => {
      if (!isSafeRoutingEndpoint(endpoint.url) || endpointUrls.has(endpoint.url)) return false;
      endpointUrls.add(endpoint.url);
      return true;
    });
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
    for (const endpoint of endpoints) {
      if (totalController.signal.aborted) break;
      const upstream = endpoint.url;
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
        const response = await raceWithAbort(
          fetchImplementation(upstream, {
            method: "POST",
            cache: "no-store",
            signal: attemptController.signal,
            headers: {
              "Content-Type": "application/json",
              "X-Client-Id": "shaderoute-hackathon",
              ...endpoint.headers,
            },
            body: JSON.stringify({
              locations: [origin, destination],
              costing: "pedestrian",
              ...(options.accessPreference === "avoid-known-steps"
                ? { costing_options: { pedestrian: { step_penalty: 43_200 } } }
                : {}),
              alternates: 2,
              units: "kilometers",
              language: "en-GB",
            }),
          }),
          attemptController.signal,
        );
        if (!response.ok) continue;
        const routes = compactValhallaResponse(
          await raceWithAbort(
            readBoundedJson(response, MAX_UPSTREAM_RESPONSE_BYTES),
            attemptController.signal,
          ),
          area.id,
          { origin, destination, bbox: area.bbox },
        );
        options.onDelivery?.(endpoint.role, endpoint.url);
        return routes;
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
  const startedAt = performance.now();
  const admission = routeRequestGate.tryEnter();
  if (!admission.allowed) {
    emitRouteOperationalEvent({
      areaId: "unknown",
      outcome: "busy",
      delivery: "none",
      durationMs: performance.now() - startedAt,
      statusCode: 429,
      routeCount: 0,
    });
    return privateError(
      "ROUTE_BUSY",
      "Walking routing is busy. Wait briefly and try again, or use a pilot journey.",
      429,
      true,
      { "Retry-After": String(admission.retryAfterSeconds) },
    );
  }

  let areaId: RouteOperationalArea = "unknown";
  let outcome: RouteOperationalOutcome = "unavailable";
  let delivery: RouteOperationalDelivery = "none";
  let deliverySource: RouteDeliverySource = "none";
  let statusCode = 500;
  let routeCount = 0;

  try {
    let body: unknown;
    try {
      body = await readBoundedJson(request, MAX_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof BoundedJsonError && error.code === "payload_too_large") {
        outcome = "invalid_request";
        statusCode = 413;
        return privateError(
          "REQUEST_TOO_LARGE",
          "The route request is too large. Choose the two points again.",
          413,
        );
      }
      outcome = "invalid_request";
      statusCode = 400;
      return privateError(
        "INVALID_REQUEST",
        "The route request was not valid JSON.",
        400,
      );
    }

    if (!isRecord(body) || !validPoint(body.origin) || !validPoint(body.destination)) {
      outcome = "invalid_request";
      statusCode = 400;
      return privateError(
        "INVALID_POINTS",
        "Choose a valid start and destination.",
        400,
      );
    }

    const accessPreference = body.accessPreference ?? "standard";
    if (!isRouteAccessPreference(accessPreference)) {
      outcome = "invalid_request";
      statusCode = 400;
      return privateError(
        "INVALID_ACCESS_PREFERENCE",
        "Choose a valid walking access preference.",
        400,
      );
    }

    const area = areaForPoints(body.origin, body.destination);
    if (!area) {
      outcome = "outside_pilot";
      statusCode = 400;
      return privateError(
        "OUTSIDE_PILOT_AREA",
        "Both points must be inside the same ShadeRoute pilot area.",
        400,
      );
    }
    areaId = area.id;

    const routes = await fetchWalkingRoutesWithFallback(
      body.origin,
      body.destination,
      area,
      request.signal,
      {
        accessPreference,
        onDelivery: (value, endpointUrl) => {
          delivery = value;
          deliverySource = routeDeliverySource(value, endpointUrl);
        },
      },
    );
    if (routes) {
      outcome = "success";
      statusCode = 200;
      routeCount = routes.length;
      return privateJson(
        { areaId: area.id, routes },
        200,
        {
          "X-ShadeRoute-Route-Delivery": delivery,
          "X-ShadeRoute-Route-Provider": deliverySource,
        },
      );
    }
    statusCode = 503;
    return privateError(
      "ROUTING_UNAVAILABLE",
      "Walking routes are temporarily unavailable. Try again or use a pilot journey.",
      503,
      true,
    );
  } finally {
    emitRouteOperationalEvent({
      areaId,
      outcome,
      delivery,
      durationMs: performance.now() - startedAt,
      statusCode,
      routeCount,
    });
    admission.release();
  }
}
