import assert from "node:assert/strict";
import test from "node:test";
import * as SunCalc from "suncalc";

import {
  aggregateScheduleScores,
  assessPointExposure,
  labelRouteScores,
  longitudeLatitudeToBng,
  scoreRouteAgainstGrid,
} from "../lib/raster-shade.ts";
import {
  formatLondonDateTime,
  initialLondonDateTimeValue,
  londonDateTimeValue,
  parseLondonDateTime,
  setLondonLocalHour,
} from "../lib/london-time.ts";

const LONDON = /** @type {[number, number]} */ ([-0.12, 51.505]);
const SUMMER_NOON = new Date("2026-06-21T12:00:00.000Z");

function closeTo(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message ?? "values differ"}: expected ${expected} ± ${tolerance}, received ${actual}`,
  );
}

function makeGrid(halfSizeMetres = 200, resolutionMetres = 2) {
  const [centreEasting, centreNorthing] = longitudeLatitudeToBng(LONDON);
  const width = Math.ceil((halfSizeMetres * 2) / resolutionMetres);
  const height = width;
  return {
    metadata: {
      id: "test",
      width,
      height,
      bboxBng: [
        centreEasting - halfSizeMetres,
        centreNorthing - halfSizeMetres,
        centreEasting - halfSizeMetres + width * resolutionMetres,
        centreNorthing - halfSizeMetres + height * resolutionMetres,
      ],
      resolutionMetres,
      heightStepMetres: 1,
      coveragePercent: 100,
      source: "synthetic",
      sourceDate: "test",
      processed: "test",
    },
    heights: new Uint8Array(width * height),
  };
}

function setHeight(grid, easting, northing, metres) {
  const [minEasting, , , maxNorthing] = grid.metadata.bboxBng;
  const x = Math.floor((easting - minEasting) / grid.metadata.resolutionMetres);
  const y = Math.floor((maxNorthing - northing) / grid.metadata.resolutionMetres);
  assert.ok(x >= 0 && y >= 0 && x < grid.metadata.width && y < grid.metadata.height);
  grid.heights[y * grid.metadata.width + x] = Math.round(metres);
}

function setValidity(grid, easting, northing, value) {
  const [minEasting, , , maxNorthing] = grid.metadata.bboxBng;
  const x = Math.floor((easting - minEasting) / grid.metadata.resolutionMetres);
  const y = Math.floor((maxNorthing - northing) / grid.metadata.resolutionMetres);
  grid.validity ??= new Uint8Array(grid.heights.length).fill(255);
  grid.validity[y * grid.metadata.width + x] = value;
}

function route(overrides = {}) {
  return {
    id: "test-route",
    coordinates: [
      [-0.12002, 51.505],
      [-0.11998, 51.505],
    ],
    distanceMetres: 3,
    durationSeconds: 600,
    directions: [],
    ...overrides,
  };
}

test("production ray tracing finds an obstacle towards the sun, not behind the observer", () => {
  const solar = SunCalc.getPosition(SUMMER_NOON, LONDON[1], LONDON[0]);
  const azimuth = (solar.azimuth * Math.PI) / 180;
  const eastDirection = Math.sin(azimuth);
  const northDirection = Math.cos(azimuth);
  const [easting, northing] = longitudeLatitudeToBng(LONDON);

  const sunwardGrid = makeGrid();
  setHeight(
    sunwardGrid,
    easting + eastDirection * 10,
    northing + northDirection * 10,
    80,
  );
  const sunward = assessPointExposure(LONDON, SUMMER_NOON, sunwardGrid);
  assert.equal(sunward.exposure, "shade");
  assert.equal(sunward.shadeFraction, 1);
  assert.equal(sunward.rayCoverage, "complete");

  const behindGrid = makeGrid();
  setHeight(
    behindGrid,
    easting - eastDirection * 10,
    northing - northDirection * 10,
    80,
  );
  const behind = assessPointExposure(LONDON, SUMMER_NOON, behindGrid);
  assert.equal(behind.exposure, "sun");
  assert.equal(behind.shadeFraction, 0);
});

test("night journeys require no height ray and report no direct sun", () => {
  const score = scoreRouteAgainstGrid(
    route(),
    makeGrid(),
    new Date("2026-06-21T00:00:00.000Z"),
  );
  assert.equal(score.isDaylight, false);
  assert.equal(score.estimatedDirectSunSeconds, 0);
  assert.deepEqual(score.directSunRangeSeconds, [0, 0]);
  assert.equal(score.estimatedShadePercent, null);
  assert.equal(score.coveragePercent, 100);
  assert.equal(score.limitedConfidence, false);
  assert.ok(score.sections.every((section) => section.exposure === "night"));
  assert.ok(score.sections.every((section) => section.rayCoverage === "not-required"));
});

test("a ray leaving the height grid is explicitly unknown and cannot improve ranking", () => {
  const smallGrid = makeGrid(16);
  const assessment = assessPointExposure(LONDON, SUMMER_NOON, smallGrid);
  assert.equal(assessment.exposure, "unknown");
  assert.equal(assessment.shadeFraction, null);
  assert.equal(assessment.rayCoverage, "incomplete");
  assert.ok(assessment.confidenceReasons.includes("incomplete-height-coverage"));

  const outsideCoverage = assessPointExposure([-0.13, 51.505], SUMMER_NOON, smallGrid);
  assert.equal(outsideCoverage.exposure, "unknown");
  assert.equal(outsideCoverage.rayCoverage, "incomplete");

  const score = scoreRouteAgainstGrid(route(), smallGrid, SUMMER_NOON);
  assert.equal(score.coveragePercent, 0);
  assert.equal(score.limitedConfidence, true);
  assert.ok(score.unknownDaylightSeconds > 599);
  closeTo(score.estimatedDirectSunSeconds, 600, 0.001);
  closeTo(score.directSunRangeSeconds[0], 0, 0.001);
  closeTo(score.directSunRangeSeconds[1], 600, 0.001);
});

test("partially covered source cells remain unknown instead of becoming zero-height ground", () => {
  const grid = makeGrid();
  const [easting, northing] = longitudeLatitudeToBng(LONDON);
  setValidity(grid, easting, northing, 254);
  const assessment = assessPointExposure(LONDON, SUMMER_NOON, grid);
  assert.equal(assessment.exposure, "unknown");
  assert.equal(assessment.rayCoverage, "incomplete");
  assert.ok(assessment.confidenceReasons.includes("incomplete-height-coverage"));
});

test("directions mapped to underground or stair segments are marked unknown", () => {
  const passageRoute = route({
    directions: [
      {
        instruction: "Take the stairs to Level -2",
        distanceMetres: 3,
        durationSeconds: 600,
        beginIndex: 0,
        endIndex: 1,
      },
    ],
  });
  const score = scoreRouteAgainstGrid(passageRoute, makeGrid(), SUMMER_NOON);
  assert.ok(score.sections.every((section) => section.exposure === "unknown"));
  assert.ok(score.confidenceReasons.includes("unmodelled-passage"));
  assert.equal(score.coveragePercent, 0);
});

function rasterScore(overrides) {
  return {
    routeId: "journey",
    distanceMetres: 100,
    durationSeconds: 600,
    estimatedDirectSunSeconds: 0,
    directSunRangeSeconds: [0, 0],
    estimatedShadePercent: 100,
    daylightSeconds: 600,
    modelledDaylightSeconds: 600,
    unknownDaylightSeconds: 0,
    isDaylight: true,
    lowSunConfidence: false,
    limitedConfidence: false,
    confidenceReasons: [],
    coveragePercent: 100,
    sections: [],
    ...overrides,
  };
}

test("repeated journeys weight shade by daylight duration", () => {
  const partlyDaylight = rasterScore({
    estimatedDirectSunSeconds: 60,
    directSunRangeSeconds: [60, 60],
    estimatedShadePercent: 0,
    daylightSeconds: 60,
    modelledDaylightSeconds: 60,
  });
  const fullyShaded = rasterScore({ estimatedShadePercent: 100 });
  const aggregate = aggregateScheduleScores(route({ distanceMetres: 100 }), [
    partlyDaylight,
    fullyShaded,
  ]);
  closeTo(aggregate.estimatedShadePercent, (600 / 660) * 100, 1e-9);
  assert.equal(aggregate.daylightSeconds, 660);
  assert.equal(aggregate.estimatedDirectSunSeconds, 60);
  assert.equal(aggregate.journeyCount, 2);
});

function scheduleScore(id, durationSeconds, estimatedDirectSunSeconds, range = [0, estimatedDirectSunSeconds]) {
  return {
    ...rasterScore({
      routeId: id,
      distanceMetres: durationSeconds,
      durationSeconds,
      estimatedDirectSunSeconds,
      directSunRangeSeconds: range,
    }),
    journeyCount: 1,
  };
}

test("least-sun follows the displayed estimate and recommendation explains its detour guard", () => {
  const labelled = labelRouteScores(
    [
      scheduleScore("fast", 600, 120, [0, 120]),
      scheduleScore("balanced", 700, 50, [0, 500]),
      scheduleScore("slow-lowest", 900, 10, [0, 10]),
    ],
    "vulnerable",
  );
  const byId = Object.fromEntries(labelled.map((score) => [score.routeId, score]));
  assert.deepEqual(byId.fast.labels, ["fastest"]);
  assert.ok(byId.balanced.labels.includes("recommended"));
  assert.ok(byId["slow-lowest"].labels.includes("least-sun"));
  assert.match(byId.balanced.recommendationReason, /displayed direct sun.+extra per journey.+detour limit/i);
});

test("datetime-local values are interpreted in Europe/London for GMT and BST", () => {
  assert.equal(
    parseLondonDateTime("2026-01-15T13:00")?.toISOString(),
    "2026-01-15T13:00:00.000Z",
  );
  assert.equal(
    parseLondonDateTime("2026-07-15T13:00")?.toISOString(),
    "2026-07-15T12:00:00.000Z",
  );
  assert.match(formatLondonDateTime("2026-01-15T13:00"), /13:00 GMT$/);
  assert.match(formatLondonDateTime("2026-07-15T13:00"), /13:00 BST$/);
  assert.equal(parseLondonDateTime("2026-03-29T01:30"), null);
  assert.equal(
    parseLondonDateTime("2026-10-25T01:30")?.toISOString(),
    "2026-10-25T00:30:00.000Z",
  );
});

test("London-local initial and quick-hour values do not depend on the device zone", () => {
  assert.equal(
    initialLondonDateTimeValue(new Date("2026-07-15T06:20:00.000Z")),
    "2026-07-15T07:30",
  );
  assert.equal(
    initialLondonDateTimeValue(new Date("2026-01-15T22:00:00.000Z")),
    "2026-01-15T14:30",
  );
  assert.equal(setLondonLocalHour("2026-07-15T13:45", 18), "2026-07-15T18:00");
  assert.equal(
    londonDateTimeValue(new Date("2026-07-15T12:47:00.000Z")),
    "2026-07-15T13:47",
  );
});
