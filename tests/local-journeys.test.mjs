import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FIELD_FEEDBACK_STORAGE_KEY,
  SAVED_JOURNEYS_STORAGE_KEY,
  clearFieldFeedback,
  clearLocalJourneys,
  deleteFieldFeedback,
  deleteLocalJourney,
  fieldFeedbackToCsv,
  fieldFeedbackToJson,
  fieldFeedbackSnapshotStatus,
  readFieldFeedback,
  readSavedJourneys,
  saveLocalJourney,
  savedJourneysSnapshotStatus,
  submitFieldFeedback,
} from "../lib/local-journeys.ts";

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

function journeySetup(overrides = {}) {
  return {
    areaId: "waterloo",
    origin: { name: "London Waterloo Station", lat: 51.50225, lon: -0.11316 },
    destination: { name: "St Thomas’ Hospital", lat: 51.49906, lon: -0.1187 },
    departureTime: "14:15",
    profile: "vulnerable",
    journeyCount: 2,
    repeatEveryMinutes: 120,
    avoidSteps: true,
    preferredRouteId: "waterloo-2",
    ...overrides,
  };
}

test("saved journeys use a versioned, route-setup-only local schema", () => {
  const storage = memoryStorage();
  const journeys = saveLocalJourney(
    { id: "journey-one", label: "Hospital journey", setup: journeySetup() },
    storage,
  );

  assert.equal(journeys.length, 1);
  assert.deepEqual(readSavedJourneys(storage), journeys);
  const persisted = JSON.parse(storage.getItem(SAVED_JOURNEYS_STORAGE_KEY));
  assert.equal(persisted.schemaVersion, 1);
  assert.deepEqual(Object.keys(persisted.journeys[0]).sort(), ["id", "label", "setup"]);
  assert.deepEqual(Object.keys(persisted.journeys[0].setup).sort(), [
    "areaId",
    "avoidSteps",
    "departureTime",
    "destination",
    "journeyCount",
    "origin",
    "preferredRouteId",
    "profile",
    "repeatEveryMinutes",
    "walkingPace",
  ]);
  assert.equal(persisted.journeys[0].setup.walkingPace, "standard");
  assert.equal("coordinates" in persisted.journeys[0].setup, false);
  assert.equal("journeyHistory" in persisted.journeys[0], false);
});

test("saved journeys can be replaced, deleted and cleared without an account", () => {
  const storage = memoryStorage();
  saveLocalJourney(
    { id: "journey-one", label: "Original", setup: journeySetup() },
    storage,
  );
  saveLocalJourney(
    { id: "journey-one", label: "Updated", setup: journeySetup({ departureTime: "15:00" }) },
    storage,
  );
  saveLocalJourney(
    { id: "journey-two", label: "Second", setup: journeySetup() },
    storage,
  );

  assert.deepEqual(readSavedJourneys(storage).map((journey) => journey.label), ["Second", "Updated"]);
  deleteLocalJourney("journey-one", storage);
  assert.deepEqual(readSavedJourneys(storage).map((journey) => journey.id), ["journey-two"]);
  deleteLocalJourney("journey-two", storage);
  assert.equal(storage.getItem(SAVED_JOURNEYS_STORAGE_KEY), null);
  saveLocalJourney(
    { id: "journey-three", label: "Third", setup: journeySetup() },
    storage,
  );
  clearLocalJourneys(storage);
  assert.deepEqual(readSavedJourneys(storage), []);
});

test("saved journeys preserve pace presets and old records default to standard", () => {
  const storage = memoryStorage();
  const brisk = saveLocalJourney(
    { id: "brisk-journey", label: "Brisk", setup: journeySetup({ walkingPace: "brisk" }) },
    storage,
  );
  assert.equal(brisk[0].setup.walkingPace, "brisk");

  storage.setItem(SAVED_JOURNEYS_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    journeys: [{ id: "legacy", label: "Legacy", setup: journeySetup() }],
  }));
  assert.equal(readSavedJourneys(storage)[0].setup.walkingPace, "standard");
});

test("unknown or malformed saved-journey schemas are not trusted or silently overwritten", () => {
  const storage = memoryStorage();
  const unknownVersion = JSON.stringify({ schemaVersion: 2, journeys: [] });
  storage.setItem(SAVED_JOURNEYS_STORAGE_KEY, unknownVersion);
  assert.deepEqual(readSavedJourneys(storage), []);
  assert.throws(
    () => saveLocalJourney({ label: "Valid setup", setup: journeySetup() }, storage),
    /could not be read.*clear it/i,
  );
  assert.equal(storage.getItem(SAVED_JOURNEYS_STORAGE_KEY), unknownVersion);

  storage.setItem(SAVED_JOURNEYS_STORAGE_KEY, "not-json");
  assert.deepEqual(readSavedJourneys(storage), []);
  assert.throws(
    () => saveLocalJourney({ label: "Valid setup", setup: journeySetup() }, storage),
    /could not be read.*clear it/i,
  );

  assert.throws(
    () => saveLocalJourney({ label: "Invalid", setup: journeySetup({ departureTime: "25:99" }) }, storage),
    /incomplete/i,
  );
  clearLocalJourneys(storage);
  assert.equal(saveLocalJourney({ label: "Recovered", setup: journeySetup() }, storage).length, 1);
});

test("snapshot status distinguishes a valid empty store from unreadable data", () => {
  assert.equal(savedJourneysSnapshotStatus(null), "empty");
  assert.equal(
    savedJourneysSnapshotStatus(JSON.stringify({ schemaVersion: 1, journeys: [] })),
    "readable",
  );
  assert.equal(savedJourneysSnapshotStatus("not-json"), "unreadable");
  assert.equal(
    fieldFeedbackSnapshotStatus(JSON.stringify({ schemaVersion: 1, feedback: [] })),
    "readable",
  );
  assert.equal(
    fieldFeedbackSnapshotStatus(JSON.stringify({ schemaVersion: 2, feedback: [] })),
    "unreadable",
  );
});

test("duplicate record ids in damaged local data are de-duplicated", () => {
  const storage = memoryStorage();
  const duplicate = { id: "same-id", label: "First", setup: journeySetup() };
  storage.setItem(SAVED_JOURNEYS_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    journeys: [duplicate, { ...duplicate, label: "Duplicate" }],
  }));

  assert.deepEqual(readSavedJourneys(storage).map((journey) => journey.label), ["First"]);
});

test("storage quota and access failures use actionable, non-technical errors", () => {
  const quotaStorage = {
    getItem() { return null; },
    setItem() { throw new DOMException("Internal browser detail", "QuotaExceededError"); },
    removeItem() { throw new DOMException("Internal browser detail", "SecurityError"); },
  };
  assert.throws(
    () => saveLocalJourney({ label: "Hospital", setup: journeySetup() }, quotaStorage),
    /^Error: Browser storage is unavailable or full\. Nothing was saved\.$/,
  );
  assert.throws(
    () => submitFieldFeedback(
      { routeId: "waterloo-1" },
      { outcome: "actually-shaded" },
      quotaStorage,
    ),
    /^Error: Browser storage is unavailable or full\. Nothing was saved\.$/,
  );
  assert.throws(
    () => clearLocalJourneys(quotaStorage),
    /^Error: Browser storage is unavailable\. Nothing was removed\.$/,
  );
});

test("local collection limits stop silent loss of older data", () => {
  const storage = memoryStorage();
  storage.setItem(SAVED_JOURNEYS_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    journeys: Array.from({ length: 20 }, (_, index) => ({
      id: `journey-${index}`,
      label: `Journey ${index}`,
      setup: journeySetup(),
    })),
  }));
  assert.throws(
    () => saveLocalJourney({ label: "One too many", setup: journeySetup() }, storage),
    /already holds 20 saved journeys/i,
  );
  assert.equal(readSavedJourneys(storage).length, 20);

  storage.setItem(FIELD_FEEDBACK_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    feedback: Array.from({ length: 500 }, (_, index) => ({
      id: `feedback-${index}`,
      submittedAt: "2026-08-12T13:15:00.000Z",
      routeId: "waterloo-1",
      outcome: "actually-shaded",
      includeLocation: false,
    })),
  }));
  assert.throws(
    () => submitFieldFeedback(
      { routeId: "waterloo-1" },
      { outcome: "actually-sunny" },
      storage,
    ),
    /already holds 500 reports/i,
  );
  assert.equal(readFieldFeedback(storage).length, 500);
});

test("field feedback discards candidate coordinates by default", () => {
  const storage = memoryStorage();
  const context = {
    routeId: "waterloo-2",
    routeName: "Via Station Approach",
    segmentId: "step-3",
    segmentLabel: "Cross York Road",
    predictedState: "shade",
    predictedAt: "2026-08-12T13:15:00.000Z",
    location: { latitude: 51.501, longitude: -0.116, accuracyMetres: 8 },
  };
  const record = submitFieldFeedback(
    context,
    {
      outcome: "actually-sunny",
      predictionRecordedFirst: true,
      pavementSide: "left",
      weatherVisibility: "clear-direct-sun",
      leafState: "leaf-on",
      temporaryConditions: "Temporary works",
      note: "Prediction disagreed",
    },
    storage,
  );

  assert.equal(record.includeLocation, false);
  assert.equal("location" in record, false);
  const persisted = JSON.parse(storage.getItem(FIELD_FEEDBACK_STORAGE_KEY));
  assert.equal("location" in persisted.feedback[0], false);
  assert.equal(fieldFeedbackToJson([record]).includes("latitude"), false);
  assert.equal(fieldFeedbackToCsv([record]).includes("51.501"), false);
  assert.equal(record.predictionRecordedFirst, true);
  assert.equal(record.pavementSide, "left");
  assert.equal(record.weatherVisibility, "clear-direct-sun");
  assert.equal(record.leafState, "leaf-on");
  assert.equal(record.temporaryConditions, "Temporary works");
});

test("field feedback includes coordinates only after explicit consent", () => {
  const storage = memoryStorage();
  const record = submitFieldFeedback(
    {
      routeId: "waterloo-2",
      predictedState: "sun",
      location: { latitude: 51.501, longitude: -0.116, accuracyMetres: 8 },
    },
    { outcome: "predicted-correct", includeLocation: true },
    storage,
  );

  assert.equal(record.includeLocation, true);
  assert.deepEqual(record.location, { latitude: 51.501, longitude: -0.116, accuracyMetres: 8 });
  assert.match(fieldFeedbackToJson([record]), /"latitude": 51\.501/);
  assert.match(fieldFeedbackToCsv([record]), /,51\.501,-0\.116,/);
  assert.throws(
    () => submitFieldFeedback(
      { routeId: "waterloo-2" },
      { outcome: "other", includeLocation: true },
      storage,
    ),
    /no valid coordinates/i,
  );
});

test("feedback exports are portable and CSV formula text is neutralised", () => {
  const storage = memoryStorage();
  const first = submitFieldFeedback(
    { routeId: "waterloo-1", routeName: "=HYPERLINK(\"unsafe\")" },
    { outcome: "blocked-or-inaccessible", note: "=HYPERLINK(\"unsafe\")" },
    storage,
  );
  const second = submitFieldFeedback(
    { routeId: "waterloo-2" },
    { outcome: "actually-shaded" },
    storage,
  );

  const records = readFieldFeedback(storage);
  assert.equal(records.length, 2);
  const json = JSON.parse(fieldFeedbackToJson(records));
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.feedback.length, 2);
  const csv = fieldFeedbackToCsv([first, second]);
  assert.match(csv, /^"report_id","pilot_area","model_section_latitude","model_section_longitude"/);
  assert.match(csv, /"Route blocked or inaccessible\. =HYPERLINK\(""unsafe""\)"/);
  assert.match(csv, /"'=HYPERLINK\(""unsafe""\)"/);
  assert.doesNotMatch(csv, /,"[=+@-]/);
  assert.match(csv, /"estimate_seen_before_report","temporary_conditions","leaf_state"/);

  deleteFieldFeedback(first.id, storage);
  assert.equal(readFieldFeedback(storage).length, 1);
  deleteFieldFeedback(second.id, storage);
  assert.equal(storage.getItem(FIELD_FEEDBACK_STORAGE_KEY), null);
  clearFieldFeedback(storage);
  assert.deepEqual(readFieldFeedback(storage), []);
});

test("unreadable feedback remains untouched until it is explicitly cleared", () => {
  const storage = memoryStorage();
  const unreadable = JSON.stringify({ schemaVersion: 9, feedback: [] });
  storage.setItem(FIELD_FEEDBACK_STORAGE_KEY, unreadable);

  assert.throws(
    () => submitFieldFeedback(
      { routeId: "waterloo-1" },
      { outcome: "actually-shaded" },
      storage,
    ),
    /could not be read.*clear it/i,
  );
  assert.equal(storage.getItem(FIELD_FEEDBACK_STORAGE_KEY), unreadable);
  clearFieldFeedback(storage);
  assert.equal(storage.getItem(FIELD_FEEDBACK_STORAGE_KEY), null);
});

test("local-data components make consent, storage and export behaviour explicit", async () => {
  const [savedSource, feedbackSource] = await Promise.all([
    readFile(new URL("../components/SavedJourneys.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/FieldFeedback.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(savedSource, /does not send the data to a server or create an account/);
  assert.match(savedSource, /Clear saved journeys/);
  assert.match(savedSource, /Browser storage is unavailable/);
  assert.match(savedSource, /Existing saved-journey data cannot be read/);
  assert.match(savedSource, /onLoad\(journey\.setup, journey\)/);
  assert.match(savedSource, /resolveWalkingPace\(setup\.walkingPace\)/);
  assert.match(savedSource, /Modelled pace:.*planning preset/);
  assert.doesNotMatch(savedSource, /fetch\(/);

  for (const outcome of [
    "predicted-correct",
    "actually-sunny",
    "actually-shaded",
    "blocked-or-inaccessible",
    "other",
  ]) {
    assert.match(feedbackSource, new RegExp(outcome));
  }
  assert.match(feedbackSource, /Off by default/);
  assert.match(feedbackSource, /Nothing was sent to a server/);
  assert.match(feedbackSource, /Nothing is saved automatically or sent to a server/);
  assert.match(feedbackSource, /route section,[\s\S]+answer and optional note/);
  assert.match(feedbackSource, /estimate before checking current conditions/i);
  assert.match(feedbackSource, /model section&apos;s start, not a device GPS observation/i);
  assert.match(feedbackSource, /does not make this a fixed-point calibration observation/i);
  assert.match(feedbackSource, /Side of pavement/);
  assert.match(feedbackSource, /Sun visibility/);
  assert.match(feedbackSource, /Leaf state/);
  assert.match(feedbackSource, /Temporary conditions/);
  assert.match(feedbackSource, /An exported file leaves this browser[\s\S]+only if you share it/);
  assert.match(feedbackSource, /Check[\s\S]+the[\s\S]+file before sharing it/);
  assert.match(feedbackSource, /minHeight: 44/);
  assert.doesNotMatch(feedbackSource, /autoFocus/);
  assert.match(feedbackSource, /Export JSON/);
  assert.match(feedbackSource, /Export CSV/);
  assert.doesNotMatch(feedbackSource, /fetch\(/);
});

test("the canonical calibration sheet stays separate from operational section reports", async () => {
  const [protocol, observations] = await Promise.all([
    readFile(new URL("../validation/README.md", import.meta.url), "utf8"),
    readFile(new URL("../validation/observations.csv", import.meta.url), "utf8"),
  ]);

  assert.match(protocol, /in-app “Operational field feedback” form is deliberately separate/i);
  assert.match(protocol, /does[\s\S]+not capture a device GPS observation point/i);
  assert.match(protocol, /must not be counted as fixed-point calibration observations/i);
  assert.equal(observations.trim().split("\n").length, 1);
  assert.equal(observations.trim().split(",").length, 13);
  assert.doesNotMatch(observations, /route_id|modelled_london_datetime|include_location/);
});
