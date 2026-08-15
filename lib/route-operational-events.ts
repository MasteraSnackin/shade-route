import { durationBucket, type DurationBucket } from "./operational-events.ts";

const AREA_IDS = ["waterloo", "kings-cross", "unknown"] as const;
const OUTCOMES = [
  "success",
  "busy",
  "invalid_request",
  "outside_pilot",
  "unavailable",
] as const;
const DELIVERY_PATHS = ["primary", "fallback", "none"] as const;

export type RouteOperationalArea = typeof AREA_IDS[number];
export type RouteOperationalOutcome = typeof OUTCOMES[number];
export type RouteOperationalDelivery = typeof DELIVERY_PATHS[number];

export interface RouteOperationalEventInput {
  areaId: RouteOperationalArea;
  outcome: RouteOperationalOutcome;
  delivery: RouteOperationalDelivery;
  durationMs: number;
  statusCode: number;
  routeCount: number;
}

export interface RouteOperationalEvent {
  schema: "shaderoute.operational.v1";
  service: "shade-route";
  event: "route_response";
  areaId: RouteOperationalArea;
  outcome: RouteOperationalOutcome;
  delivery: RouteOperationalDelivery;
  durationBucket: DurationBucket;
  statusCode: number;
  routeCount: 0 | 1 | 2 | 3;
}

function memberOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

/** Builds a route event from an explicit allow-list; extra input fields are dropped. */
export function createRouteOperationalEvent(
  input: RouteOperationalEventInput,
): RouteOperationalEvent {
  if (!memberOf(input.areaId, AREA_IDS)) throw new TypeError("Unknown pilot area.");
  if (!memberOf(input.outcome, OUTCOMES)) throw new TypeError("Unknown route outcome.");
  if (!memberOf(input.delivery, DELIVERY_PATHS)) throw new TypeError("Unknown route delivery path.");
  if (!Number.isInteger(input.statusCode) || input.statusCode < 100 || input.statusCode > 599) {
    throw new RangeError("statusCode must be an HTTP status code.");
  }
  if (!Number.isInteger(input.routeCount) || input.routeCount < 0 || input.routeCount > 3) {
    throw new RangeError("routeCount must be between zero and three.");
  }

  return {
    schema: "shaderoute.operational.v1",
    service: "shade-route",
    event: "route_response",
    areaId: input.areaId,
    outcome: input.outcome,
    delivery: input.delivery,
    durationBucket: durationBucket(input.durationMs),
    statusCode: input.statusCode,
    routeCount: input.routeCount as 0 | 1 | 2 | 3,
  };
}

type EventSink = (serialisedEvent: string) => void;

/** Emits one coordinate-free structured line and never breaks routing. */
export function emitRouteOperationalEvent(
  input: RouteOperationalEventInput,
  sink: EventSink = (line) => console.info(line),
) {
  const event = createRouteOperationalEvent(input);
  try {
    sink(JSON.stringify(event));
  } catch {
    // Diagnostics must fail open in the request path.
  }
  return event;
}
