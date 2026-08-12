import assert from "node:assert/strict";
import test from "node:test";

import {
  buildShadeProfile,
  dateTimeLocalAtMinutes,
  minutesFromDateTimeLocal,
  SHADE_PLAYER_END_MINUTES,
  SHADE_PLAYER_START_MINUTES,
} from "../lib/shade-profile.ts";
import { haversineMetres } from "../lib/routes.ts";

function section(startLongitude, endLongitude, exposure) {
  return {
    start: [startLongitude, 0],
    end: [endLongitude, 0],
    exposure,
    shadeFraction: exposure === "shade" ? 1 : exposure === "sun" ? 0 : null,
    daylight: exposure !== "night",
    lowSun: false,
    rayCoverage: exposure === "unknown" ? "incomplete" : "complete",
    confidenceReasons: [],
  };
}

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ± ${tolerance}, received ${actual}`,
  );
}

test("shade profile merges adjacent exposures and uses route distance ranges", () => {
  const oneSectionMetres = haversineMetres([0, 0], [0.001, 0]);
  const profile = buildShadeProfile(
    [
      section(0, 0.001, "shade"),
      section(0.001, 0.002, "shade"),
      section(0.002, 0.003, "sun"),
      section(0.003, 0.004, "not-modelled"),
      section(0.004, 0.005, "unknown"),
    ],
    oneSectionMetres * 5,
  );

  assert.deepEqual(
    profile.segments.map((segment) => segment.exposure),
    ["shade", "sun", "unknown"],
  );
  closeTo(profile.segments[0].distanceMetres, oneSectionMetres * 2);
  closeTo(profile.segments[0].startDistanceMetres, 0);
  closeTo(profile.segments[0].endDistanceMetres, oneSectionMetres * 2);
  closeTo(profile.segments[0].percent, 40);
  assert.deepEqual(profile.segments[0].start, [0, 0]);
  assert.deepEqual(profile.segments[0].end, [0.002, 0]);

  closeTo(profile.segments[1].startDistanceMetres, oneSectionMetres * 2);
  closeTo(profile.segments[1].endDistanceMetres, oneSectionMetres * 3);
  closeTo(profile.segments[1].percent, 20);
  closeTo(profile.segments[2].startDistanceMetres, oneSectionMetres * 3);
  closeTo(profile.segments[2].endDistanceMetres, oneSectionMetres * 5);
  closeTo(profile.segments[2].percent, 40);

  closeTo(profile.totals.shade.distanceMetres, oneSectionMetres * 2);
  closeTo(profile.totals.shade.percent, 40);
  closeTo(profile.totals.sun.distanceMetres, oneSectionMetres);
  closeTo(profile.totals.sun.percent, 20);
  closeTo(profile.totals.unknown.distanceMetres, oneSectionMetres * 2);
  closeTo(profile.totals.unknown.percent, 40);
  assert.deepEqual(profile.totals.uncertain, { distanceMetres: 0, percent: 0 });
  assert.deepEqual(profile.totals.night, { distanceMetres: 0, percent: 0 });
});

test("shade profile derives percentages from geometry when no route total is supplied", () => {
  const profile = buildShadeProfile([
    section(0, 0.001, "night"),
    section(0.001, 0.004, "uncertain"),
  ]);

  closeTo(profile.totals.night.percent, 25, 1e-7);
  closeTo(profile.totals.uncertain.percent, 75, 1e-7);
  closeTo(
    profile.segments.reduce((sum, segment) => sum + segment.percent, 0),
    100,
    1e-7,
  );
  assert.deepEqual(buildShadeProfile([]), {
    segments: [],
    totals: {
      sun: { distanceMetres: 0, percent: 0 },
      shade: { distanceMetres: 0, percent: 0 },
      uncertain: { distanceMetres: 0, percent: 0 },
      unknown: { distanceMetres: 0, percent: 0 },
      night: { distanceMetres: 0, percent: 0 },
    },
  });
});

test("datetime-local player helpers preserve the London civil date and clamp time", () => {
  assert.equal(SHADE_PLAYER_START_MINUTES, 0);
  assert.equal(SHADE_PLAYER_END_MINUTES, 1425);
  assert.equal(minutesFromDateTimeLocal("2026-07-15T13:45"), 825);
  assert.equal(minutesFromDateTimeLocal("2026-01-15T05:30"), 330);
  assert.equal(minutesFromDateTimeLocal("2026-01-15T23:15:30"), 1395);
  assert.equal(dateTimeLocalAtMinutes("2026-07-15", 825), "2026-07-15T13:45");
  assert.equal(dateTimeLocalAtMinutes("2026-03-29", -30), "2026-03-29T00:00");
  assert.equal(dateTimeLocalAtMinutes("2026-10-25", 1500), "2026-10-25T23:45");
});

test("shade profile marks distance missing from decoded geometry as unknown", () => {
  const measured = haversineMetres([0, 0], [0.001, 0]);
  const profile = buildShadeProfile([section(0, 0.001, "shade")], measured * 2);

  assert.deepEqual(
    profile.segments.map((segment) => segment.exposure),
    ["shade", "unknown"],
  );
  closeTo(profile.totals.shade.percent, 50);
  closeTo(profile.totals.unknown.percent, 50);
  closeTo(profile.segments.reduce((sum, segment) => sum + segment.percent, 0), 100);
});

test("datetime-local player helpers reject malformed dates and times", () => {
  assert.equal(minutesFromDateTimeLocal("2026-02-29T12:00"), null);
  assert.equal(minutesFromDateTimeLocal("2026-07-15T24:00"), null);
  assert.equal(minutesFromDateTimeLocal("not-a-date"), null);
  assert.throws(
    () => dateTimeLocalAtMinutes("2026-02-29", 720),
    /valid YYYY-MM-DD/,
  );
  assert.throws(() => dateTimeLocalAtMinutes("2026-07-15", Number.NaN), /finite/);
});
