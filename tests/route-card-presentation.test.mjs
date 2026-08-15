import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  compareRouteTimes,
  routeCardExtraTimeLabel,
  routeExtraWalkingLabel,
  routeLongerTimeLabel,
} from "../lib/route-card-presentation.ts";

test("rounded route totals and their comparison cannot contradict each other", () => {
  const fastestSeconds = 16 * 60 + 10;
  const alternativeSeconds = 16 * 60 + 30;
  assert.equal(Math.round(fastestSeconds / 60), 16);
  assert.equal(Math.round(alternativeSeconds / 60), 17);

  const comparison = compareRouteTimes(alternativeSeconds, fastestSeconds);
  assert.deepEqual(comparison, { kind: "minutes", displayedMinutes: 1 });
  assert.equal(routeCardExtraTimeLabel(comparison), "+1 min vs fastest");
  assert.equal(routeLongerTimeLabel(comparison), "1 min longer per journey");
  assert.equal(routeExtraWalkingLabel(comparison), "1 min extra walking");
});

test("a real sub-minute difference is visible even when both totals round alike", () => {
  const comparison = compareRouteTimes(16 * 60 + 20, 16 * 60);
  assert.deepEqual(comparison, { kind: "under-minute", displayedMinutes: 0 });
  assert.equal(routeCardExtraTimeLabel(comparison), "Under 1 min vs fastest");
  assert.equal(routeLongerTimeLabel(comparison), "Under 1 min longer per journey");
  assert.equal(routeExtraWalkingLabel(comparison), "Under 1 min extra walking");
});

test("equal durations retain the no-extra-time wording", () => {
  const comparison = compareRouteTimes(960, 960);
  assert.deepEqual(comparison, { kind: "same", displayedMinutes: 0 });
  assert.equal(routeCardExtraTimeLabel(comparison), "No extra time");
});

test("route cards use the shared time comparison and sensitivity guard", async () => {
  const source = await readFile(
    new URL("../components/ShadeRouteApp.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /routeCardExtraTimeLabel\(timeComparison\)/);
  assert.match(source, /sensitivitySupportsLowerSun\(fastestSuitable, score\)/);
  assert.match(
    source,
    /sensitivityEstablishesLowestSun\(candidate, supportedAlternatives\)/,
  );
  assert.match(source, /Alternative · ranges overlap/);
  assert.match(source, /lower point estimate, but sensitivity ranges overlap/);
  assert.doesNotMatch(source, /extraMinutes > 0 \? `\+\$\{extraMinutes\} min vs fastest`/);
});
