import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  baseDepartureFromShiftJourney,
  buildShiftTimeline,
  departureForShiftJourney,
} from "../lib/shift-timeline.ts";

function journey(index, directSun, exposure = "sun") {
  const departureEpochMs = Date.UTC(2026, 7, 12, 8 + index * 2);
  return {
    index,
    departureEpochMs,
    arrivalEpochMs: departureEpochMs + 600_000,
    score: {
      routeId: "route-1",
      distanceMetres: 1_000,
      durationSeconds: 600,
      estimatedDirectSunSeconds: directSun,
      directSunRangeSeconds: [Math.max(0, directSun - 60), directSun + 60],
      estimatedShadePercent: 50,
      daylightSeconds: 600,
      modelledDaylightSeconds: 540,
      unknownDaylightSeconds: 60,
      isDaylight: true,
      lowSunConfidence: false,
      limitedConfidence: index === 1,
      confidenceReasons: index === 1 ? ["near-clearance-threshold"] : [],
      coveragePercent: 90,
      sections: [
        { start: [-0.12, 51.5], end: [-0.1195, 51.5], routeSegmentIndex: 0, exposure, shadeFraction: exposure === "sun" ? 0 : 1, daylight: true, lowSun: false, rayCoverage: "complete", confidenceReasons: [] },
        { start: [-0.1195, 51.5], end: [-0.119, 51.5], routeSegmentIndex: 1, exposure, shadeFraction: exposure === "sun" ? 0 : 1, daylight: true, lowSun: false, rayCoverage: "complete", confidenceReasons: [] },
      ],
    },
  };
}

test("shift timeline retains each journey and identifies the highest exposure", () => {
  const journeys = [journey(0, 180), journey(1, 300), journey(2, 120, "shade")];
  const result = buildShiftTimeline({ journeys });

  assert.equal(result.length, 3);
  assert.equal(result[1].highestDirectSunInSchedule, true);
  assert.equal(result[0].highestDirectSunInSchedule, false);
  assert.ok(result[0].longestDefiniteSunRunMetres > 60);
  assert.equal(result[2].longestDefiniteSunRunMetres, 0);
  assert.deepEqual(result[1].directSunRangeSeconds, [240, 360]);
});

test("a selected shift journey keeps its offset while its score is refreshed", () => {
  const base = new Date("2026-08-12T07:00:00Z");
  const thirdJourney = departureForShiftJourney(base, 2, 120);
  assert.equal(thirdJourney.toISOString(), "2026-08-12T11:00:00.000Z");
  assert.equal(
    baseDepartureFromShiftJourney(thirdJourney, 2, 120).toISOString(),
    base.toISOString(),
  );
});

test("timeline component uses explicit, non-safety model language", async () => {
  const source = await readFile(new URL("../components/ShiftExposureTimeline.tsx", import.meta.url), "utf8");
  assert.match(source, /preview only; it does not change the planned schedule/i);
  assert.match(source, /Clear-sky geometric estimates only/);
  assert.match(source, /Unknown sections remain conservatively included/);
  assert.match(source, /potential direct sun in total/i);
  assert.match(source, /daylight coverage not applicable/i);
  assert.match(source, /departureDay === arrivalDay/);
  assert.match(source, /aria-pressed/);
});
