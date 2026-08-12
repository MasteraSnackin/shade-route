import assert from "node:assert/strict";
import test from "node:test";

import {
  densifyRoute,
  estimatePointShade,
  getSolarPosition,
  haversineDistanceM,
  projectGeoPoint,
  rayPolygonIntersectionDistanceM,
  requiredOccluderHeightM,
  resolveBuildingHeight,
  scoreRouteShade,
  selectRouteLabels,
  triangularExceedanceProbability,
  unprojectGeoPoint,
} from "../lib/shade.ts";

const LONDON = { lon: -0.12, lat: 51.505 };

function closeTo(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message ?? "values differ"}: expected ${expected} ± ${tolerance}, received ${actual}`,
  );
}

test("local projection round-trips neighbourhood coordinates", () => {
  const point = { lon: -0.105, lat: 51.512 };
  const projected = projectGeoPoint(point, LONDON);
  const recovered = unprojectGeoPoint(projected, LONDON);

  closeTo(recovered.lon, point.lon, 1e-12);
  closeTo(recovered.lat, point.lat, 1e-12);
  closeTo(Math.hypot(projected.x, projected.y), haversineDistanceM(LONDON, point), 1);
});

test("solar position is deterministic and uses north-clockwise azimuth", () => {
  const noon = getSolarPosition(new Date("2026-06-21T12:00:00.000Z"), LONDON);
  assert.equal(noon.isDaylight, true);
  assert.ok(noon.altitudeDeg > 60 && noon.altitudeDeg < 63);
  assert.ok(noon.azimuthDeg > 175 && noon.azimuthDeg < 190);

  const night = getSolarPosition(new Date("2026-06-21T00:00:00.000Z"), LONDON);
  assert.equal(night.isDaylight, false);
  assert.ok(night.altitudeDeg < 0);
});

test("a 45-degree sun ray ten metres away requires an 11.5m obstacle", () => {
  const polygon = [
    { x: 10, y: -2 },
    { x: 12, y: -2 },
    { x: 12, y: 2 },
    { x: 10, y: 2 },
  ];
  assert.equal(
    rayPolygonIntersectionDistanceM({ x: 0, y: 0 }, { x: 1, y: 0 }, polygon),
    10,
  );
  closeTo(requiredOccluderHeightM(10, 45), 11.5, 1e-12);
  assert.equal(
    rayPolygonIntersectionDistanceM({ x: 0, y: 0 }, { x: -1, y: 0 }, polygon),
    null,
  );
});

test("fallback heights use the specified triangular survival probability", () => {
  closeTo(triangularExceedanceProbability(8, 6, 10, 14), 0.875, 1e-12);
  closeTo(triangularExceedanceProbability(10, 6, 10, 14), 0.5, 1e-12);
  closeTo(triangularExceedanceProbability(12, 6, 10, 14), 0.125, 1e-12);
  assert.equal(triangularExceedanceProbability(6, 6, 10, 14), 1);
  assert.equal(triangularExceedanceProbability(14, 6, 10, 14), 0);

  assert.deepEqual(resolveBuildingHeight({ id: "tagged", coordinates: [], levels: 4 }), {
    minM: 12,
    modeM: 12,
    maxM: 12,
    source: "levels",
    uncertain: false,
  });
  assert.deepEqual(resolveBuildingHeight({ id: "fallback", coordinates: [] }), {
    minM: 6,
    modeM: 12,
    maxM: 18,
    source: "fallback",
    uncertain: true,
  });
});

test("route densification preserves distance and produces bounded pieces", () => {
  const end = unprojectGeoPoint({ x: 101, y: 0 }, LONDON);
  const samples = densifyRoute([LONDON, end], 8);
  assert.equal(samples.length, 13);
  assert.ok(samples.every((sample) => sample.distanceM <= 8));
  closeTo(samples.reduce((sum, sample) => sum + sample.distanceM, 0), 101, 0.01);
  closeTo(samples.at(-1).endDistanceM, 101, 0.01);
});

test("point shade combines deterministic geometry with uncertain height", () => {
  const eastTenMetres = unprojectGeoPoint({ x: 10, y: 0 }, LONDON);
  const building = {
    id: "uncertain",
    coordinates: [
      unprojectGeoPoint({ x: 10, y: -2 }, LONDON),
      unprojectGeoPoint({ x: 12, y: -2 }, LONDON),
      unprojectGeoPoint({ x: 12, y: 2 }, LONDON),
      unprojectGeoPoint({ x: 10, y: 2 }, LONDON),
    ],
  };
  assert.ok(eastTenMetres.lon > LONDON.lon);

  const shade = estimatePointShade(
    LONDON,
    [building],
    {
      azimuthDeg: 90,
      altitudeDeg: 45,
      azimuthRad: Math.PI / 2,
      altitudeRad: Math.PI / 4,
      isDaylight: true,
    },
    { fallbackBuildingHeightM: 10, fallbackHeightUncertaintyM: 4 },
  );

  // The near facade is 10m away, so it must exceed 11.5m including receiver height.
  closeTo(shade.shadeProbability, triangularExceedanceProbability(11.5, 6, 10, 14), 0.002);
  assert.deepEqual(shade.directSunRange, [0, 1]);
  assert.deepEqual(shade.occludingBuildingIds, ["uncertain"]);
  closeTo(shade.nearestOccluderDistanceM, 10, 0.01);
});

test("route scoring advances time and aggregates shaded and sunny exposure", () => {
  const departure = new Date("2026-06-21T12:00:00.000Z");
  const solar = getSolarPosition(departure, LONDON);
  const sunDirection = { x: Math.sin(solar.azimuthRad), y: Math.cos(solar.azimuthRad) };
  const perpendicular = { x: -sunDirection.y, y: sunDirection.x };
  const projectedRoute = [-100, 0, 100].map((offset) => ({
    x: perpendicular.x * offset,
    y: perpendicular.y * offset,
  }));
  const route = {
    id: "two-halves",
    name: "Two equal halves",
    coordinates: projectedRoute.map((point) => unprojectGeoPoint(point, LONDON)),
  };
  const firstMidpoint = {
    x: perpendicular.x * -50,
    y: perpendicular.y * -50,
  };
  const buildingCentre = {
    x: firstMidpoint.x + sunDirection.x * 10,
    y: firstMidpoint.y + sunDirection.y * 10,
  };
  const building = {
    id: "first-half-shade",
    heightM: 100,
    coordinates: [
      { x: buildingCentre.x - 4, y: buildingCentre.y - 4 },
      { x: buildingCentre.x + 4, y: buildingCentre.y - 4 },
      { x: buildingCentre.x + 4, y: buildingCentre.y + 4 },
      { x: buildingCentre.x - 4, y: buildingCentre.y + 4 },
    ].map((point) => unprojectGeoPoint(point, LONDON)),
  };

  const score = scoreRouteShade(route, [building], departure, {
    sampleSpacingM: 1_000,
    walkingSpeedMps: 1,
  });

  assert.equal(score.segments.length, 2);
  closeTo(score.distanceM, 200, 0.05);
  closeTo(score.durationSeconds, 200, 0.05);
  closeTo(score.estimatedSunSeconds, 100, 0.15);
  closeTo(score.estimatedShadePercent, 50, 0.1);
  closeTo(score.directSunRangeSeconds[0], 100, 0.15);
  closeTo(score.directSunRangeSeconds[1], 100, 0.15);
  assert.equal(score.coveragePercent, 100);
  assert.equal(score.segments[0].exposure, "shade");
  assert.equal(score.segments[1].exposure, "sun");
  closeTo(
    score.segments[1].midpointTime.getTime() - score.segments[0].midpointTime.getTime(),
    100_000,
    50,
  );
});

test("night routes report no direct-sun exposure", () => {
  const route = {
    id: "night",
    name: "Night route",
    coordinates: [LONDON, unprojectGeoPoint({ x: 50, y: 0 }, LONDON)],
  };
  const score = scoreRouteShade(route, [], new Date("2026-06-21T00:00:00.000Z"));

  assert.equal(score.isDaylight, false);
  assert.equal(score.estimatedSunSeconds, 0);
  assert.equal(score.estimatedShadePercent, null);
  assert.deepEqual(score.directSunRangeSeconds, [0, 0]);
  assert.ok(score.segments.every((segment) => segment.exposure === "night"));
});

function stubScore(id, durationSeconds, estimatedSunSeconds) {
  return {
    id,
    name: id,
    distanceM: durationSeconds,
    durationSeconds,
    estimatedSunSeconds,
    estimatedShadePercent: 50,
    directSunRangeSeconds: [estimatedSunSeconds, estimatedSunSeconds],
    isDaylight: true,
    coveragePercent: 100,
    segments: [],
  };
}

test("route labels enforce the detour guard and worker time trade-off", () => {
  const scores = [
    stubScore("fast", 600, 120),
    stubScore("balanced", 700, 50),
    stubScore("slowest-sun", 900, 10),
  ];
  const vulnerable = Object.fromEntries(
    selectRouteLabels(scores, "vulnerable").map((score) => [score.id, score.labels]),
  );
  assert.deepEqual(vulnerable.fast, ["fastest"]);
  assert.deepEqual(vulnerable.balanced, ["recommended"]);
  assert.deepEqual(vulnerable["slowest-sun"], ["least-sun"]);

  const closeScores = [stubScore("quick", 600, 100), stubScore("slightly-less-sun", 650, 80)];
  const worker = Object.fromEntries(
    selectRouteLabels(closeScores, "worker").map((score) => [score.id, score.labels]),
  );
  assert.ok(worker.quick.includes("recommended"));
  assert.ok(worker["slightly-less-sun"].includes("least-sun"));
});
