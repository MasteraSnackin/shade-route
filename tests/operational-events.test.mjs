import assert from "node:assert/strict";
import test from "node:test";
import {
  createOperationalEvent,
  durationBucket,
  emitOperationalEvent,
} from "../lib/operational-events.ts";

test("duration metrics use bounded buckets rather than exact request timing", () => {
  assert.equal(durationBucket(0), "under_50_ms");
  assert.equal(durationBucket(49.99), "under_50_ms");
  assert.equal(durationBucket(50), "50_to_199_ms");
  assert.equal(durationBucket(200), "200_to_999_ms");
  assert.equal(durationBucket(1_000), "1_to_3_999_s");
  assert.equal(durationBucket(4_000), "4_s_or_more");
  assert.throws(() => durationBucket(-1), RangeError);
  assert.throws(() => durationBucket(Number.NaN), RangeError);
});

test("operational events copy only allow-listed coordinate-free fields", () => {
  const event = createOperationalEvent({
    event: "heat_context_response",
    outcome: "no_active_alert",
    delivery: "upstream",
    durationMs: 83.4,
    statusCode: 200,
    latitude: 51.5,
    longitude: -0.1,
    geometry: [[-0.1, 51.5]],
    query: "home to hospital",
    ip: "192.0.2.1",
    userAgent: "example",
  });

  assert.deepEqual(event, {
    schema: "shaderoute.operational.v1",
    service: "shade-route",
    event: "heat_context_response",
    outcome: "no_active_alert",
    delivery: "upstream",
    durationBucket: "50_to_199_ms",
    statusCode: 200,
  });
  assert.doesNotMatch(JSON.stringify(event), /latitude|longitude|geometry|query|ip|userAgent|hospital/i);
});

test("event emission is structured and diagnostics fail open", () => {
  const lines = [];
  const input = {
    event: "heat_context_response",
    outcome: "stale",
    delivery: "stale_cache",
    durationMs: 5,
    statusCode: 200,
  };

  const emitted = emitOperationalEvent(input, (line) => lines.push(line));
  assert.deepEqual(JSON.parse(lines[0]), emitted);
  assert.doesNotThrow(() => emitOperationalEvent(input, () => {
    throw new Error("logging unavailable");
  }));
});

test("unknown labels and invalid status codes are rejected", () => {
  const valid = {
    event: "heat_context_response",
    outcome: "available",
    delivery: "cache",
    durationMs: 1,
    statusCode: 200,
  };

  assert.throws(() => createOperationalEvent({ ...valid, event: "route_with_coordinates" }), TypeError);
  assert.throws(() => createOperationalEvent({ ...valid, outcome: "custom" }), TypeError);
  assert.throws(() => createOperationalEvent({ ...valid, delivery: "user-supplied" }), TypeError);
  assert.throws(() => createOperationalEvent({ ...valid, statusCode: 99 }), RangeError);
});
