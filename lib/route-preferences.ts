export const ROUTE_ACCESS_PREFERENCES = [
  "standard",
  "avoid-known-steps",
] as const;

export type RouteAccessPreference = typeof ROUTE_ACCESS_PREFERENCES[number];

export function isRouteAccessPreference(value: unknown): value is RouteAccessPreference {
  return typeof value === "string" &&
    (ROUTE_ACCESS_PREFERENCES as readonly string[]).includes(value);
}
