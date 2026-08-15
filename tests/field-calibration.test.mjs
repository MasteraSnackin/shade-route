import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CALIBRATION_PILOT_AREA_IDS,
  CALIBRATION_PILOT_BOUNDARIES,
  FIELD_CALIBRATION_DATA_PACK_FINGERPRINTS,
  FIELD_CALIBRATION_DATA_PACK_VERSION,
  FIELD_CALIBRATION_COLUMNS,
  FIELD_CALIBRATION_MAX_OBSERVATIONS,
  FIELD_CALIBRATION_STORAGE_KEY,
  FIELD_CALIBRATION_MODEL_VERSION,
  FIELD_CALIBRATION_PROTOCOL_VERSION,
  FIELD_CALIBRATION_SCHEMA,
  FIELD_CALIBRATION_SCHEMA_VERSION,
  calibrationObservationsToCsv,
  calibrationSnapshotStatus,
  clearCalibrationObservations,
  createCalibrationObservation,
  deleteCalibrationObservation,
  freezeCalibrationPrediction,
  importCalibrationCsv,
  parseCalibrationCsv,
  prepareCalibrationModelPredictionRequest,
  readCalibrationObservations,
  saveCalibrationObservation,
} from "../lib/field-calibration.ts";
import {
  OFFLINE_PILOT_DATA_ASSETS,
  OFFLINE_PILOT_STATIC_ASSET_INTEGRITY,
} from "../lib/offline-pilot.ts";
import { PILOT_DATA_VERSION, SHADE_MODEL_VERSION } from "../lib/release-identity.ts";

test("binds the raster lookup to a known pilot, exact bounded point and London civil time", () => {
  assert.deepEqual(CALIBRATION_PILOT_AREA_IDS, ["waterloo", "kings-cross"]);
  const request = prepareCalibrationModelPredictionRequest({
    pilotArea: "waterloo",
    latitude: 51.50123456,
    longitude: -0.11345678,
    observedLondonDateTime: "2026-08-15T14:35",
  }, CALIBRATION_PILOT_BOUNDARIES);

  assert.equal(Object.isFrozen(request), true);
  assert.deepEqual(request, {
    pilotArea: "waterloo",
    latitude: 51.5012346,
    longitude: -0.1134568,
    observedLondonDateTime: "2026-08-15T14:35",
  });
  assert.throws(
    () => prepareCalibrationModelPredictionRequest({
      ...request,
      pilotArea: "kings-cross",
    }, CALIBRATION_PILOT_BOUNDARIES),
    /inside the selected pilot area/i,
  );
  assert.throws(
    () => prepareCalibrationModelPredictionRequest({
      ...request,
      pilotArea: "another-area",
    }, CALIBRATION_PILOT_BOUNDARIES),
    /two ShadeRoute pilot areas/i,
  );
  assert.throws(
    () => prepareCalibrationModelPredictionRequest({
      ...request,
      observedLondonDateTime: "2026-03-29T01:30",
    }, CALIBRATION_PILOT_BOUNDARIES),
    /valid observation date and time/i,
  );
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function frozenPrediction(overrides = {}) {
  return freezeCalibrationPrediction({
    pilotArea: "waterloo",
    plannedPointId: "waterloo-building-edge-01",
    siteType: "building-edge",
    latitude: 51.50123456,
    longitude: -0.11345678,
    pavementSide: "left",
    observedLondonDateTime: "2026-08-15T14:35",
    predictedState: "shade",
    locationAccuracyMetres: 7.86,
    ...overrides,
  }, "2026-08-15T13:34:20.000Z");
}

function observation(id = "observation-one", overrides = {}) {
  return createCalibrationObservation(
    frozenPrediction(),
    {
      weatherVisibility: "clear-direct-sun",
      observedState: "sun",
      temporaryConditions: "Works hoarding",
      leafState: "leaf-on",
      observerNotes: "Building edge",
      ...overrides,
    },
    id,
  );
}

test("freezes a bounded prediction before creating an exact fixed-point record", () => {
  const frozen = frozenPrediction();
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(frozen.predictionFrozen, true);
  assert.equal(frozen.predictionFrozenAt, "2026-08-15T13:34:20.000Z");
  assert.equal(frozen.schema, FIELD_CALIBRATION_SCHEMA);
  assert.equal(frozen.schemaVersion, FIELD_CALIBRATION_SCHEMA_VERSION);
  assert.equal(frozen.protocolVersion, FIELD_CALIBRATION_PROTOCOL_VERSION);
  assert.equal(frozen.modelVersion, SHADE_MODEL_VERSION);
  assert.equal(frozen.dataPackVersion, PILOT_DATA_VERSION);
  assert.equal(frozen.coordinateSource, "one-shot-gps");

  const record = observation();
  assert.deepEqual(Object.keys(record), FIELD_CALIBRATION_COLUMNS);
  assert.equal(record.predicted_before_observation, true);
  assert.equal(record.observed_london_datetime, "2026-08-15T14:35");
  assert.equal(record.latitude, 51.5012346);
  assert.equal(record.longitude, -0.1134568);
  assert.equal(record.planned_point_id, "waterloo-building-edge-01");
  assert.equal(record.site_type, "building-edge");
  assert.equal(record.coordinate_source, "one-shot-gps");
  assert.equal(record.gps_accuracy_metres, 7.9);
  assert.equal(record.observer_notes, "Building edge");
  assert.equal(record.model_version, FIELD_CALIBRATION_MODEL_VERSION);
  assert.equal(record.data_pack_version, FIELD_CALIBRATION_DATA_PACK_VERSION);
  assert.equal(
    record.data_pack_fingerprint,
    FIELD_CALIBRATION_DATA_PACK_FINGERPRINTS.waterloo,
  );
  assert.equal("predictionFrozenAt" in record, false);
  assert.equal("deviceId" in record, false);
  assert.equal("savedAt" in record, false);
});

test("derives calibration identity from the canonical release and exact pilot asset manifests", () => {
  assert.equal(FIELD_CALIBRATION_MODEL_VERSION, SHADE_MODEL_VERSION);
  assert.equal(FIELD_CALIBRATION_DATA_PACK_VERSION, PILOT_DATA_VERSION);
  for (const pilotArea of CALIBRATION_PILOT_AREA_IDS) {
    const canonical = JSON.stringify([
      pilotArea,
      PILOT_DATA_VERSION,
      [...OFFLINE_PILOT_DATA_ASSETS[pilotArea]].sort().map((path) => [
        path,
        OFFLINE_PILOT_STATIC_ASSET_INTEGRITY[path].byteLength,
        OFFLINE_PILOT_STATIC_ASSET_INTEGRITY[path].sha256,
      ]),
    ]);
    assert.equal(
      FIELD_CALIBRATION_DATA_PACK_FINGERPRINTS[pilotArea],
      `sha256-${createHash("sha256").update(canonical).digest("hex")}`,
    );
  }
});

test("rejects invalid civil times, missing points and observations without a frozen prediction", () => {
  assert.throws(
    () => frozenPrediction({ observedLondonDateTime: "2026-03-29T01:30" }),
    /valid observation date and time/i,
  );
  assert.throws(
    () => frozenPrediction({ latitude: 100 }),
    /valid latitude and longitude/i,
  );
  assert.throws(
    () => frozenPrediction({ pilotArea: "kings-cross" }),
    /inside the selected pilot area/i,
  );
  assert.throws(
    () => frozenPrediction({ pilotArea: "another-area" }),
    /two ShadeRoute pilot areas/i,
  );
  assert.throws(
    () => frozenPrediction({ plannedPointId: "contains spaces" }),
    /fixed-point identifier/i,
  );
  assert.throws(
    () => frozenPrediction({ siteType: "road" }),
    /site type/i,
  );
  assert.throws(
    () => createCalibrationObservation(
      {},
      { weatherVisibility: "clear-direct-sun", observedState: "sun", leafState: "leaf-on" },
      "not-frozen",
    ),
    /freeze the model prediction/i,
  );
  assert.throws(
    () => createCalibrationObservation(
      { ...frozenPrediction(), modelVersion: "another-model-v1" },
      { weatherVisibility: "clear-direct-sun", observedState: "sun", leafState: "leaf-on" },
      "wrong-release",
    ),
    /not bound to this calibration release/i,
  );
  assert.throws(
    () => createCalibrationObservation(
      { ...frozenPrediction(), coordinateSource: "manual" },
      { weatherVisibility: "clear-direct-sun", observedState: "sun", leafState: "leaf-on" },
      "changed-frozen-input",
    ),
    /has been changed/i,
  );
});

test("stores strict, versioned observations locally without silently repairing damaged data", () => {
  const storage = memoryStorage();
  const record = observation();
  saveCalibrationObservation(record, storage);
  assert.deepEqual(readCalibrationObservations(storage), [record]);
  assert.equal(calibrationSnapshotStatus(storage.getItem(FIELD_CALIBRATION_STORAGE_KEY)), "readable");

  const stored = JSON.parse(storage.getItem(FIELD_CALIBRATION_STORAGE_KEY));
  assert.deepEqual(Object.keys(stored), ["schemaVersion", "observations"]);
  assert.equal(stored.schemaVersion, FIELD_CALIBRATION_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(stored.observations[0]), FIELD_CALIBRATION_COLUMNS);

  assert.throws(() => saveCalibrationObservation(record, storage), /already exists/i);
  stored.observations[0].unexpected_device_field = "not allowed";
  storage.setItem(FIELD_CALIBRATION_STORAGE_KEY, JSON.stringify(stored));
  assert.equal(calibrationSnapshotStatus(storage.getItem(FIELD_CALIBRATION_STORAGE_KEY)), "unreadable");
  assert.deepEqual(readCalibrationObservations(storage), []);
  assert.throws(
    () => saveCalibrationObservation(observation("observation-two"), storage),
    /could not be read.*clear it/i,
  );

  clearCalibrationObservations(storage);
  assert.equal(storage.getItem(FIELD_CALIBRATION_STORAGE_KEY), null);
});

test("enforces a bounded collection and supports deliberate deletion", () => {
  const storage = memoryStorage();
  const first = observation("first");
  saveCalibrationObservation(first, storage);
  assert.deepEqual(deleteCalibrationObservation("first", storage), []);
  assert.equal(storage.getItem(FIELD_CALIBRATION_STORAGE_KEY), null);

  storage.setItem(FIELD_CALIBRATION_STORAGE_KEY, JSON.stringify({
    schemaVersion: FIELD_CALIBRATION_SCHEMA_VERSION,
    observations: Array.from(
      { length: FIELD_CALIBRATION_MAX_OBSERVATIONS },
      (_, index) => observation(`observation-${index}`),
    ),
  }));
  assert.throws(
    () => saveCalibrationObservation(observation("one-too-many"), storage),
    /already holds 500 calibration observations/i,
  );
  assert.equal(readCalibrationObservations(storage).length, FIELD_CALIBRATION_MAX_OBSERVATIONS);
});

test("exports and imports only the versioned fixed-point CSV schema", () => {
  const record = observation("csv-one", {
    temporaryConditions: "=HYPERLINK(\"https://invalid.example\")",
    observerNotes: "Temporary canopy, west side",
  });
  const csv = calibrationObservationsToCsv([record]);
  assert.equal(csv.split("\n")[0], FIELD_CALIBRATION_COLUMNS.join(","));
  assert.equal(csv.includes("'=HYPERLINK"), true);
  assert.equal(csv.includes("predictionFrozenAt"), false);
  assert.equal(csv.includes("deviceId"), false);
  assert.equal(csv.includes(FIELD_CALIBRATION_DATA_PACK_FINGERPRINTS.waterloo), true);

  const parsed = parseCalibrationCsv(csv);
  assert.ok(parsed);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].temporary_conditions.startsWith("'="), true);
  assert.equal(parsed[0].predicted_before_observation, true);
  assert.equal(parsed[0].gps_accuracy_metres, 7.9);

  const storage = memoryStorage();
  const result = importCalibrationCsv(csv, storage);
  assert.equal(result.importedCount, 1);
  assert.equal(readCalibrationObservations(storage).length, 1);
  assert.throws(() => importCalibrationCsv(csv, storage), /already stored/i);

  assert.equal(parseCalibrationCsv(csv.replace("pilot_area", "area")), null);
  assert.equal(parseCalibrationCsv(`${csv.trimEnd()},extra\n`), null);
  assert.equal(parseCalibrationCsv(csv.replace(",waterloo,", ",kings-cross,")), null);
  assert.equal(parseCalibrationCsv(csv.replace(",waterloo,", ",another-area,")), null);
  assert.equal(parseCalibrationCsv(csv.replace(",one-shot-gps,7.9,", ",manual,7.9,")), null);
  assert.equal(parseCalibrationCsv(csv.replace(FIELD_CALIBRATION_PROTOCOL_VERSION, "other-protocol")), null);
});

test("observer UI uses one-shot location, keeps physical state hidden and names the privacy boundary", async () => {
  const source = await readFile(
    new URL("../components/CalibrationObserver.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /getCurrentPosition/);
  assert.doesNotMatch(source, /watchPosition/);
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.match(source, /!frozen \?/);
  assert.match(source, /await resolvePrediction\(request\)/);
  assert.match(source, /prepareCalibrationModelPredictionRequest/);
  assert.match(source, /Observed-state controls remain hidden/);
  assert.match(source, /Manual protocol fallback: no raster resolver is connected/);
  assert.match(source, /prediction is frozen/i);
  assert.match(source, /separate from operational feedback/i);
  assert.match(source, /continuous\s+tracking is not used/i);
  assert.match(source, /exact locations/i);
  assert.match(source, /uncalibrated clear-sky model/i);
  assert.match(source, /Planned point ID/);
  assert.match(source, /browser-reported GPS accuracy are separate fields/i);
  assert.match(source, /<CalibrationObserverRouteWalks/);

  const appSource = await readFile(
    new URL("../components/ShadeRouteApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(appSource, /loadHeightGrid\(request\.pilotArea\)/);
  assert.match(appSource, /assessPointExposure\(\s*\[request\.longitude, request\.latitude\]/);
  assert.match(appSource, /resolvePrediction=\{resolveCalibrationPrediction\}/);
});
