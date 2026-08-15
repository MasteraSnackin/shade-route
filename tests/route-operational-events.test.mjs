import assert from "node:assert/strict";
import test from "node:test";

import {
  createRouteOperationalEvent,
  emitRouteOperationalEvent,
} from "../lib/route-operational-events.ts";

test("route diagnostics retain only bounded, coordinate-free fields", () => {
  const event = createRouteOperationalEvent({
    areaId: "waterloo",
    outcome: "success",
    delivery: "fallback",
    durationMs: 725,
    statusCode: 200,
    routeCount: 2,
    origin: { latitude: 51.5, longitude: -0.1 },
    geometry: [[-0.1, 51.5]],
    query: "home to hospital",
    ip: "192.0.2.1",
    userAgent: "example",
  });

  assert.deepEqual(event, {
    schema: "shaderoute.operational.v1",
    service: "shade-route",
    event: "route_response",
    areaId: "waterloo",
    outcome: "success",
    delivery: "fallback",
    durationBucket: "200_to_999_ms",
    statusCode: 200,
    routeCount: 2,
  });
  assert.doesNotMatch(JSON.stringify(event), /latitude|longitude|geometry|query|ip|userAgent|hospital/i);
});

test("route diagnostics reject labels and counts outside the public schema", () => {
  const valid = {
    areaId: "kings-cross",
    outcome: "unavailable",
    delivery: "none",
    durationMs: 8_000,
    statusCode: 503,
    routeCount: 0,
  };

  assert.throws(() => createRouteOperationalEvent({ ...valid, areaId: "custom" }), TypeError);
  assert.throws(() => createRouteOperationalEvent({ ...valid, delivery: "provider-url" }), TypeError);
  assert.throws(() => createRouteOperationalEvent({ ...valid, routeCount: 4 }), RangeError);
});

test("route event emission fails open", () => {
  assert.doesNotThrow(() => emitRouteOperationalEvent({
    areaId: "unknown",
    outcome: "busy",
    delivery: "none",
    durationMs: 1,
    statusCode: 429,
    routeCount: 0,
  }, () => {
    throw new Error("logging unavailable");
  }));
});
