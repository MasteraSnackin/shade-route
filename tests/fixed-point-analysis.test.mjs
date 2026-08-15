import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CALIBRATION_SITE_TYPES,
  FIELD_CALIBRATION_COLUMNS,
  FIELD_CALIBRATION_DATA_PACK_FINGERPRINTS,
  FIELD_CALIBRATION_DATA_PACK_VERSION,
  FIELD_CALIBRATION_MODEL_VERSION,
  FIELD_CALIBRATION_PROTOCOL_VERSION,
  calibrationObservationsToCsv,
  createCalibrationObservation,
  freezeCalibrationPrediction,
} from "../lib/field-calibration.ts";
import {
  FIXED_POINT_THRESHOLD_SCHEMA,
  analyseFixedPointCalibration,
  analyseFixedPointCalibrationCsv,
  parseFixedPointThresholdPlan,
} from "../lib/fixed-point-analysis.ts";

const thresholdPlan = JSON.parse(await readFile(
  new URL("../validation/fixed-point-thresholds.json", import.meta.url),
  "utf8",
));

const pilotCoordinates = {
  waterloo: [51.501, -0.113],
  "kings-cross": [51.524, -0.128],
};
const timeBands = [
  ["morning", "09:00"],
  ["solar-noon", "12:30"],
  ["late-afternoon", "16:30"],
];

function observation(pilotArea, pointIndex, bandIndex, overrides = {}) {
  const [latitude, longitude] = pilotCoordinates[pilotArea];
  const siteType = CALIBRATION_SITE_TYPES[pointIndex];
  const [, time] = timeBands[bandIndex];
  const frozen = freezeCalibrationPrediction({
    pilotArea,
    plannedPointId: `${pilotArea}-point-${pointIndex + 1}`,
    siteType,
    latitude: latitude + pointIndex * 0.0001,
    longitude: longitude + pointIndex * 0.0001,
    pavementSide: "left",
    observedLondonDateTime: `2026-08-${String(15 + bandIndex).padStart(2, "0")}T${time}`,
    predictedState: "shade",
    locationAccuracyMetres: 8,
  }, "2026-08-15T08:00:00.000Z");
  return {
    ...createCalibrationObservation(frozen, {
      weatherVisibility: "clear-direct-sun",
      observedState: "shade",
      leafState: siteType === "tree-canopy" ? "leaf-on" : "not-applicable",
    }, `${pilotArea}-${pointIndex}-${bandIndex}`),
    ...overrides,
  };
}

function completeDataset() {
  return ["waterloo", "kings-cross"].flatMap((pilotArea) =>
    CALIBRATION_SITE_TYPES.flatMap((_, pointIndex) =>
      timeBands.map((__, bandIndex) => observation(pilotArea, pointIndex, bandIndex))
    )
  );
}

test("keeps the pre-specified threshold template bound to the release without claiming observations", async () => {
  assert.equal(thresholdPlan.schema, FIXED_POINT_THRESHOLD_SCHEMA);
  assert.equal(thresholdPlan.registration_status, "pre-specified-template-no-observations");
  assert.equal(thresholdPlan.protocol_version, FIELD_CALIBRATION_PROTOCOL_VERSION);
  assert.equal(thresholdPlan.model_version, FIELD_CALIBRATION_MODEL_VERSION);
  assert.equal(thresholdPlan.data_pack_version, FIELD_CALIBRATION_DATA_PACK_VERSION);
  assert.deepEqual(
    thresholdPlan.data_pack_fingerprints,
    FIELD_CALIBRATION_DATA_PACK_FINGERPRINTS,
  );
  assert.ok(parseFixedPointThresholdPlan(thresholdPlan));

  const committedCsv = await readFile(
    new URL("../validation/observations.csv", import.meta.url),
    "utf8",
  );
  assert.equal(committedCsv, `${FIELD_CALIBRATION_COLUMNS.join(",")}\n`);
  const result = analyseFixedPointCalibrationCsv(committedCsv, thresholdPlan);
  assert.equal(result.status, "empty");
  assert.equal(result.analysis.evidenceStatus, "no-observations");
  assert.equal(result.analysis.fixedPointGateMet, null);
  assert.equal(result.analysis.canClaimModelAccuracy, false);
  assert.equal(result.analysis.classificationAgreementPercent, null);
});

test("analyses a complete fixed-point dataset deterministically without making a safety claim", () => {
  const records = completeDataset();
  const forward = analyseFixedPointCalibration(records, thresholdPlan);
  const reversed = analyseFixedPointCalibration([...records].reverse(), thresholdPlan);

  assert.equal(forward.status, "analysed");
  assert.deepEqual(forward.analysis, reversed.analysis);
  assert.equal(forward.analysis.evidenceStatus, "fixed-point-thresholds-met");
  assert.equal(forward.analysis.fixedPointGateMet, true);
  assert.equal(forward.analysis.canClaimModelAccuracy, false);
  assert.equal(forward.analysis.totalObservationCount, 36);
  assert.equal(forward.analysis.eligibleObservationCount, 36);
  assert.equal(forward.analysis.classifiableObservationCount, 36);
  assert.equal(forward.analysis.classificationAgreementPercent, 100);
  assert.equal(forward.analysis.unclassifiedPredictionRatePercent, 0);
  assert.deepEqual(forward.analysis.failureCodes, []);
  for (const pilot of forward.analysis.pilots) {
    assert.equal(pilot.uniquePlannedPointCount, 6);
    assert.equal(pilot.completeRepeatedPointCount, 6);
    assert.equal(pilot.pointRepeatDistanceFailureCount, 0);
    assert.deepEqual(pilot.representedSiteTypes, [...CALIBRATION_SITE_TYPES].sort());
    assert.deepEqual(pilot.completeRepeatedSiteTypes, [...CALIBRATION_SITE_TYPES].sort());
    assert.deepEqual(pilot.observationsByTimeBand, {
      morning: 6,
      "solar-noon": 6,
      "late-afternoon": 6,
    });
  }
});

test("does not let one-off site-type rows satisfy the repeated diversity gate", () => {
  const records = ["waterloo", "kings-cross"].flatMap((pilotArea) => {
    const repeatedOpenStreetPoints = Array.from({ length: 6 }, (_, pointIndex) =>
      timeBands.map((__, bandIndex) => ({
        ...observation(pilotArea, pointIndex, bandIndex),
        site_type: "open-street",
      }))
    ).flat();
    const oneOffOtherSiteTypes = CALIBRATION_SITE_TYPES.slice(1).map((siteType, index) => ({
      ...observation(pilotArea, index + 1, 0),
      observation_id: `${pilotArea}-one-off-${siteType}`,
      planned_point_id: `${pilotArea}-one-off-${siteType}`,
      site_type: siteType,
    }));
    return [...repeatedOpenStreetPoints, ...oneOffOtherSiteTypes];
  });

  const result = analyseFixedPointCalibration(records, thresholdPlan);
  assert.equal(result.status, "analysed");
  assert.equal(result.analysis.evidenceStatus, "insufficient-evidence");
  assert.equal(result.analysis.fixedPointGateMet, null);
  assert.equal(result.analysis.eligibleObservationCount, 46);
  assert.equal(result.analysis.classificationAgreementPercent, 100);

  for (const pilot of result.analysis.pilots) {
    assert.equal(pilot.uniquePlannedPointCount, 11);
    assert.equal(pilot.completeRepeatedPointCount, 6);
    assert.deepEqual(pilot.representedSiteTypes, [...CALIBRATION_SITE_TYPES].sort());
    assert.deepEqual(pilot.completeRepeatedSiteTypes, ["open-street"]);
    for (const siteType of CALIBRATION_SITE_TYPES.slice(1)) {
      assert.ok(result.analysis.failureCodes.includes(
        `${pilot.pilotArea}:site-type-not-repeated-in-every-time-band:${siteType}`,
      ));
    }
  }
  assert.equal(result.analysis.failureCodes.length, 10);
});

test("separates incomplete coverage, threshold failure and release mismatch", () => {
  const records = completeDataset();
  const incomplete = analyseFixedPointCalibration(records.slice(0, 18), thresholdPlan);
  assert.equal(incomplete.analysis.evidenceStatus, "insufficient-evidence");
  assert.equal(incomplete.analysis.fixedPointGateMet, null);
  assert.ok(incomplete.analysis.failureCodes.includes("kings-cross:minimum-unique-points"));

  const disagreements = records.map((record, index) => index < 10
    ? { ...record, observed_state: "sun" }
    : record);
  const failed = analyseFixedPointCalibration(disagreements, thresholdPlan);
  assert.equal(failed.analysis.evidenceStatus, "thresholds-not-met");
  assert.equal(failed.analysis.fixedPointGateMet, false);
  assert.equal(failed.analysis.classificationAgreementPercent, 72.222);
  assert.ok(failed.analysis.failureCodes.includes("minimum-overall-classification-agreement"));

  const wrongRelease = records.map((record, index) => index === 0
    ? { ...record, model_version: "another-model-v1" }
    : record);
  const excluded = analyseFixedPointCalibration(wrongRelease, thresholdPlan);
  assert.equal(excluded.analysis.evidenceStatus, "insufficient-evidence");
  assert.equal(excluded.analysis.excludedObservationCounts.releaseIdentityMismatch, 1);
});

test("excludes ineligible conditions and imprecise one-shot GPS without deleting records", () => {
  const records = completeDataset();
  records[0] = { ...records[0], weather_visibility: "overcast" };
  records[1] = { ...records[1], gps_accuracy_metres: 40 };
  records[2] = { ...records[2], observed_london_datetime: "2026-08-17T20:30" };
  const result = analyseFixedPointCalibration(records, thresholdPlan);
  assert.equal(result.analysis.totalObservationCount, 36);
  assert.equal(result.analysis.eligibleObservationCount, 33);
  assert.deepEqual(result.analysis.excludedObservationCounts, {
    releaseIdentityMismatch: 0,
    nonClearSunConditions: 1,
    gpsAccuracyAboveThreshold: 1,
    outsideRegisteredTimeBands: 1,
  });
  assert.equal(result.analysis.evidenceStatus, "insufficient-evidence");
});

test("does not count a reused point ID as fixed when its coordinates move materially", () => {
  const records = completeDataset();
  records[1] = {
    ...records[1],
    latitude: Number((records[1].latitude + 0.001).toFixed(7)),
  };
  const result = analyseFixedPointCalibration(records, thresholdPlan);
  assert.equal(result.analysis.evidenceStatus, "insufficient-evidence");
  assert.equal(result.analysis.fixedPointGateMet, null);
  assert.equal(result.analysis.pilots[1].pointRepeatDistanceFailureCount, 0);
  assert.equal(result.analysis.pilots[0].pointRepeatDistanceFailureCount, 1);
  assert.ok(result.analysis.failureCodes.includes("waterloo:point-repeat-distance"));
});

test("rejects malformed inputs non-throwingly and never repairs contradictory point metadata", () => {
  const invalidPlans = [
    null,
    {},
    { ...thresholdPlan, unexpected: true },
    { ...thresholdPlan, model_version: "contains spaces" },
    { ...thresholdPlan, maximum_gps_accuracy_metres: -1 },
    { ...thresholdPlan, maximum_point_repeat_distance_metres: 0 },
    { ...thresholdPlan, required_pilot_areas: ["waterloo"] },
    { ...thresholdPlan, time_bands: thresholdPlan.time_bands.map((band) => ({
      ...band,
      start_hour_inclusive: 12,
    })) },
  ];
  for (const plan of invalidPlans) {
    assert.doesNotThrow(() => parseFixedPointThresholdPlan(plan));
    assert.equal(parseFixedPointThresholdPlan(plan), null);
    assert.equal(analyseFixedPointCalibration([], plan).status, "invalid");
  }

  const records = completeDataset();
  records[1] = { ...records[1], site_type: "building-edge" };
  assert.equal(analyseFixedPointCalibration(records, thresholdPlan).status, "invalid");
  assert.equal(
    analyseFixedPointCalibrationCsv("not,csv", thresholdPlan).status,
    "invalid",
  );

  const hostile = {};
  Object.defineProperty(hostile, "schema", {
    get() {
      throw new Error("hostile getter");
    },
  });
  assert.doesNotThrow(() => analyseFixedPointCalibration(hostile, hostile));
  assert.equal(analyseFixedPointCalibration(hostile, hostile).status, "invalid");
  assert.doesNotThrow(() => analyseFixedPointCalibrationCsv(hostile, hostile));

  const exported = calibrationObservationsToCsv(completeDataset());
  assert.equal(analyseFixedPointCalibrationCsv(exported, thresholdPlan).status, "analysed");
});
