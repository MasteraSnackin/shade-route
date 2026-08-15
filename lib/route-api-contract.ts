export const ROUTE_API_ERROR_CODES = [
  "INVALID_REQUEST",
  "REQUEST_TOO_LARGE",
  "INVALID_POINTS",
  "INVALID_ACCESS_PREFERENCE",
  "OUTSIDE_PILOT_AREA",
  "ROUTE_BUSY",
  "ROUTING_UNAVAILABLE",
] as const;

export type RouteApiErrorCode = typeof ROUTE_API_ERROR_CODES[number];

export function isRouteApiErrorCode(value: unknown): value is RouteApiErrorCode {
  return typeof value === "string" &&
    (ROUTE_API_ERROR_CODES as readonly string[]).includes(value);
}
