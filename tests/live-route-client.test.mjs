import assert from "node:assert/strict";
import test from "node:test";

import {
  isLiveRouteRequestCancelledError,
  LiveRouteRequestCancelledError,
  LiveRouteRequestClient,
  LiveRouteRequestError,
} from "../lib/live-route-client.ts";
import { haversineMetres } from "../lib/routes.ts";

const WATERLOO = {
  id: "waterloo",
  bbox: [-0.13, 51.4915, -0.0975, 51.5095],
};
const KINGS_CROSS = {
  id: "kings-cross",
  bbox: [-0.145, 51.517, -0.109, 51.5365],
};
const WATERLOO_INPUT = {
  area: WATERLOO,
  origin: { lon: -0.12, lat: 51.5 },
  destination: { lon: -0.118, lat: 51.5 },
};
const KINGS_CROSS_INPUT = {
  area: KINGS_CROSS,
  origin: { lon: -0.13, lat: 51.525 },
  destination: { lon: -0.128, lat: 51.525 },
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function validRoute(input, id = `${input.area.id}-live-1`) {
  const coordinates = [
    [input.origin.lon, input.origin.lat],
    [input.destination.lon, input.destination.lat],
  ];
  return {
    id,
    coordinates,
    distanceMetres: Math.round(haversineMetres(coordinates[0], coordinates[1])),
    durationSeconds: 120,
    directions: [],
  };
}

function successfulResponse(input, routes = [validRoute(input)]) {
  return Response.json({ areaId: input.area.id, routes });
}

test("switching pilot area aborts the old request and stale responses cannot win", async () => {
  const requests = [];
  const client = new LiveRouteRequestClient({
    fetchImplementation: (_url, init) => {
      const pending = deferred();
      requests.push({ ...pending, signal: init.signal });
      return pending.promise;
    },
  });

  const firstRequest = client.request(WATERLOO_INPUT);
  const firstOutcome = firstRequest.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  assert.equal(client.activeGeneration, 1);

  const secondRequest = client.request(KINGS_CROSS_INPUT);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(client.activeGeneration, 2);

  requests[1].resolve(successfulResponse(KINGS_CROSS_INPUT));
  const secondResult = await secondRequest;
  assert.equal(secondResult.areaId, "kings-cross");
  assert.equal(secondResult.generation, 2);
  assert.equal(secondResult.routes[0].id, "kings-cross-live-1");

  // This mock deliberately ignores AbortSignal and delivers the old area late.
  requests[0].resolve(successfulResponse(WATERLOO_INPUT));
  const staleResult = await firstOutcome;
  assert.ok(staleResult.error instanceof LiveRouteRequestCancelledError);
  assert.equal(staleResult.error.reason, "superseded");
  assert.equal(isLiveRouteRequestCancelledError(staleResult.error), true);
  assert.equal(client.hasActiveRequest, false);
});

test("a successful response must declare the requested area and valid route array", async (t) => {
  await t.test("rejects another pilot area's response", async () => {
    const client = new LiveRouteRequestClient({
      fetchImplementation: async () => Response.json({
        areaId: "kings-cross",
        routes: [validRoute(WATERLOO_INPUT)],
      }),
    });
    const error = await client.request(WATERLOO_INPUT).then(
      () => null,
      (caught) => caught,
    );
    assert.ok(error instanceof LiveRouteRequestError);
    assert.equal(isLiveRouteRequestCancelledError(error), false);
    assert.match(error.message, /requested pilot area/i);
  });

  await t.test("rejects malformed and out-of-area routes", async () => {
    const invalidRoute = {
      ...validRoute(WATERLOO_INPUT),
      coordinates: [[-0.2, 51.5], [-0.19, 51.5]],
    };
    const client = new LiveRouteRequestClient({
      fetchImplementation: async () => successfulResponse(WATERLOO_INPUT, [invalidRoute]),
    });
    const error = await client.request(WATERLOO_INPUT).then(
      () => null,
      (caught) => caught,
    );
    assert.ok(error instanceof LiveRouteRequestError);
    assert.equal(isLiveRouteRequestCancelledError(error), false);
    assert.match(error.message, /valid walking routes/i);
  });
});

test("explicit cancellation is distinguishable from a route failure", async () => {
  let requestSignal;
  const client = new LiveRouteRequestClient({
    fetchImplementation: (_url, init) => new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      const rejectForAbort = () => reject(
        new DOMException("The operation was aborted.", "AbortError"),
      );
      if (init.signal.aborted) rejectForAbort();
      else init.signal.addEventListener("abort", rejectForAbort, { once: true });
    }),
  });

  const pending = client.request(WATERLOO_INPUT);
  const outcome = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  client.cancel();

  assert.equal(requestSignal.aborted, true);
  const result = await outcome;
  assert.ok(result.error instanceof LiveRouteRequestCancelledError);
  assert.equal(result.error.reason, "cancelled");
  assert.equal(result.error instanceof LiveRouteRequestError, false);
  assert.equal(client.hasActiveRequest, false);
});

test("HTTP route failures retain their safe message and status", async () => {
  const client = new LiveRouteRequestClient({
    fetchImplementation: async () => Response.json(
      {
        error: "No walkable route was returned.",
        code: "ROUTING_UNAVAILABLE",
        retryable: true,
      },
      { status: 503 },
    ),
  });

  const error = await client.request(WATERLOO_INPUT).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error instanceof LiveRouteRequestError);
  assert.equal(error.status, 503);
  assert.equal(error.message, "No walkable route was returned.");
  assert.equal(error.code, "ROUTING_UNAVAILABLE");
  assert.equal(error.retryable, true);
  assert.equal(isLiveRouteRequestCancelledError(error), false);
});

test("the selected access preference is sent explicitly to the same-origin route API", async () => {
  let requestBody;
  const client = new LiveRouteRequestClient({
    fetchImplementation: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return successfulResponse(WATERLOO_INPUT);
    },
  });

  await client.request({
    ...WATERLOO_INPUT,
    accessPreference: "avoid-known-steps",
  });
  assert.deepEqual(requestBody, {
    origin: WATERLOO_INPUT.origin,
    destination: WATERLOO_INPUT.destination,
    accessPreference: "avoid-known-steps",
  });
});

test("route lookup has a bounded client deadline distinct from user cancellation", async (t) => {
  async function expectTimeout(fetchImplementation) {
    const client = new LiveRouteRequestClient({
      requestTimeoutMs: 15,
      fetchImplementation,
    });
    const error = await client.request(WATERLOO_INPUT).then(
      () => null,
      (caught) => caught,
    );
    assert.ok(error instanceof LiveRouteRequestError);
    assert.equal(error.code, "REQUEST_TIMEOUT");
    assert.equal(error.retryable, true);
    assert.equal(isLiveRouteRequestCancelledError(error), false);
    assert.match(error.message, /took too long/i);
    assert.equal(client.hasActiveRequest, false);
  }

  await t.test("while awaiting response headers", async () => {
    await expectTimeout(() => new Promise(() => {}));
  });

  await t.test("while reading a successful response body", async () => {
    await expectTimeout(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    }));
  });
});

test("network failures retain their cause and recovery metadata", async () => {
  const failure = new TypeError("fetch failed");
  const client = new LiveRouteRequestClient({
    fetchImplementation: async () => {
      throw failure;
    },
  });

  const error = await client.request(WATERLOO_INPUT).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error instanceof LiveRouteRequestError);
  assert.equal(error.code, "NETWORK_FAILURE");
  assert.equal(error.retryable, true);
  assert.equal(error.cause, failure);
  assert.match(error.message, /check your connection/i);
});

test("invalid client timeout configuration fails fast", () => {
  assert.throws(
    () => new LiveRouteRequestClient({ requestTimeoutMs: 0 }),
    RangeError,
  );
});
