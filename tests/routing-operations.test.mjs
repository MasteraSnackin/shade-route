import assert from "node:assert/strict";
import test from "node:test";

import { AggregateRequestGate } from "../lib/request-gate.ts";
import { configuredRoutingEndpoints } from "../lib/routing-config.ts";

test("unconfigured routing fails towards the loopback-controlled primary, not a public service", () => {
  assert.deepEqual(configuredRoutingEndpoints({}), [{
    role: "primary",
    url: "http://127.0.0.1:8002/route",
    headers: {},
  }]);
});

test("routing provider configuration keeps credentials in bounded server headers", () => {
  const endpoints = configuredRoutingEndpoints({
    VALHALLA_URL: "http://127.0.0.1:8002/route",
    VALHALLA_AUTH_HEADER: "Authorization",
    VALHALLA_AUTH_TOKEN: "Bearer primary-secret",
    VALHALLA_FALLBACK_URL: "https://fallback.example/route",
    VALHALLA_FALLBACK_AUTH_HEADER: "X-Api-Key",
    VALHALLA_FALLBACK_AUTH_TOKEN: "fallback-secret",
  });

  assert.deepEqual(endpoints, [
    {
      role: "primary",
      url: "http://127.0.0.1:8002/route",
      headers: { Authorization: "Bearer primary-secret" },
    },
    {
      role: "fallback",
      url: "https://fallback.example/route",
      headers: { "X-Api-Key": "fallback-secret" },
    },
  ]);
});

test("routing provider configuration rejects unsafe URLs and protected headers", () => {
  const endpoints = configuredRoutingEndpoints({
    VALHALLA_URL: "http://routing.example/route",
    VALHALLA_AUTH_HEADER: "Host",
    VALHALLA_AUTH_TOKEN: "not-allowed",
    VALHALLA_FALLBACK_URL: "https://safe.example/route",
  });

  assert.deepEqual(endpoints, [{ role: "fallback", url: "https://safe.example/route", headers: {} }]);
});

test("aggregate routing guard bounds concurrency without inspecting identity", () => {
  let now = 1_000;
  const gate = new AggregateRequestGate({
    maximumRequests: 3,
    windowMs: 1_000,
    maximumConcurrent: 1,
    now: () => now,
  });
  const first = gate.tryEnter();
  assert.equal(first.allowed, true);
  assert.deepEqual(gate.tryEnter(), {
    allowed: false,
    reason: "concurrency",
    retryAfterSeconds: 1,
  });
  if (first.allowed) first.release();

  const second = gate.tryEnter();
  assert.equal(second.allowed, true);
  if (second.allowed) second.release();
  const third = gate.tryEnter();
  assert.equal(third.allowed, true);
  if (third.allowed) third.release();
  assert.deepEqual(gate.tryEnter(), {
    allowed: false,
    reason: "rate",
    retryAfterSeconds: 1,
  });

  now = 2_001;
  const afterWindow = gate.tryEnter();
  assert.equal(afterWindow.allowed, true);
  if (afterWindow.allowed) afterWindow.release();
});
