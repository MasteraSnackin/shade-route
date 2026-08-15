const EVENT_NAMES = ["heat_context_response"] as const;
const EVENT_OUTCOMES = [
  "available",
  "no_active_alert",
  "stale",
  "unavailable",
] as const;
const DELIVERY_PATHS = ["cache", "upstream", "stale_cache", "none"] as const;

export type OperationalEventName = typeof EVENT_NAMES[number];
export type OperationalEventOutcome = typeof EVENT_OUTCOMES[number];
export type OperationalDeliveryPath = typeof DELIVERY_PATHS[number];
export type DurationBucket =
  | "under_50_ms"
  | "50_to_199_ms"
  | "200_to_999_ms"
  | "1_to_3_999_s"
  | "4_s_or_more";

export interface OperationalEventInput {
  event: OperationalEventName;
  outcome: OperationalEventOutcome;
  delivery: OperationalDeliveryPath;
  durationMs: number;
  statusCode: number;
}

export interface OperationalEvent {
  schema: "shaderoute.operational.v1";
  service: "shade-route";
  event: OperationalEventName;
  outcome: OperationalEventOutcome;
  delivery: OperationalDeliveryPath;
  durationBucket: DurationBucket;
  statusCode: number;
}

function memberOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

export function durationBucket(durationMs: number): DurationBucket {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError("durationMs must be a non-negative finite number.");
  }
  if (durationMs < 50) return "under_50_ms";
  if (durationMs < 200) return "50_to_199_ms";
  if (durationMs < 1_000) return "200_to_999_ms";
  if (durationMs < 4_000) return "1_to_3_999_s";
  return "4_s_or_more";
}

/**
 * Creates an allow-listed operational record. Additional JavaScript object
 * properties are deliberately not copied, so request data cannot leak into
 * logs through object spreading or permissive labels.
 */
export function createOperationalEvent(input: OperationalEventInput): OperationalEvent {
  if (!memberOf(input.event, EVENT_NAMES)) throw new TypeError("Unknown operational event.");
  if (!memberOf(input.outcome, EVENT_OUTCOMES)) throw new TypeError("Unknown event outcome.");
  if (!memberOf(input.delivery, DELIVERY_PATHS)) throw new TypeError("Unknown delivery path.");
  if (!Number.isInteger(input.statusCode) || input.statusCode < 100 || input.statusCode > 599) {
    throw new RangeError("statusCode must be an HTTP status code.");
  }

  return {
    schema: "shaderoute.operational.v1",
    service: "shade-route",
    event: input.event,
    outcome: input.outcome,
    delivery: input.delivery,
    durationBucket: durationBucket(input.durationMs),
    statusCode: input.statusCode,
  };
}

type EventSink = (serialisedEvent: string) => void;

/** Emits one structured line and never lets diagnostics break a request. */
export function emitOperationalEvent(
  input: OperationalEventInput,
  sink: EventSink = (line) => console.info(line),
) {
  const event = createOperationalEvent(input);
  try {
    sink(JSON.stringify(event));
  } catch {
    // Operational logging must fail open in the request path.
  }
  return event;
}
