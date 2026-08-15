import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ROUTE_WALK_VALIDATION_COLUMNS,
  ROUTE_WALK_VALIDATION_MAX_BYTES,
  ROUTE_WALK_VALIDATION_SCHEMA,
  analyseRouteWalkValidation,
  analyseRouteWalkValidationCsv,
  parseRouteWalkValidationCsv,
  routeWalkValidationTemplateCsv,
} from "../lib/route-walk-validation.ts";

const header = ROUTE_WALK_VALIDATION_COLUMNS.join(",");

function record(overrides = {}) {
  return {
    schema: ROUTE_WALK_VALIDATION_SCHEMA,
    schema_version: "1",
    comparison_id: "waterloo-afternoon-one",
    pilot_area: "waterloo",
    comparison_london_datetime: "2026-08-15T14:30",
    model_version: "clear-sky-raster-v1",
    route_id: "waterloo-route-a",
    walk_complete: "true",
    prediction_frozen_before_walk: "true",
    weather_visibility: "clear-direct-sun",
    predicted_duration_minutes: "20",
    predicted_direct_sun_minutes: "5",
    predicted_shade_minutes: "15",
    predicted_unknown_minutes: "0",
    observed_duration_minutes: "20",
    observed_direct_sun_minutes: "5",
    observed_shade_minutes: "15",
    observed_unknown_minutes: "0",
    predicted_order: "1",
    observed_order: "1",
    ...overrides,
  };
}

function line(value) {
  return ROUTE_WALK_VALIDATION_COLUMNS.map((column) => value[column]).join(",");
}

function csv(rows) {
  return `${header}\n${rows.map(line).join("\n")}${rows.length ? "\n" : ""}`;
}

const firstComparison = [
  record({
    route_id: "waterloo-route-a",
    predicted_direct_sun_minutes: "5",
    predicted_shade_minutes: "15",
    observed_direct_sun_minutes: "7",
    observed_shade_minutes: "13",
    predicted_order: "1",
    observed_order: "2",
  }),
  record({
    route_id: "waterloo-route-b",
    predicted_direct_sun_minutes: "8",
    predicted_shade_minutes: "12",
    observed_direct_sun_minutes: "6",
    observed_shade_minutes: "14",
    predicted_order: "2",
    observed_order: "1",
  }),
  record({
    route_id: "waterloo-route-c",
    predicted_direct_sun_minutes: "12",
    predicted_shade_minutes: "8",
    observed_direct_sun_minutes: "13",
    observed_shade_minutes: "7",
    predicted_order: "3",
    observed_order: "3",
  }),
];

const secondComparison = [
  record({
    comparison_id: "kings-cross-noon-one",
    pilot_area: "kings-cross",
    comparison_london_datetime: "2026-08-16T12:00",
    route_id: "kings-cross-route-a",
    predicted_direct_sun_minutes: "4",
    predicted_shade_minutes: "14",
    predicted_unknown_minutes: "2",
    observed_direct_sun_minutes: "5",
    observed_shade_minutes: "15",
    predicted_order: "1",
    observed_order: "1",
  }),
  record({
    comparison_id: "kings-cross-noon-one",
    pilot_area: "kings-cross",
    comparison_london_datetime: "2026-08-16T12:00",
    route_id: "kings-cross-route-b",
    predicted_direct_sun_minutes: "8",
    predicted_shade_minutes: "12",
    observed_direct_sun_minutes: "7",
    observed_shade_minutes: "13",
    predicted_order: "2",
    observed_order: "2",
  }),
];

const unknownComparison = [
  record({
    comparison_id: "waterloo-late-one",
    comparison_london_datetime: "2026-08-17T17:00",
    route_id: "waterloo-route-a",
    predicted_direct_sun_minutes: "3",
    predicted_shade_minutes: "15",
    predicted_unknown_minutes: "2",
    observed_direct_sun_minutes: "4",
    observed_shade_minutes: "14",
    observed_unknown_minutes: "2",
    predicted_order: "1",
    observed_order: "unknown",
  }),
  record({
    comparison_id: "waterloo-late-one",
    comparison_london_datetime: "2026-08-17T17:00",
    route_id: "waterloo-route-b",
    predicted_direct_sun_minutes: "5",
    predicted_shade_minutes: "15",
    observed_direct_sun_minutes: "4",
    observed_shade_minutes: "15",
    observed_unknown_minutes: "1",
    predicted_order: "2",
    observed_order: "unknown",
  }),
];

test("aggregates complete walks, coverage, route-order agreement and regret", () => {
  const result = analyseRouteWalkValidationCsv(csv([
    ...firstComparison,
    ...secondComparison,
    ...unknownComparison,
  ]));

  assert.equal(result.status, "analysed");
  assert.ok(result.analysis);
  assert.equal(result.analysis.completeWalkCount, 7);
  assert.equal(result.analysis.comparableWalkCount, 5);
  assert.equal(result.analysis.directSunMinutesMae, 1.4);
  assert.equal(result.analysis.predictedCoveragePercent, 97.143);
  assert.equal(result.analysis.predictedUnknownRatePercent, 2.857);
  assert.equal(result.analysis.observedCoveragePercent, 97.857);
  assert.equal(result.analysis.observedUnknownRatePercent, 2.143);
  assert.equal(result.analysis.comparisonCount, 3);
  assert.equal(result.analysis.orderComparableComparisonCount, 2);
  assert.equal(result.analysis.fullRouteOrderAgreementCount, 1);
  assert.equal(result.analysis.fullRouteOrderAgreementRatePercent, 50);
  assert.equal(result.analysis.meanRegretMinutes, 0.5);

  const disagreed = result.analysis.comparisons.find(
    (comparison) => comparison.comparisonId === "waterloo-afternoon-one",
  );
  assert.equal(disagreed.predictedBestRouteId, "waterloo-route-a");
  assert.equal(disagreed.observedBestRouteId, "waterloo-route-b");
  assert.equal(disagreed.fullRouteOrderAgreement, false);
  assert.equal(disagreed.regretMinutes, 1);

  const incompleteObservation = result.analysis.comparisons.find(
    (comparison) => comparison.comparisonId === "waterloo-late-one",
  );
  assert.equal(incompleteObservation.observedBestRouteId, null);
  assert.equal(incompleteObservation.fullRouteOrderAgreement, null);
  assert.equal(incompleteObservation.regretMinutes, null);
  assert.equal(
    incompleteObservation.routes.every((route) => route.absoluteDirectSunErrorMinutes === null),
    true,
  );
});

test("rejects malformed or contradictory CSV without throwing", () => {
  const twoRows = [firstComparison[0], firstComparison[1]];
  const invalidInputs = [
    null,
    undefined,
    "",
    "not,csv",
    `${header},unexpected\n`,
    csv(twoRows).replace(",1,waterloo-afternoon", ",2,waterloo-afternoon"),
    csv(twoRows).replace(",20,5,15,0,20,", ",20,5,14,0,20,"),
    csv(twoRows).replace(",true,true,clear-direct-sun,", ",false,true,clear-direct-sun,"),
    csv(twoRows).replace(",true,true,clear-direct-sun,", ",true,false,clear-direct-sun,"),
    csv(twoRows).replace("clear-direct-sun", "overcast"),
    csv(twoRows).replace("2026-08-15T14:30", "2026-03-29T01:30"),
    csv([firstComparison[0]]),
    csv([firstComparison[0], { ...firstComparison[1], route_id: "waterloo-route-a" }]),
    csv([firstComparison[0], { ...firstComparison[1], predicted_order: "1" }]),
    csv([
      { ...firstComparison[0], predicted_order: "2" },
      { ...firstComparison[1], predicted_order: "1" },
    ]),
    csv([
      { ...unknownComparison[0], observed_order: "1" },
      { ...unknownComparison[1], observed_order: "2" },
    ]),
    csv([
      firstComparison[0],
      { ...firstComparison[1], pilot_area: "kings-cross" },
    ]),
    csv([...firstComparison, record({
      route_id: "waterloo-route-d",
      predicted_direct_sun_minutes: "14",
      predicted_shade_minutes: "6",
      observed_direct_sun_minutes: "14",
      observed_shade_minutes: "6",
      predicted_order: "1",
      observed_order: "1",
    })]),
    `${header}\n\n`,
    csv(twoRows).replace(",20,5,", ",20,.5,"),
    csv(twoRows).replace("waterloo-route-a", '"waterloo-route-a"'),
    "x".repeat(ROUTE_WALK_VALIDATION_MAX_BYTES + 1),
  ];

  for (const input of invalidInputs) {
    assert.doesNotThrow(() => parseRouteWalkValidationCsv(input));
    assert.equal(parseRouteWalkValidationCsv(input), null);
    assert.deepEqual(analyseRouteWalkValidationCsv(input), {
      status: "invalid",
      rows: null,
      analysis: null,
    });
  }

  const hostile = {};
  Object.defineProperty(hostile, "toString", {
    get() {
      throw new Error("hostile getter");
    },
  });
  assert.doesNotThrow(() => analyseRouteWalkValidation(hostile));
  assert.equal(analyseRouteWalkValidation(hostile), null);
});

test("groups deterministically by comparison id, pilot and London comparison time", () => {
  const rows = [...firstComparison, ...secondComparison];
  const forward = analyseRouteWalkValidationCsv(csv(rows));
  const reversed = analyseRouteWalkValidationCsv(csv([...rows].reverse()));
  assert.equal(forward.status, "analysed");
  assert.equal(reversed.status, "analysed");
  assert.deepEqual(forward.analysis, reversed.analysis);
  assert.deepEqual(
    forward.analysis.comparisons.map((comparison) => [
      comparison.comparisonId,
      comparison.pilotArea,
      comparison.comparisonLondonDateTime,
    ]),
    [
      ["kings-cross-noon-one", "kings-cross", "2026-08-16T12:00"],
      ["waterloo-afternoon-one", "waterloo", "2026-08-15T14:30"],
    ],
  );
});

test("accepts the committed header-only template as an explicit empty state", async () => {
  const template = await readFile(
    new URL("../validation/route-walks.csv", import.meta.url),
    "utf8",
  );
  assert.equal(template, `${header}\n`);
  assert.equal(routeWalkValidationTemplateCsv(), template);
  assert.deepEqual(parseRouteWalkValidationCsv(template), []);

  const result = analyseRouteWalkValidationCsv(template);
  assert.equal(result.status, "empty");
  assert.equal(result.analysis.status, "empty");
  assert.equal(result.analysis.completeWalkCount, 0);
  assert.equal(result.analysis.directSunMinutesMae, null);
  assert.equal(result.analysis.fullRouteOrderAgreementRatePercent, null);
  assert.deepEqual(result.analysis.comparisons, []);
});

test("schema excludes participant identifiers, exact points and route geometry", () => {
  const schema = ROUTE_WALK_VALIDATION_COLUMNS.join(" ");
  assert.doesNotMatch(schema, /participant|observer|name|email|device|account/i);
  assert.doesNotMatch(schema, /latitude|longitude|coordinate|geometry|polyline|point/i);
  assert.match(schema, /model_version/);
  assert.match(schema, /route_id/);
  assert.match(schema, /comparison_london_datetime/);
});

test("the browser analyser keeps route-walk files local and explains non-evidence states", async () => {
  const source = await readFile(
    new URL("../components/CalibrationObserverRouteWalks.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /analyseRouteWalkValidationCsv/);
  assert.match(source, /ROUTE_WALK_VALIDATION_MAX_BYTES/);
  assert.match(source, /does not create field evidence/i);
  assert.match(source, /header-only or synthetic sheet remains no\s+evidence/i);
  assert.match(source, /without sending the file to a server/i);
  assert.match(source, /No values were repaired or inferred/i);
  assert.match(source, /role=\{state\.kind === "invalid" \? "alert" : "status"\}/);
  assert.doesNotMatch(source, /fetch\s*\(/);

  const styles = await readFile(
    new URL("../components/CalibrationObserverRouteWalks.module.css", import.meta.url),
    "utf8",
  );
  assert.match(styles, /min-height:\s*44px/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});
