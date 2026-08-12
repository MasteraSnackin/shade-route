import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  compactValhallaResponse,
  decodePolyline,
  deduplicateWalkingRoutes,
  routesAreNearDuplicates,
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

test("custom route handler declares private responses and a bounded abort signal", async () => {
  const source = await readFile(new URL("../app/api/route/route.ts", import.meta.url), "utf8");
  assert.match(source, /UPSTREAM_TIMEOUT_MS\s*=\s*8_000/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /signal:\s*controller\.signal/);
  assert.match(source, /private, no-store/);
  assert.doesNotMatch(source, /Cache-Control[\s\S]{0,80}public/);
  assert.match(source, /Both points must be inside the same ShadeRoute pilot area/);
});
