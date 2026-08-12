import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as SunCalc from "suncalc";

import { buildDepartureAdvice } from "../lib/departure-advice.ts";
import { longitudeLatitudeToBng } from "../lib/raster-shade.ts";

const LONDON = /** @type {[number, number]} */ ([-0.12, 51.505]);

function makeGrid(halfSizeMetres = 300, resolutionMetres = 2) {
  const [centreEasting, centreNorthing] = longitudeLatitudeToBng(LONDON);
  const width = Math.ceil((halfSizeMetres * 2) / resolutionMetres);
  const height = width;
  return {
    metadata: {
      id: "departure-test",
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

function walkingRoute(overrides = {}) {
  return {
    id: "direct",
    coordinates: [
      [-0.12001, 51.505],
      [-0.11999, 51.505],
    ],
    distanceMetres: 2,
    durationSeconds: 600,
    directions: [],
    ...overrides,
  };
}

function addSunwardScreen(grid, date, coordinate = LONDON) {
  const solar = SunCalc.getPosition(date, coordinate[1], coordinate[0]);
  const azimuth = (solar.azimuth * Math.PI) / 180;
  const east = Math.sin(azimuth);
  const north = Math.cos(azimuth);
  const acrossEast = Math.cos(azimuth);
  const acrossNorth = -Math.sin(azimuth);
  const [centreEasting, centreNorthing] = longitudeLatitudeToBng(coordinate);

  for (let distance = 12; distance <= 28; distance += 2) {
    for (let across = -4; across <= 4; across += 2) {
      setHeight(
        grid,
        centreEasting + east * distance + acrossEast * across,
        centreNorthing + north * distance + acrossNorth * across,
        80,
      );
    }
  }
}

test("the default scan evaluates the current time and eight 15-minute alternatives", () => {
  const departure = new Date("2026-06-21T08:00:00.000Z");
  const grid = makeGrid();
  const shelteredCoordinate = /** @type {[number, number]} */ ([-0.12, 51.5054]);
  addSunwardScreen(
    grid,
    new Date(departure.getTime() + 120 * 60_000),
    shelteredCoordinate,
  );
  const shelteredRoute = walkingRoute({
    id: "sheltered",
    coordinates: [
      [-0.12001, shelteredCoordinate[1]],
      [-0.11999, shelteredCoordinate[1]],
    ],
    distanceMetres: 3,
    durationSeconds: 700,
  });

  const advice = buildDepartureAdvice({
    routes: [walkingRoute(), shelteredRoute],
    grid,
    departure,
    profile: "vulnerable",
    journeyCount: 1,
    repeatEveryMinutes: 120,
  });

  assert.equal(advice.scannedDepartureCount, 9);
  assert.equal(advice.windowMinutes, 120);
  assert.equal(advice.stepMinutes, 15);
  assert.equal(advice.currentOption?.departureDate.toISOString(), departure.toISOString());
  assert.equal(advice.recommended, true);
  assert.equal(advice.confidence, "moderate");
  assert.equal(advice.withheldReason, null);
  assert.equal(advice.currentOption?.routeId, "direct");
  assert.equal(advice.selectedRoute?.id, "sheltered");
  assert.ok(advice.departureDate.getTime() > departure.getTime());
  assert.ok(advice.sunSecondsSaved >= 60);
  assert.equal(advice.extraWalkingSeconds, 100);
  assert.equal(advice.directSunSecondsPerJourney, advice.bestOption.directSunSecondsPerJourney);
  assert.deepEqual(
    advice.directSunRangeSecondsPerJourney,
    advice.bestOption.directSunRangeSecondsPerJourney,
  );
  assert.equal(advice.modelCoveragePercent, 100);
});

test("an open route with no meaningful improvement gets neutral advice", () => {
  const advice = buildDepartureAdvice({
    routes: [walkingRoute()],
    grid: makeGrid(),
    departure: new Date("2026-06-21T11:00:00.000Z"),
    profile: "worker",
    journeyCount: 2,
    repeatEveryMinutes: 60,
    windowMinutes: 30,
  });

  assert.equal(advice.scannedDepartureCount, 3);
  assert.equal(advice.recommended, false);
  assert.equal(advice.withheldReason, "insufficient-saving");
  assert.equal(advice.sunSecondsSaved, 0);
  assert.equal(advice.currentOption?.score.estimatedDirectSunSeconds, 1_200);
  assert.equal(advice.currentOption?.directSunSecondsPerJourney, 600);
});

test("departure advice uses the selected pace for travel and exposure timing", () => {
  const departure = new Date("2026-06-21T11:00:00.000Z");
  const advice = buildDepartureAdvice({
    routes: [walkingRoute()],
    grid: makeGrid(),
    departure,
    profile: "vulnerable",
    journeyCount: 1,
    repeatEveryMinutes: 60,
    walkingPace: "slow",
    windowMinutes: 0,
  });

  assert.equal(advice.currentOption?.walkingSecondsPerJourney, 900);
  assert.equal(advice.currentOption?.directSunSecondsPerJourney, 900);
  assert.equal(advice.currentOption?.score.walkingPace, "slow");
  assert.equal(advice.currentOption?.score.journeys[0].departureEpochMs, departure.getTime());
  assert.equal(
    advice.currentOption?.score.journeys[0].arrivalEpochMs,
    departure.getTime() + 900_000,
  );
});

test("advice is withheld outside daylight and when model coverage is too low", () => {
  const atNight = buildDepartureAdvice({
    routes: [walkingRoute()],
    grid: makeGrid(),
    departure: new Date("2026-06-21T00:00:00.000Z"),
    profile: "vulnerable",
    journeyCount: 1,
    repeatEveryMinutes: 60,
    windowMinutes: 30,
  });
  assert.equal(atNight.recommended, false);
  assert.equal(atNight.withheldReason, "no-daylight");

  const lowCoverage = buildDepartureAdvice({
    routes: [walkingRoute()],
    grid: makeGrid(14),
    departure: new Date("2026-06-21T11:00:00.000Z"),
    profile: "vulnerable",
    journeyCount: 1,
    repeatEveryMinutes: 60,
    windowMinutes: 30,
  });
  assert.equal(lowCoverage.recommended, false);
  assert.equal(lowCoverage.withheldReason, "low-model-coverage");
  assert.equal(lowCoverage.modelCoveragePercent, 0);
});

test("a daylight journey is never improved by merely waiting until night", () => {
  const advice = buildDepartureAdvice({
    routes: [walkingRoute()],
    grid: makeGrid(),
    departure: new Date("2026-08-12T17:30:00.000Z"),
    profile: "vulnerable",
    journeyCount: 1,
    repeatEveryMinutes: 60,
  });

  assert.equal(advice.currentOption?.isDaylight, true);
  assert.equal(advice.bestOption?.isDaylight, true);
});

test("the empty state and scan configuration are deterministic", () => {
  const advice = buildDepartureAdvice({
    routes: [],
    grid: makeGrid(),
    departure: new Date("2026-06-21T11:00:00.000Z"),
    profile: "vulnerable",
    journeyCount: 1,
    repeatEveryMinutes: 60,
    windowMinutes: 45,
    stepMinutes: 10,
  });

  assert.equal(advice.withheldReason, "no-routes");
  assert.equal(advice.scannedDepartureCount, 0);
  assert.equal(advice.currentOption, null);
  assert.equal(advice.bestOption, null);
  assert.equal(advice.windowMinutes, 45);
  assert.equal(advice.stepMinutes, 10);
});

test("the compact component keeps model status and callback semantics explicit", async () => {
  const source = await readFile(
    new URL("../components/DepartureAdvice.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /Model estimate/);
  assert.match(source, /Nearby departure advice is temporarily unavailable/);
  assert.match(source, /Leave \$\{laterMinutes\} min later/);
  assert.doesNotMatch(source, /aria-live=/);
  assert.match(source, /onChoose\(new Date\(advice\.departureDate!\), advice\.selectedRoute!\.id\)/);
  assert.match(source, /model sensitivity ranges overlap/i);
});
