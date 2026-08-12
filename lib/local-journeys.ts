import { londonDateTimeValue } from "./london-time.ts";
import { isWalkingPace, type WalkingPace } from "./walking-pace.ts";

export const SAVED_JOURNEYS_STORAGE_KEY = "shaderoute.saved-journeys.v1";
export const FIELD_FEEDBACK_STORAGE_KEY = "shaderoute.field-feedback.v1";

const SCHEMA_VERSION = 1;
const MAX_SAVED_JOURNEYS = 20;
const MAX_FEEDBACK_RECORDS = 500;

export interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SavedJourneyPoint {
  name: string;
  lat: number;
  lon: number;
}

export interface SavedJourneySetup {
  areaId?: string;
  origin: SavedJourneyPoint;
  destination: SavedJourneyPoint;
  /** Local London wall-clock time, stored without a journey date. */
  departureTime?: string;
  profile: "vulnerable" | "worker";
  /** Omitted by legacy v1 records; readers normalise it to standard. */
  walkingPace?: WalkingPace;
  journeyCount: number;
  repeatEveryMinutes: number;
  avoidSteps: boolean;
  preferredRouteId?: string;
}

export interface SavedJourney {
  id: string;
  label: string;
  setup: SavedJourneySetup;
}

interface SavedJourneyEnvelope {
  schemaVersion: 1;
  journeys: SavedJourney[];
}

export type FieldFeedbackOutcome =
  | "predicted-correct"
  | "actually-sunny"
  | "actually-shaded"
  | "blocked-or-inaccessible"
  | "other";

export type PredictedShadeState = "sun" | "shade" | "uncertain" | "unknown" | "night";

export interface FeedbackLocation {
  latitude: number;
  longitude: number;
  accuracyMetres?: number;
}

export interface FieldFeedbackContext {
  routeId: string;
  pilotArea?: string;
  routeName?: string;
  segmentId?: string;
  segmentLabel?: string;
  predictedState?: PredictedShadeState;
  predictedAt?: string;
  /** Model-section reference coordinates. They are not device GPS and are discarded unless explicitly included. */
  location?: FeedbackLocation;
}

export interface FieldFeedbackSubmission {
  outcome: FieldFeedbackOutcome;
  /** Records whether the estimate was seen before current conditions were checked. Operational context only. */
  predictionRecordedFirst?: boolean;
  pavementSide?: "left" | "right" | "centre" | "not-recorded";
  weatherVisibility?: "clear-direct-sun" | "intermittent-sun" | "overcast" | "not-recorded";
  leafState?: "leaf-on" | "partial" | "leaf-off" | "not-applicable" | "not-recorded";
  temporaryConditions?: string;
  note?: string;
  includeLocation?: boolean;
}

export interface FieldFeedbackRecord extends Omit<FieldFeedbackContext, "location"> {
  id: string;
  submittedAt: string;
  outcome: FieldFeedbackOutcome;
  predictionRecordedFirst: boolean;
  pavementSide: "left" | "right" | "centre" | "not-recorded";
  weatherVisibility: "clear-direct-sun" | "intermittent-sun" | "overcast" | "not-recorded";
  leafState: "leaf-on" | "partial" | "leaf-off" | "not-applicable" | "not-recorded";
  temporaryConditions?: string;
  note?: string;
  includeLocation: boolean;
  location?: FeedbackLocation;
}

interface FieldFeedbackEnvelope {
  schemaVersion: 1;
  feedback: FieldFeedbackRecord[];
}

export type LocalDataSnapshotStatus = "empty" | "readable" | "unreadable";

function browserStorage(): LocalStorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage?: LocalStorageLike | null) {
  return storage === undefined ? browserStorage() : storage;
}

function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || undefined;
}

function validLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

function validLongitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

function cleanPoint(value: unknown): SavedJourneyPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Partial<SavedJourneyPoint>;
  const name = cleanText(point.name, 160);
  if (!name || !validLatitude(point.lat) || !validLongitude(point.lon)) return null;
  return { name, lat: point.lat, lon: point.lon };
}

function cleanSetup(value: unknown): SavedJourneySetup | null {
  if (!value || typeof value !== "object") return null;
  const setup = value as Partial<SavedJourneySetup>;
  const origin = cleanPoint(setup.origin);
  const destination = cleanPoint(setup.destination);
  if (!origin || !destination) return null;
  if (setup.profile !== "vulnerable" && setup.profile !== "worker") return null;
  if (!Number.isInteger(setup.journeyCount) || setup.journeyCount! < 1 || setup.journeyCount! > 50) {
    return null;
  }
  if (
    !Number.isInteger(setup.repeatEveryMinutes) ||
    setup.repeatEveryMinutes! < 5 ||
    setup.repeatEveryMinutes! > 1_440
  ) {
    return null;
  }
  if (typeof setup.avoidSteps !== "boolean") return null;

  const departureTime = cleanText(setup.departureTime, 5);
  if (departureTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(departureTime)) return null;

  return {
    ...(cleanText(setup.areaId, 80) ? { areaId: cleanText(setup.areaId, 80) } : {}),
    origin,
    destination,
    ...(departureTime ? { departureTime } : {}),
    profile: setup.profile,
    walkingPace: isWalkingPace(setup.walkingPace) ? setup.walkingPace : "standard",
    journeyCount: setup.journeyCount!,
    repeatEveryMinutes: setup.repeatEveryMinutes!,
    avoidSteps: setup.avoidSteps,
    ...(cleanText(setup.preferredRouteId, 120)
      ? { preferredRouteId: cleanText(setup.preferredRouteId, 120) }
      : {}),
  };
}

function cleanSavedJourney(value: unknown): SavedJourney | null {
  if (!value || typeof value !== "object") return null;
  const journey = value as Partial<SavedJourney>;
  const id = cleanText(journey.id, 120);
  const label = cleanText(journey.label, 100);
  const setup = cleanSetup(journey.setup);
  if (!id || !label || !setup) return null;
  return { id, label, setup };
}

function uniqueById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function parseSavedJourneys(raw: string | null) {
  if (!raw) return [];
  try {
    const envelope = JSON.parse(raw) as Partial<SavedJourneyEnvelope>;
    if (envelope.schemaVersion !== SCHEMA_VERSION || !Array.isArray(envelope.journeys)) return [];
    return uniqueById(
      envelope.journeys
        .map(cleanSavedJourney)
        .filter((journey): journey is SavedJourney => journey !== null),
    ).slice(0, MAX_SAVED_JOURNEYS);
  } catch {
    return [];
  }
}

function envelopeSnapshotStatus(
  raw: string | null,
  collectionName: "journeys" | "feedback",
): LocalDataSnapshotStatus {
  if (!raw) return "empty";
  try {
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    if (envelope.schemaVersion === SCHEMA_VERSION && Array.isArray(envelope[collectionName])) {
      return "readable";
    }
  } catch {
    return "unreadable";
  }
  return "unreadable";
}

export function savedJourneysSnapshotStatus(raw: string | null): LocalDataSnapshotStatus {
  return envelopeSnapshotStatus(raw, "journeys");
}

export function fieldFeedbackSnapshotStatus(raw: string | null): LocalDataSnapshotStatus {
  return envelopeSnapshotStatus(raw, "feedback");
}

function assertCompatibleEnvelope(
  storage: LocalStorageLike,
  key: string,
  collectionName: "journeys" | "feedback",
) {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    throw new Error("Browser storage is unavailable. Nothing was changed.");
  }
  if (envelopeSnapshotStatus(raw, collectionName) !== "unreadable") return;
  throw new Error("Existing on-device data could not be read. Clear it before saving changes.");
}

function setStorageItem(storage: LocalStorageLike, key: string, value: string) {
  try {
    storage.setItem(key, value);
  } catch {
    throw new Error("Browser storage is unavailable or full. Nothing was saved.");
  }
}

function removeStorageItem(storage: LocalStorageLike, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    throw new Error("Browser storage is unavailable. Nothing was removed.");
  }
}

function writeSavedJourneys(storage: LocalStorageLike | null, journeys: SavedJourney[]) {
  if (!storage) throw new Error("Browser storage is unavailable.");
  assertCompatibleEnvelope(storage, SAVED_JOURNEYS_STORAGE_KEY, "journeys");
  const envelope: SavedJourneyEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    journeys: journeys.slice(0, MAX_SAVED_JOURNEYS),
  };
  setStorageItem(storage, SAVED_JOURNEYS_STORAGE_KEY, JSON.stringify(envelope));
}

function makeId(prefix: string) {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch {
    // A timestamp fallback keeps the local-only feature usable in restricted browsers.
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function readSavedJourneys(storage?: LocalStorageLike | null): SavedJourney[] {
  const activeStorage = resolveStorage(storage);
  if (!activeStorage) return [];
  try {
    return parseSavedJourneys(activeStorage.getItem(SAVED_JOURNEYS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveLocalJourney(
  input: { id?: string; label: string; setup: SavedJourneySetup },
  storage?: LocalStorageLike | null,
): SavedJourney[] {
  const activeStorage = resolveStorage(storage);
  const journey = cleanSavedJourney({
    id: cleanText(input.id, 120) ?? makeId("journey"),
    label: input.label,
    setup: input.setup,
  });
  if (!journey) throw new Error("The journey setup is incomplete.");
  const saved = readSavedJourneys(activeStorage);
  const replacingExisting = saved.some((item) => item.id === journey.id);
  if (!replacingExisting && saved.length >= MAX_SAVED_JOURNEYS) {
    throw new Error("This browser already holds 20 saved journeys. Delete one before saving another.");
  }
  const existing = saved.filter((item) => item.id !== journey.id);
  const updated = [journey, ...existing].slice(0, MAX_SAVED_JOURNEYS);
  writeSavedJourneys(activeStorage, updated);
  return updated;
}

export function deleteLocalJourney(
  id: string,
  storage?: LocalStorageLike | null,
): SavedJourney[] {
  const activeStorage = resolveStorage(storage);
  if (!activeStorage) throw new Error("Browser storage is unavailable.");
  assertCompatibleEnvelope(activeStorage, SAVED_JOURNEYS_STORAGE_KEY, "journeys");
  const updated = readSavedJourneys(activeStorage).filter((journey) => journey.id !== id);
  if (updated.length > 0) writeSavedJourneys(activeStorage, updated);
  else removeStorageItem(activeStorage, SAVED_JOURNEYS_STORAGE_KEY);
  return updated;
}

export function clearLocalJourneys(storage?: LocalStorageLike | null) {
  const activeStorage = resolveStorage(storage);
  if (!activeStorage) throw new Error("Browser storage is unavailable.");
  removeStorageItem(activeStorage, SAVED_JOURNEYS_STORAGE_KEY);
}

function cleanLocation(value: unknown): FeedbackLocation | null {
  if (!value || typeof value !== "object") return null;
  const location = value as Partial<FeedbackLocation>;
  if (!validLatitude(location.latitude) || !validLongitude(location.longitude)) return null;
  const accuracyMetres = location.accuracyMetres;
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    ...(typeof accuracyMetres === "number" && Number.isFinite(accuracyMetres) && accuracyMetres >= 0
      ? { accuracyMetres }
      : {}),
  };
}

function isOutcome(value: unknown): value is FieldFeedbackOutcome {
  return [
    "predicted-correct",
    "actually-sunny",
    "actually-shaded",
    "blocked-or-inaccessible",
    "other",
  ].includes(value as FieldFeedbackOutcome);
}

function isPredictedState(value: unknown): value is PredictedShadeState {
  return ["sun", "shade", "uncertain", "unknown", "night"].includes(
    value as PredictedShadeState,
  );
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function cleanIsoDate(value: unknown) {
  if (!validIsoDate(value)) return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
}

function cleanFeedbackRecord(value: unknown): FieldFeedbackRecord | null {
  if (!value || typeof value !== "object") return null;
  const feedback = value as Partial<FieldFeedbackRecord>;
  const id = cleanText(feedback.id, 120);
  const routeId = cleanText(feedback.routeId, 120);
  const submittedAt = cleanIsoDate(feedback.submittedAt);
  if (!id || !routeId || !submittedAt || !isOutcome(feedback.outcome)) {
    return null;
  }
  const includeLocation = feedback.includeLocation === true;
  const location = includeLocation ? cleanLocation(feedback.location) : null;
  const predictedAt = cleanIsoDate(feedback.predictedAt);
  if (includeLocation && !location) return null;

  return {
    id,
    submittedAt,
    routeId,
    ...(cleanText(feedback.pilotArea, 80) ? { pilotArea: cleanText(feedback.pilotArea, 80) } : {}),
    ...(cleanText(feedback.routeName, 160) ? { routeName: cleanText(feedback.routeName, 160) } : {}),
    ...(cleanText(feedback.segmentId, 120) ? { segmentId: cleanText(feedback.segmentId, 120) } : {}),
    ...(cleanText(feedback.segmentLabel, 240)
      ? { segmentLabel: cleanText(feedback.segmentLabel, 240) }
      : {}),
    ...(isPredictedState(feedback.predictedState)
      ? { predictedState: feedback.predictedState }
      : {}),
    ...(predictedAt ? { predictedAt } : {}),
    outcome: feedback.outcome,
    predictionRecordedFirst: feedback.predictionRecordedFirst === true,
    pavementSide: ["left", "right", "centre", "not-recorded"].includes(feedback.pavementSide ?? "")
      ? feedback.pavementSide as FieldFeedbackRecord["pavementSide"]
      : "not-recorded",
    weatherVisibility: ["clear-direct-sun", "intermittent-sun", "overcast", "not-recorded"].includes(feedback.weatherVisibility ?? "")
      ? feedback.weatherVisibility as FieldFeedbackRecord["weatherVisibility"]
      : "not-recorded",
    leafState: ["leaf-on", "partial", "leaf-off", "not-applicable", "not-recorded"].includes(feedback.leafState ?? "")
      ? feedback.leafState as FieldFeedbackRecord["leafState"]
      : "not-recorded",
    ...(cleanText(feedback.temporaryConditions, 500)
      ? { temporaryConditions: cleanText(feedback.temporaryConditions, 500) }
      : {}),
    ...(cleanText(feedback.note, 1_000) ? { note: cleanText(feedback.note, 1_000) } : {}),
    includeLocation,
    ...(location ? { location } : {}),
  };
}

function parseFieldFeedback(raw: string | null) {
  if (!raw) return [];
  try {
    const envelope = JSON.parse(raw) as Partial<FieldFeedbackEnvelope>;
    if (envelope.schemaVersion !== SCHEMA_VERSION || !Array.isArray(envelope.feedback)) return [];
    return uniqueById(
      envelope.feedback
        .map(cleanFeedbackRecord)
        .filter((record): record is FieldFeedbackRecord => record !== null),
    ).slice(0, MAX_FEEDBACK_RECORDS);
  } catch {
    return [];
  }
}

function writeFieldFeedback(storage: LocalStorageLike | null, feedback: FieldFeedbackRecord[]) {
  if (!storage) throw new Error("Browser storage is unavailable.");
  assertCompatibleEnvelope(storage, FIELD_FEEDBACK_STORAGE_KEY, "feedback");
  const envelope: FieldFeedbackEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    feedback: feedback.slice(0, MAX_FEEDBACK_RECORDS),
  };
  setStorageItem(storage, FIELD_FEEDBACK_STORAGE_KEY, JSON.stringify(envelope));
}

export function readFieldFeedback(storage?: LocalStorageLike | null): FieldFeedbackRecord[] {
  const activeStorage = resolveStorage(storage);
  if (!activeStorage) return [];
  try {
    return parseFieldFeedback(activeStorage.getItem(FIELD_FEEDBACK_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function submitFieldFeedback(
  context: FieldFeedbackContext,
  submission: FieldFeedbackSubmission,
  storage?: LocalStorageLike | null,
): FieldFeedbackRecord {
  const routeId = cleanText(context.routeId, 120);
  if (!routeId || !isOutcome(submission.outcome)) {
    throw new Error("Choose a feedback option before saving.");
  }
  const includeLocation = submission.includeLocation === true;
  const location = includeLocation ? cleanLocation(context.location) : null;
  if (includeLocation && !location) {
    throw new Error("Location cannot be included because no valid coordinates are available.");
  }

  const record = cleanFeedbackRecord({
    id: makeId("feedback"),
    submittedAt: new Date().toISOString(),
    routeId,
    pilotArea: context.pilotArea,
    routeName: context.routeName,
    segmentId: context.segmentId,
    segmentLabel: context.segmentLabel,
    predictedState: context.predictedState,
    predictedAt: context.predictedAt,
    outcome: submission.outcome,
    predictionRecordedFirst: submission.predictionRecordedFirst,
    pavementSide: submission.pavementSide,
    weatherVisibility: submission.weatherVisibility,
    leafState: submission.leafState,
    temporaryConditions: submission.temporaryConditions,
    note: submission.note,
    includeLocation,
    ...(location ? { location } : {}),
  });
  if (!record) throw new Error("The feedback record is incomplete.");

  const activeStorage = resolveStorage(storage);
  const existing = readFieldFeedback(activeStorage);
  if (existing.length >= MAX_FEEDBACK_RECORDS) {
    throw new Error("This browser already holds 500 reports. Export and clear them before saving another.");
  }
  writeFieldFeedback(activeStorage, [record, ...existing]);
  return record;
}

export function deleteFieldFeedback(
  id: string,
  storage?: LocalStorageLike | null,
): FieldFeedbackRecord[] {
  const activeStorage = resolveStorage(storage);
  if (!activeStorage) throw new Error("Browser storage is unavailable.");
  assertCompatibleEnvelope(activeStorage, FIELD_FEEDBACK_STORAGE_KEY, "feedback");
  const updated = readFieldFeedback(activeStorage).filter((record) => record.id !== id);
  if (updated.length > 0) writeFieldFeedback(activeStorage, updated);
  else removeStorageItem(activeStorage, FIELD_FEEDBACK_STORAGE_KEY);
  return updated;
}

export function clearFieldFeedback(storage?: LocalStorageLike | null) {
  const activeStorage = resolveStorage(storage);
  if (!activeStorage) throw new Error("Browser storage is unavailable.");
  removeStorageItem(activeStorage, FIELD_FEEDBACK_STORAGE_KEY);
}

export function fieldFeedbackToJson(records: FieldFeedbackRecord[]) {
  const envelope: FieldFeedbackEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    feedback: records.map(cleanFeedbackRecord).filter((record): record is FieldFeedbackRecord => record !== null),
  };
  return JSON.stringify(envelope, null, 2);
}

function csvCell(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  let text = value === undefined || value === null ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function fieldFeedbackToCsv(records: FieldFeedbackRecord[]) {
  const headings = [
    "report_id",
    "pilot_area",
    "model_section_latitude",
    "model_section_longitude",
    "pavement_side",
    "report_saved_london_datetime",
    "weather_visibility",
    "reported_state",
    "modelled_state",
    "estimate_seen_before_report",
    "temporary_conditions",
    "leaf_state",
    "observer_notes",
    "route_id",
    "route_name",
    "segment_id",
    "segment_label",
    "modelled_london_datetime",
    "include_model_section_location",
    "model_section_accuracy_metres",
  ];
  const rows = records
    .map(cleanFeedbackRecord)
    .filter((record): record is FieldFeedbackRecord => record !== null)
    .map((record) => {
      const reportedState = record.outcome === "actually-sunny"
        ? "sun"
        : record.outcome === "actually-shaded"
          ? "shade"
          : record.outcome === "predicted-correct" &&
              (record.predictedState === "sun" || record.predictedState === "shade")
            ? record.predictedState
            : "not-recorded";
      const outcomeNote = record.outcome === "blocked-or-inaccessible"
        ? "Route blocked or inaccessible."
        : record.outcome === "other"
          ? "Other field outcome."
          : "";
      return [
        record.id,
        record.pilotArea,
        record.location?.latitude,
        record.location?.longitude,
        record.pavementSide,
        londonDateTimeValue(new Date(record.submittedAt)),
        record.weatherVisibility,
        reportedState,
        record.predictedState,
        record.predictionRecordedFirst,
        record.temporaryConditions,
        record.leafState,
        [outcomeNote, record.note].filter(Boolean).join(" "),
        record.routeId,
        record.routeName,
        record.segmentId,
        record.segmentLabel,
        record.predictedAt ? londonDateTimeValue(new Date(record.predictedAt)) : undefined,
        record.includeLocation,
        record.location?.accuracyMetres,
      ];
    });
  return [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}
