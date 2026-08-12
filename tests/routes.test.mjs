import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fetchWalkingRoutesWithFallback, POST } from "../app/api/route/route.ts";
import {
  compactValhallaResponse,
  decodePolyline,
  deduplicateWalkingRoutes,
  haversineMetres,
  routesAreNearDuplicates,
  validateWalkingRoute,
} from "../lib/routes.ts";

function encodePolyline(coordinates, precision = 6) {
  const factor = 10 ** precision;
  let previousLatitude = 0;
  let previousLongitude = 0;
  let encoded = "";

  const encodeValue = (value) => {
    let remainder = value < 0 ? ~(value << 1) : value << 1;
    let result = "";
    while (remainder >= 0x20) {
      result += String.fromCharCode((0x20 | (remainder & 0x1f)) + 63);
      remainder >>= 5;
    }
    return result + String.fromCharCode(remainder + 63);
  };

  for (const [longitude, latitude] of coordinates) {
    const scaledLatitude = Math.round(latitude * factor);
    const scaledLongitude = Math.round(longitude * factor);
    encoded += encodeValue(scaledLatitude - previousLatitude);
    encoded += encodeValue(scaledLongitude - previousLongitude);
    previousLatitude = scaledLatitude;
    previousLongitude = scaledLongitude;
  }
  return encoded;
}

function trip(coordinates, overrides = {}) {
  return {
    summary: { length: 1.2, time: 900 },
    legs: [
      {
        shape: encodePolyline(coordinates),
        maneuvers: [
          {
            instruction: "Continue towards the hospital",
            verbal_succinct_transition_instruction: "Continue towards the hospital.",
            type: 8,
            bearing_after: 245,
            length: 1.2,
            time: 900,
            begin_shape_index: 0,
            end_shape_index: coordinates.length - 1,
            rough: true,
            travel_type: "foot",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function walkingRoute(id, coordinates) {
  return {
    id,
    coordinates,
    distanceMetres: 1_200,
    durationSeconds: 900,
    directions: [],
  };
}

const START = [-0.12, 51.5];
const END = [-0.11, 51.5];
const BASE = [START, [-0.115, 51.502], END];
const NEAR_DUPLICATE = [START, [-0.11502, 51.50202], END];
const NORTH_ALTERNATIVE = [START, [-0.115, 51.504], END];
const SOUTH_ALTERNATIVE = [START, [-0.115, 51.496], END];

test("route comparison removes pavement-level variants but keeps meaningful alternatives", () => {
  const base = walkingRoute("base", BASE);
  const nearDuplicate = walkingRoute("near", NEAR_DUPLICATE);
  const north = walkingRoute("north", NORTH_ALTERNATIVE);

  assert.equal(routesAreNearDuplicates(base, nearDuplicate), true);
  assert.equal(routesAreNearDuplicates(base, north), false);
  assert.deepEqual(
    deduplicateWalkingRoutes([base, nearDuplicate, north]).map((route) => route.id),
    ["base", "north"],
  );
});

test("Valhalla compaction skips malformed and near-identical candidates", () => {
  const routes = compactValhallaResponse(
    {
      trip: trip(BASE),
      alternates: [
        { trip: { summary: { length: 1, time: 600 }, legs: [] } },
        { trip: trip(NEAR_DUPLICATE) },
        { trip: trip(NORTH_ALTERNATIVE) },
        { trip: trip(SOUTH_ALTERNATIVE) },
      ],
    },
    "waterloo",
  );

  assert.equal(routes.length, 3);
  assert.deepEqual(
    routes.map((route) => route.id),
    ["waterloo-1", "waterloo-2", "waterloo-3"],
  );
  assert.deepEqual(routes.map((route) => route.coordinates), [BASE, NORTH_ALTERNATIVE, SOUTH_ALTERNATIVE]);
  assert.deepEqual(routes[0].directions[0], {
    instruction: "Continue towards the hospital",
    succinctInstruction: "Continue towards the hospital.",
    maneuverType: 8,
    bearingAfter: 245,
    distanceMetres: 1_200,
    durationSeconds: 900,
    beginIndex: 0,
    endIndex: 2,
    roughSurfaceFlag: true,
    travelType: "foot",
  });
});

test("Valhalla compaction returns a valid alternate when the primary trip is unusable", () => {
  const routes = compactValhallaResponse({
    trip: { summary: { length: Number.NaN, time: 0 }, legs: [] },
    alternates: [{ trip: trip(BASE) }],
  });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].id, "custom-1");
});

test("polyline decoding rejects truncated shapes", () => {
  assert.throws(() => decodePolyline("?"), /invalid route shape/i);
});

test("polyline decoding stops before allocating more than 10,000 coordinates", () => {
  const permitted = Array.from({ length: 10_000 }, () => START);
  assert.equal(decodePolyline(encodePolyline(permitted)).length, 10_000);
  assert.throws(
    () => decodePolyline(encodePolyline([...permitted, START])),
    /too many route coordinates/i,
  );
});

test("live routes must match their endpoints, model bounds and reported length", () => {
  const geometryDistance = BASE.slice(1).reduce(
    (sum, coordinate, index) => sum + haversineMetres(BASE[index], coordinate),
    0,
  );
  const route = walkingRoute("valid", BASE);
  route.distanceMetres = Math.round(geometryDistance);
  const context = {
    origin: { lon: START[0], lat: START[1] },
    destination: { lon: END[0], lat: END[1] },
    bbox: [-0.13, 51.49, -0.1, 51.51],
  };

  assert.equal(validateWalkingRoute(route, context), true);
  assert.equal(validateWalkingRoute({ ...route, coordinates: [[-0.14, 51.5], ...BASE.slice(1)] }, context), false);
  assert.equal(validateWalkingRoute({ ...route, distanceMetres: route.distanceMetres * 2 }, context), false);
  assert.equal(validateWalkingRoute(route, {
    ...context,
    destination: { lon: -0.105, lat: 51.5 },
  }), false);
});

test("Valhalla compaction rejects invalid manoeuvre indexes when validating a live route", () => {
  const geometryDistance = BASE.slice(1).reduce(
    (sum, coordinate, index) => sum + haversineMetres(BASE[index], coordinate),
    0,
  );
  const malformed = trip(BASE, { summary: { length: geometryDistance / 1000, time: 900 } });
  malformed.legs[0].maneuvers[0].end_shape_index = BASE.length;
  assert.throws(
    () => compactValhallaResponse(
      { trip: malformed },
      "live",
      {
        origin: { lon: START[0], lat: START[1] },
        destination: { lon: END[0], lat: END[1] },
        bbox: [-0.13, 51.49, -0.1, 51.51],
      },
    ),
    /no usable journeys/i,
  );
});

test("live routes reject zero or rounded-to-zero distance and duration summaries", () => {
  const context = {
    origin: { lon: START[0], lat: START[1] },
    destination: { lon: END[0], lat: END[1] },
    bbox: [-0.13, 51.49, -0.1, 51.51],
  };
  const zeroDistanceRoute = walkingRoute("zero-distance", [START, [-0.11999999, 51.5]]);
  zeroDistanceRoute.distanceMetres = 0;
  assert.equal(validateWalkingRoute(zeroDistanceRoute, {
    ...context,
    destination: { lon: -0.11999999, lat: 51.5 },
  }), false);
  assert.equal(validateWalkingRoute({ ...zeroDistanceRoute, distanceMetres: 1, durationSeconds: 0 }, {
    ...context,
    destination: { lon: -0.11999999, lat: 51.5 },
  }), false);

  for (const summary of [
    { length: 0, time: 900 },
    { length: -0.1, time: 900 },
    { length: 0.0004, time: 900 },
    { length: 1.2, time: 0 },
    { length: 1.2, time: -1 },
    { length: 1.2, time: 0.4 },
  ]) {
    assert.throws(
      () => compactValhallaResponse({ trip: trip(BASE, { summary }) }),
      /no usable journeys/i,
    );
  }
});

test("a timed-out primary leaves time for an independent routing fallback", async () => {
  const geometryDistance = BASE.slice(1).reduce(
    (sum, coordinate, index) => sum + haversineMetres(BASE[index], coordinate),
    0,
  );
  const calls = [];
  const fetchImplementation = (url, init) => {
    calls.push(url);
    if (url.includes("primary")) {
      return new Promise((resolve, reject) => {
        void resolve;
        const rejectForAbort = () => reject(
          init.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"),
        );
        if (init.signal.aborted) rejectForAbort();
        else init.signal.addEventListener("abort", rejectForAbort, { once: true });
      });
    }
    return Promise.resolve(Response.json({
      trip: trip(BASE, {
        summary: { length: geometryDistance / 1000, time: 900 },
      }),
    }));
  };

  const routes = await fetchWalkingRoutesWithFallback(
    { lon: START[0], lat: START[1] },
    { lon: END[0], lat: END[1] },
    { id: "waterloo", bbox: [-0.13, 51.49, -0.1, 51.51] },
    new AbortController().signal,
    {
      endpoints: ["https://primary.test/route", "https://fallback.test/route"],
      totalTimeoutMs: 200,
      perEndpointTimeoutMs: 20,
      fetchImplementation,
    },
  );

  assert.deepEqual(calls, ["https://primary.test/route", "https://fallback.test/route"]);
  assert.equal(routes?.length, 1);
  assert.deepEqual(routes?.[0].coordinates, BASE);
});

test("client cancellation aborts the active route request without trying fallback", async () => {
  const calls = [];
  const fetchImplementation = (url, init) => {
    calls.push(url);
    return new Promise((resolve, reject) => {
      void resolve;
      const rejectForAbort = () => reject(
        init.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"),
      );
      if (init.signal.aborted) rejectForAbort();
      else init.signal.addEventListener("abort", rejectForAbort, { once: true });
    });
  };
  const clientController = new AbortController();
  const pending = fetchWalkingRoutesWithFallback(
    { lon: START[0], lat: START[1] },
    { lon: END[0], lat: END[1] },
    { id: "waterloo", bbox: [-0.13, 51.49, -0.1, 51.51] },
    clientController.signal,
    {
      endpoints: ["https://primary.test/route", "https://fallback.test/route"],
      totalTimeoutMs: 200,
      perEndpointTimeoutMs: 100,
      fetchImplementation,
    },
  );
  clientController.abort();

  assert.equal(await pending, null);
  assert.deepEqual(calls, ["https://primary.test/route"]);
});

test("custom route handler returns typed client errors for hostile JSON shapes and size", async (t) => {
  await t.test("non-object JSON does not escape as a server error", async () => {
    for (const body of [null, [], true, 1, "route"]) {
      const response = await POST(new Request("http://localhost/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "Choose a valid start and destination.",
        code: "INVALID_POINTS",
        retryable: false,
      });
      assert.match(response.headers.get("cache-control"), /private, no-store/);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }
  });

  await t.test("malformed JSON is distinct from an oversize request", async () => {
    const malformed = await POST(new Request("http://localhost/api/route", {
      method: "POST",
      body: "{",
    }));
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, "INVALID_REQUEST");

    const oversize = await POST(new Request("http://localhost/api/route", {
      method: "POST",
      body: JSON.stringify({ padding: "x".repeat(5_000) }),
    }));
    assert.equal(oversize.status, 413);
    assert.deepEqual(await oversize.json(), {
      error: "The route request is too large. Choose the two points again.",
      code: "REQUEST_TOO_LARGE",
      retryable: false,
    });
  });
});

test("custom route handler declares private responses and bounded fallback deadlines", async () => {
  const source = await readFile(new URL("../app/api/route/route.ts", import.meta.url), "utf8");
  assert.match(source, /TOTAL_UPSTREAM_TIMEOUT_MS\s*=\s*8_000/);
  assert.match(source, /PER_ENDPOINT_TIMEOUT_MS\s*=\s*3_500/);
  assert.match(source, /const totalController = new AbortController\(\)/);
  assert.match(source, /const attemptController = new AbortController\(\)/);
  assert.match(source, /signal:\s*attemptController\.signal/);
  assert.match(source, /private, no-store/);
  assert.doesNotMatch(source, /Cache-Control[\s\S]{0,80}public/);
  assert.match(source, /Both points must be inside the same ShadeRoute pilot area/);
  assert.match(source, /MAX_UPSTREAM_RESPONSE_BYTES/);
  assert.match(source, /REQUEST_TOO_LARGE/);
  assert.match(source, /ROUTING_UNAVAILABLE/);
  assert.match(source, /VALHALLA_FALLBACK_URL/);
  assert.match(source, /compactValhallaResponse[\s\S]+bbox:\s*area\.bbox/);
});
