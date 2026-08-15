import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildJourneyProgress,
  buildJourneySteps,
  exposureSpansForJourney,
  locatePositionOnJourney,
  upcomingExposureAtDistance,
} from "../lib/journey-mode.ts";

const route = {
  id: "pilot",
  coordinates: [
    [0, 0],
    [0.001, 0],
    [0.002, 0],
    [0.003, 0],
  ],
  distanceMetres: 300,
  durationSeconds: 240,
  directions: [
    {
      instruction: "Walk east.",
      distanceMetres: 100,
      durationSeconds: 80,
      beginIndex: 0,
      endIndex: 1,
    },
    {
      instruction: "Continue across the junction.",
      distanceMetres: 100,
      durationSeconds: 80,
      beginIndex: 1,
      endIndex: 2,
    },
    {
      instruction: "Continue to the destination.",
      distanceMetres: 100,
      durationSeconds: 80,
      beginIndex: 2,
      endIndex: 3,
    },
  ],
};

function rasterSection(start, end, exposure) {
  return {
    start,
    end,
    exposure,
    shadeFraction: exposure === "shade" ? 1 : exposure === "sun" ? 0 : null,
    daylight: exposure !== "night",
    lowSun: false,
    rayCoverage: exposure === "unknown" ? "incomplete" : "complete",
    confidenceReasons: [],
  };
}

test("journey steps map direction indices onto reported route distance and time", () => {
  const steps = buildJourneySteps(route);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].startDistanceMetres, 0);
  assert.ok(Math.abs(steps[1].startDistanceMetres - 100) < 0.01);
  assert.ok(Math.abs(steps[2].endDistanceMetres - 300) < 0.01);
  assert.equal(steps[1].startOffsetSeconds, 80);
  assert.equal(steps[2].endOffsetSeconds, 240);
});

test("journey progress exposes the current and next instruction with remaining totals", () => {
  const departure = new Date("2026-08-12T12:00:00Z");
  const summary = buildJourneyProgress(route, null, 1, departure);
  assert.equal(summary.current.instruction, "Continue across the junction.");
  assert.equal(summary.next.instruction, "Continue to the destination.");
  assert.ok(Math.abs(summary.remainingDistanceMetres - 200) < 0.01);
  assert.equal(summary.remainingDurationSeconds, 160);
  assert.equal(summary.complete, false);
  assert.equal(summary.estimatedStepTime.toISOString(), "2026-08-12T12:01:20.000Z");
  assert.equal(summary.upcomingExposure.exposure, "unknown");
  assert.match(summary.upcomingExposure.description, /data is unavailable/i);
});

test("raster exposure becomes a plain-language, distance-based look ahead", () => {
  const score = {
    distanceMetres: 300,
    sections: [
      rasterSection([0, 0], [0.001, 0], "sun"),
      rasterSection([0.001, 0], [0.002, 0], "shade"),
      rasterSection([0.002, 0], [0.003, 0], "unknown"),
    ],
  };
  const spans = exposureSpansForJourney(score, 300);
  const upcoming = upcomingExposureAtDistance(spans, 20, 300);
  assert.equal(upcoming.exposure, "sun");
  assert.equal(upcoming.nextExposure, "shade");
  assert.ok(Math.abs(spans[0].endDistanceMetres - 100) < 0.01);
  assert.match(upcoming.description, /direct sun under clear skies/i);
  assert.match(upcoming.description, /then estimated shade/i);
});

test("geometric score segments are accepted and mixed exposure remains uncertain", () => {
  const score = {
    distanceM: 300,
    segments: [
      { startDistanceM: 0, endDistanceM: 120, exposure: "shade" },
      { startDistanceM: 120, endDistanceM: 200, exposure: "mixed" },
      { startDistanceM: 200, endDistanceM: 300, exposure: "sun" },
    ],
  };
  const spans = exposureSpansForJourney(score, 300);
  assert.deepEqual(
    spans.map((span) => span.exposure),
    ["shade", "uncertain", "sun"],
  );
});

test("optional position suggests progress without changing it", () => {
  const estimate = locatePositionOnJourney(route, [0.0021, 0.00005]);
  assert.ok(estimate);
  assert.ok(estimate.distanceFromRouteMetres < 10);
  assert.equal(estimate.suggestedDirectionIndex, 2);
  assert.ok(estimate.distanceAlongRouteMetres > 200);
});

test("a position on a direction boundary suggests the next half-open step", () => {
  const estimate = locatePositionOnJourney(route, [0.001, 0]);
  assert.ok(estimate);
  assert.equal(estimate.suggestedDirectionIndex, 1);
});

test("the final arrival has no remaining exposure to describe", () => {
  const arrivalRoute = {
    ...route,
    directions: [
      ...route.directions,
      {
        instruction: "You have arrived at your destination.",
        distanceMetres: 0,
        durationSeconds: 0,
        beginIndex: 3,
        endIndex: 3,
      },
    ],
  };
  const summary = buildJourneyProgress(
    arrivalRoute,
    null,
    3,
    new Date("2026-08-12T12:00:00Z"),
  );
  assert.equal(summary.complete, true);
  assert.equal(summary.remainingDistanceMetres, 0);
  assert.equal(summary.remainingDurationSeconds, 0);
  assert.match(summary.upcomingExposure.description, /journey is complete/i);
});

test("a route without provider directions still has a usable manual step", () => {
  const steps = buildJourneySteps({ ...route, directions: [] });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].instruction, "Continue to the destination.");
  assert.equal(steps[0].endDistanceMetres, 300);
});

test("journey mode preserves the reference warning, focus and concise range semantics", async () => {
  const source = await readFile(
    new URL("../components/JourneyMode.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /Reference only — not emergency navigation/);
  assert.match(source, /Field route reference/);
  assert.match(source, /Walking steps and exposure ahead/);
  assert.match(source, /Exit field reference/);
  assert.doesNotMatch(source, /Walk this route/);
  assert.match(source, /aria-describedby="journey-mode-warning"/);
  assert.match(source, /role="status" aria-atomic="true"/);
  assert.match(source, /aria-describedby="journey-mode-progress-help"/);
  assert.match(source, /onRequestLocation\?: \(\) => void/);
  assert.match(source, /Check my position/);
  assert.match(source, /never changes route progress automatically/);
  assert.match(source, /journey-mode-location-status" role="status" aria-atomic="true"/);
  assert.match(source, /sectionRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /opener\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /height: 44px/);
});
