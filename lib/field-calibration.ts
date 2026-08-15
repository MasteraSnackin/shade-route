import { parseLondonDateTime } from "./london-time.ts";
import { PILOT_DATA_VERSION, SHADE_MODEL_VERSION } from "./release-identity.ts";

export const FIELD_CALIBRATION_SCHEMA =
  "uk.shaderoute.fixed-point-observation" as const;
export const FIELD_CALIBRATION_SCHEMA_VERSION = 2 as const;
export const FIELD_CALIBRATION_PROTOCOL_VERSION =
  "model-first-fixed-point-v2" as const;
export const FIELD_CALIBRATION_MODEL_VERSION = SHADE_MODEL_VERSION;
export const FIELD_CALIBRATION_DATA_PACK_VERSION = PILOT_DATA_VERSION;
export const FIELD_CALIBRATION_STORAGE_KEY = "shaderoute.field-calibration.v2";
export const FIELD_CALIBRATION_MAX_OBSERVATIONS = 500;
export const FIELD_CALIBRATION_MAX_IMPORT_BYTES = 1_048_576;

export const CALIBRATION_PILOT_AREA_IDS = ["waterloo", "kings-cross"] as const;
export type CalibrationPilotAreaId = typeof CALIBRATION_PILOT_AREA_IDS[number];

export interface CalibrationPilotBoundary {
  id: CalibrationPilotAreaId;
  name: string;
  bbox: readonly [west: number, south: number, east: number, north: number];
}

/**
 * Release-pinned field-record boundaries. Keep these aligned with the bundled
 * pilot route pack; they also protect local CSV import from mislabelled points.
 */
export const CALIBRATION_PILOT_BOUNDARIES = [
  {
    id: "waterloo",
    name: "Waterloo and St Thomas’",
    bbox: [-0.13, 51.4915, -0.0975, 51.5095],
  },
  {
    id: "kings-cross",
    name: "King’s Cross and UCLH",
    bbox: [-0.145, 51.517, -0.109, 51.5365],
  },
] as const satisfies readonly CalibrationPilotBoundary[];

/**
 * SHA-256 of the release-pinned selected-pilot asset manifest: area ID, pack
 * version, then every runtime data path, byte length and content SHA-256. These
 * values are checked against `offline-pilot.ts` in the calibration tests.
 */
export const FIELD_CALIBRATION_DATA_PACK_FINGERPRINTS = {
  waterloo: "sha256-0a51dfeba49ed91d3a231270223fbcaacba86bfb73f0d230ec8032e00c6991a5",
  "kings-cross": "sha256-1192dbdc6149685cbd47cea067d52a1b493a2d86d51b2c68a5c5036b39309f69",
} as const satisfies Readonly<Record<CalibrationPilotAreaId, `sha256-${string}`>>;

export const FIELD_CALIBRATION_COLUMNS = [
  "schema",
  "schema_version",
  "protocol_version",
  "model_version",
  "data_pack_version",
  "data_pack_fingerprint",
  "observation_id",
  "pilot_area",
  "planned_point_id",
  "site_type",
  "latitude",
  "longitude",
  "coordinate_source",
  "gps_accuracy_metres",
  "pavement_side",
  "observed_london_datetime",
  "weather_visibility",
  "observed_state",
  "predicted_state",
  "predicted_before_observation",
  "temporary_conditions",
  "leaf_state",
  "observer_notes",
] as const;

export type CalibrationPavementSide = "left" | "right" | "centre";
export type CalibrationWeatherVisibility =
  | "clear-direct-sun"
  | "intermittent-sun"
  | "overcast";
export type CalibrationObservedState = "sun" | "shade";
export type CalibrationPredictedState =
  | "sun"
  | "shade"
  | "uncertain"
  | "unknown"
  | "night";
export type CalibrationLeafState = "leaf-on" | "partial" | "leaf-off" | "not-applicable";
export type CalibrationCoordinateSource = "manual" | "one-shot-gps";
export const CALIBRATION_SITE_TYPES = [
  "open-street",
  "building-edge",
  "tree-canopy",
  "street-canyon",
  "station-approach",
  "hospital-entrance",
] as const;
export type CalibrationSiteType = typeof CALIBRATION_SITE_TYPES[number];

/**
 * The persisted record deliberately mirrors validation/observations.csv exactly.
 * Do not add device, account, route-history or medical fields here.
 */
export interface CalibrationObservation {
  schema: typeof FIELD_CALIBRATION_SCHEMA;
  schema_version: typeof FIELD_CALIBRATION_SCHEMA_VERSION;
  protocol_version: typeof FIELD_CALIBRATION_PROTOCOL_VERSION;
  model_version: string;
  data_pack_version: string;
  data_pack_fingerprint: string;
  observation_id: string;
  pilot_area: CalibrationPilotAreaId;
  planned_point_id: string;
  site_type: CalibrationSiteType;
  latitude: number;
  longitude: number;
  coordinate_source: CalibrationCoordinateSource;
  gps_accuracy_metres: number | null;
  pavement_side: CalibrationPavementSide;
  observed_london_datetime: string;
  weather_visibility: CalibrationWeatherVisibility;
  observed_state: CalibrationObservedState;
  predicted_state: CalibrationPredictedState;
  predicted_before_observation: true;
  temporary_conditions: string;
  leaf_state: CalibrationLeafState;
  observer_notes: string;
}

export interface CalibrationPredictionInput {
  pilotArea: CalibrationPilotAreaId;
  plannedPointId: string;
  siteType: CalibrationSiteType;
  latitude: number;
  longitude: number;
  pavementSide: CalibrationPavementSide;
  observedLondonDateTime: string;
  predictedState: CalibrationPredictedState;
  /** Reported by one getCurrentPosition call; never used as a tracking identifier. */
  locationAccuracyMetres?: number;
}

export interface CalibrationModelPredictionRequest {
  pilotArea: CalibrationPilotAreaId;
  latitude: number;
  longitude: number;
  observedLondonDateTime: string;
}

export interface FrozenCalibrationPrediction extends CalibrationPredictionInput {
  schema: typeof FIELD_CALIBRATION_SCHEMA;
  schemaVersion: typeof FIELD_CALIBRATION_SCHEMA_VERSION;
  protocolVersion: typeof FIELD_CALIBRATION_PROTOCOL_VERSION;
  modelVersion: typeof FIELD_CALIBRATION_MODEL_VERSION;
  dataPackVersion: typeof FIELD_CALIBRATION_DATA_PACK_VERSION;
  dataPackFingerprint: string;
  coordinateSource: CalibrationCoordinateSource;
  predictionFrozen: true;
  predictionFrozenAt: string;
}

export interface CalibrationObservationInput {
  weatherVisibility: CalibrationWeatherVisibility;
  observedState: CalibrationObservedState;
  temporaryConditions?: string;
  leafState: CalibrationLeafState;
  observerNotes?: string;
}

export interface CalibrationStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CalibrationEnvelope {
  schemaVersion: typeof FIELD_CALIBRATION_SCHEMA_VERSION;
  observations: CalibrationObservation[];
}

export type CalibrationSnapshotStatus = "empty" | "readable" | "unreadable";

const PAVEMENT_SIDES = new Set<CalibrationPavementSide>(["left", "right", "centre"]);
const WEATHER_VALUES = new Set<CalibrationWeatherVisibility>([
  "clear-direct-sun",
  "intermittent-sun",
  "overcast",
]);
const OBSERVED_STATES = new Set<CalibrationObservedState>(["sun", "shade"]);
const PREDICTED_STATES = new Set<CalibrationPredictedState>([
  "sun",
  "shade",
  "uncertain",
  "unknown",
  "night",
]);
const LEAF_STATES = new Set<CalibrationLeafState>([
  "leaf-on",
  "partial",
  "leaf-off",
  "not-applicable",
]);
const SITE_TYPES = new Set<CalibrationSiteType>(CALIBRATION_SITE_TYPES);
const COORDINATE_SOURCES = new Set<CalibrationCoordinateSource>(["manual", "one-shot-gps"]);
const PILOT_AREA_IDS = new Set<CalibrationPilotAreaId>(CALIBRATION_PILOT_AREA_IDS);
const SAFE_POINT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,119}$/;
const SHA256_FINGERPRINT = /^sha256-[0-9a-f]{64}$/;

function browserStorage(): CalibrationStorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage?: CalibrationStorageLike | null) {
  return storage === undefined ? browserStorage() : storage;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedText(value: unknown, maxLength: number, allowEmpty = false) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if ((!cleaned && !allowEmpty) || cleaned.length > maxLength) return null;
  return cleaned;
}

function validLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

function validLongitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

function validAccuracy(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000;
}

function normaliseCoordinate(value: number) {
  return Number(value.toFixed(7));
}

function normaliseAccuracy(value: number) {
  return Number(value.toFixed(1));
}

export function isCalibrationPilotAreaId(value: unknown): value is CalibrationPilotAreaId {
  return typeof value === "string" && PILOT_AREA_IDS.has(value as CalibrationPilotAreaId);
}

function coordinateInsidePilotBoundary(
  pilotArea: CalibrationPilotAreaId,
  latitude: number,
  longitude: number,
  boundaries: readonly CalibrationPilotBoundary[],
) {
  const boundary = boundaries.find((candidate) => candidate.id === pilotArea);
  if (!boundary) return false;
  const [west, south, east, north] = boundary.bbox;
  return (
    [west, south, east, north].every(Number.isFinite) &&
    west <= east &&
    south <= north &&
    longitude >= west &&
    longitude <= east &&
    latitude >= south &&
    latitude <= north
  );
}

/**
 * Validates and freezes the exact model lookup inputs before any physical-state
 * controls can be shown. The boundary comes from the loaded pilot data so the
 * model and the field record use the same selected area.
 */
export function prepareCalibrationModelPredictionRequest(
  input: {
    pilotArea: unknown;
    latitude: number;
    longitude: number;
    observedLondonDateTime: string;
  },
  pilotAreas: readonly CalibrationPilotBoundary[],
): Readonly<CalibrationModelPredictionRequest> {
  if (!isCalibrationPilotAreaId(input.pilotArea)) {
    throw new Error("Choose one of the two ShadeRoute pilot areas.");
  }
  if (!validLatitude(input.latitude) || !validLongitude(input.longitude)) {
    throw new Error("Enter a valid latitude and longitude for the physical observation point.");
  }
  if (!parseLondonDateTime(input.observedLondonDateTime)) {
    throw new Error("Enter a valid observation date and time in Europe/London.");
  }

  const pilotArea = pilotAreas.find((candidate) => candidate.id === input.pilotArea);
  if (!pilotArea) {
    throw new Error("The selected pilot boundary is unavailable. Reload ShadeRoute and try again.");
  }
  const [west, south, east, north] = pilotArea.bbox;
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west > east ||
    south > north
  ) {
    throw new Error("The selected pilot boundary is invalid. Reload ShadeRoute and try again.");
  }
  if (
    input.longitude < west ||
    input.longitude > east ||
    input.latitude < south ||
    input.latitude > north
  ) {
    throw new Error("Choose an observation point inside the selected pilot area.");
  }
  if (!coordinateInsidePilotBoundary(
    input.pilotArea,
    input.latitude,
    input.longitude,
    CALIBRATION_PILOT_BOUNDARIES,
  )) {
    throw new Error("Choose an observation point inside the selected pilot area.");
  }

  return Object.freeze({
    pilotArea: input.pilotArea,
    latitude: normaliseCoordinate(input.latitude),
    longitude: normaliseCoordinate(input.longitude),
    observedLondonDateTime: input.observedLondonDateTime,
  });
}

function cleanObservation(value: unknown): CalibrationObservation | null {
  if (!isPlainObject(value) || !hasExactKeys(value, FIELD_CALIBRATION_COLUMNS)) return null;

  const observationId = boundedText(value.observation_id, 120);
  const pilotArea = boundedText(value.pilot_area, 80);
  const plannedPointId = boundedText(value.planned_point_id, 120);
  const temporaryConditions = boundedText(value.temporary_conditions, 500, true);
  const observerNotes = boundedText(value.observer_notes, 1_000, true);
  if (
    value.schema !== FIELD_CALIBRATION_SCHEMA ||
    value.schema_version !== FIELD_CALIBRATION_SCHEMA_VERSION ||
    value.protocol_version !== FIELD_CALIBRATION_PROTOCOL_VERSION ||
    typeof value.model_version !== "string" ||
    !SAFE_VERSION.test(value.model_version) ||
    typeof value.data_pack_version !== "string" ||
    !SAFE_VERSION.test(value.data_pack_version) ||
    typeof value.data_pack_fingerprint !== "string" ||
    !SHA256_FINGERPRINT.test(value.data_pack_fingerprint) ||
    !observationId ||
    !pilotArea ||
    !isCalibrationPilotAreaId(pilotArea) ||
    !plannedPointId ||
    !SAFE_POINT_ID.test(plannedPointId) ||
    !SITE_TYPES.has(value.site_type as CalibrationSiteType) ||
    temporaryConditions === null ||
    observerNotes === null ||
    !validLatitude(value.latitude) ||
    !validLongitude(value.longitude) ||
    !coordinateInsidePilotBoundary(pilotArea, value.latitude, value.longitude, CALIBRATION_PILOT_BOUNDARIES) ||
    !COORDINATE_SOURCES.has(value.coordinate_source as CalibrationCoordinateSource) ||
    !(value.gps_accuracy_metres === null || validAccuracy(value.gps_accuracy_metres)) ||
    (value.coordinate_source === "manual" && value.gps_accuracy_metres !== null) ||
    (value.coordinate_source === "one-shot-gps" && !validAccuracy(value.gps_accuracy_metres)) ||
    !PAVEMENT_SIDES.has(value.pavement_side as CalibrationPavementSide) ||
    typeof value.observed_london_datetime !== "string" ||
    !parseLondonDateTime(value.observed_london_datetime) ||
    !WEATHER_VALUES.has(value.weather_visibility as CalibrationWeatherVisibility) ||
    !OBSERVED_STATES.has(value.observed_state as CalibrationObservedState) ||
    !PREDICTED_STATES.has(value.predicted_state as CalibrationPredictedState) ||
    value.predicted_before_observation !== true ||
    !LEAF_STATES.has(value.leaf_state as CalibrationLeafState)
  ) {
    return null;
  }

  const candidate: CalibrationObservation = {
    schema: FIELD_CALIBRATION_SCHEMA,
    schema_version: FIELD_CALIBRATION_SCHEMA_VERSION,
    protocol_version: FIELD_CALIBRATION_PROTOCOL_VERSION,
    model_version: value.model_version,
    data_pack_version: value.data_pack_version,
    data_pack_fingerprint: value.data_pack_fingerprint,
    observation_id: observationId,
    pilot_area: pilotArea,
    planned_point_id: plannedPointId,
    site_type: value.site_type as CalibrationSiteType,
    latitude: normaliseCoordinate(value.latitude),
    longitude: normaliseCoordinate(value.longitude),
    coordinate_source: value.coordinate_source as CalibrationCoordinateSource,
    gps_accuracy_metres: value.gps_accuracy_metres === null
      ? null
      : normaliseAccuracy(value.gps_accuracy_metres),
    pavement_side: value.pavement_side as CalibrationPavementSide,
    observed_london_datetime: value.observed_london_datetime,
    weather_visibility: value.weather_visibility as CalibrationWeatherVisibility,
    observed_state: value.observed_state as CalibrationObservedState,
    predicted_state: value.predicted_state as CalibrationPredictedState,
    predicted_before_observation: true,
    temporary_conditions: temporaryConditions,
    leaf_state: value.leaf_state as CalibrationLeafState,
    observer_notes: observerNotes,
  };

  // Persisted data is strict rather than silently repaired or truncated.
  return FIELD_CALIBRATION_COLUMNS.every((key) => Object.is(candidate[key], value[key]))
    ? candidate
    : null;
}

function cleanEnvelope(value: unknown): CalibrationEnvelope | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["schemaVersion", "observations"])) return null;
  if (value.schemaVersion !== FIELD_CALIBRATION_SCHEMA_VERSION || !Array.isArray(value.observations)) {
    return null;
  }
  if (value.observations.length > FIELD_CALIBRATION_MAX_OBSERVATIONS) return null;
  const observations = value.observations.map(cleanObservation);
  if (observations.some((observation) => observation === null)) return null;
  const typed = observations as CalibrationObservation[];
  if (new Set(typed.map((observation) => observation.observation_id)).size !== typed.length) return null;
  return { schemaVersion: FIELD_CALIBRATION_SCHEMA_VERSION, observations: typed };
}

function parseEnvelope(raw: string | null): CalibrationEnvelope | null {
  if (!raw) return { schemaVersion: FIELD_CALIBRATION_SCHEMA_VERSION, observations: [] };
  if (new TextEncoder().encode(raw).byteLength > FIELD_CALIBRATION_MAX_IMPORT_BYTES) return null;
  try {
    return cleanEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeEnvelope(storage: CalibrationStorageLike, observations: CalibrationObservation[]) {
  try {
    storage.setItem(
      FIELD_CALIBRATION_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: FIELD_CALIBRATION_SCHEMA_VERSION,
        observations,
      } satisfies CalibrationEnvelope),
    );
  } catch {
    throw new Error("Browser storage is unavailable or full. Nothing was saved.");
  }
}

function requireReadableEnvelope(storage: CalibrationStorageLike) {
  let raw: string | null;
  try {
    raw = storage.getItem(FIELD_CALIBRATION_STORAGE_KEY);
  } catch {
    throw new Error("Browser storage is unavailable. Nothing was changed.");
  }
  const envelope = parseEnvelope(raw);
  if (!envelope) {
    throw new Error("Existing on-device calibration data could not be read. Clear it before saving changes.");
  }
  return envelope;
}

export function calibrationSnapshotStatus(raw: string | null): CalibrationSnapshotStatus {
  if (!raw) return "empty";
  return parseEnvelope(raw) ? "readable" : "unreadable";
}

export function freezeCalibrationPrediction(
  input: CalibrationPredictionInput,
  now: Date | string = new Date(),
): FrozenCalibrationPrediction {
  const pilotArea = boundedText(input.pilotArea, 80);
  if (!pilotArea || !isCalibrationPilotAreaId(pilotArea)) {
    throw new Error("Choose one of the two ShadeRoute pilot areas before freezing the prediction.");
  }
  if (!validLatitude(input.latitude) || !validLongitude(input.longitude)) {
    throw new Error("Enter a valid latitude and longitude for the physical observation point.");
  }
  if (!coordinateInsidePilotBoundary(
    pilotArea,
    input.latitude,
    input.longitude,
    CALIBRATION_PILOT_BOUNDARIES,
  )) {
    throw new Error("Choose an observation point inside the selected pilot area.");
  }
  if (!PAVEMENT_SIDES.has(input.pavementSide)) {
    throw new Error("Choose the side of pavement before freezing the prediction.");
  }
  if (!parseLondonDateTime(input.observedLondonDateTime)) {
    throw new Error("Enter a valid observation date and time in Europe/London.");
  }
  if (!PREDICTED_STATES.has(input.predictedState)) {
    throw new Error("Record the model prediction before freezing it.");
  }
  const plannedPointId = boundedText(input.plannedPointId, 120);
  if (!plannedPointId || !SAFE_POINT_ID.test(plannedPointId)) {
    throw new Error("Enter the planned fixed-point identifier.");
  }
  if (!SITE_TYPES.has(input.siteType)) {
    throw new Error("Choose the planned fixed-point site type.");
  }
  if (input.locationAccuracyMetres !== undefined && !validAccuracy(input.locationAccuracyMetres)) {
    throw new Error("The reported GPS accuracy is invalid. Enter the point manually instead.");
  }
  const frozenAt = new Date(now);
  if (!Number.isFinite(frozenAt.getTime())) throw new Error("The prediction freeze time is invalid.");

  return Object.freeze({
    schema: FIELD_CALIBRATION_SCHEMA,
    schemaVersion: FIELD_CALIBRATION_SCHEMA_VERSION,
    protocolVersion: FIELD_CALIBRATION_PROTOCOL_VERSION,
    modelVersion: FIELD_CALIBRATION_MODEL_VERSION,
    dataPackVersion: FIELD_CALIBRATION_DATA_PACK_VERSION,
    dataPackFingerprint: FIELD_CALIBRATION_DATA_PACK_FINGERPRINTS[pilotArea],
    pilotArea,
    plannedPointId,
    siteType: input.siteType,
    latitude: normaliseCoordinate(input.latitude),
    longitude: normaliseCoordinate(input.longitude),
    pavementSide: input.pavementSide,
    observedLondonDateTime: input.observedLondonDateTime,
    predictedState: input.predictedState,
    ...(input.locationAccuracyMetres === undefined
      ? {}
      : { locationAccuracyMetres: normaliseAccuracy(input.locationAccuracyMetres) }),
    coordinateSource: input.locationAccuracyMetres === undefined ? "manual" : "one-shot-gps",
    predictionFrozen: true as const,
    predictionFrozenAt: frozenAt.toISOString(),
  });
}

function cleanObserverNotes(notes: string) {
  const cleanNotes = boundedText(notes, 1_000, true);
  if (cleanNotes === null) throw new Error("Observer notes are too long.");
  return cleanNotes;
}

export function createCalibrationObservation(
  prediction: FrozenCalibrationPrediction,
  input: CalibrationObservationInput,
  observationId = globalThis.crypto?.randomUUID?.(),
): CalibrationObservation {
  if (!prediction || prediction.predictionFrozen !== true || !prediction.predictionFrozenAt) {
    throw new Error("Freeze the model prediction before entering an observation.");
  }
  if (
    prediction.schema !== FIELD_CALIBRATION_SCHEMA ||
    prediction.schemaVersion !== FIELD_CALIBRATION_SCHEMA_VERSION ||
    prediction.protocolVersion !== FIELD_CALIBRATION_PROTOCOL_VERSION ||
    prediction.modelVersion !== FIELD_CALIBRATION_MODEL_VERSION ||
    prediction.dataPackVersion !== FIELD_CALIBRATION_DATA_PACK_VERSION ||
    !isCalibrationPilotAreaId(prediction.pilotArea) ||
    prediction.dataPackFingerprint !== FIELD_CALIBRATION_DATA_PACK_FINGERPRINTS[prediction.pilotArea]
  ) {
    throw new Error("The frozen prediction is not bound to this calibration release.");
  }
  const verifiedPrediction = freezeCalibrationPrediction(
    prediction,
    prediction.predictionFrozenAt,
  );
  const frozenKeys = [
    "pilotArea",
    "plannedPointId",
    "siteType",
    "latitude",
    "longitude",
    "pavementSide",
    "observedLondonDateTime",
    "predictedState",
    "locationAccuracyMetres",
    "coordinateSource",
    "predictionFrozenAt",
  ] as const;
  if (frozenKeys.some((key) => !Object.is(verifiedPrediction[key], prediction[key]))) {
    throw new Error("The frozen prediction is incomplete or has been changed.");
  }
  const id = boundedText(observationId, 120);
  const temporaryConditions = boundedText(input.temporaryConditions ?? "", 500, true);
  if (!id) throw new Error("The observation identifier is invalid.");
  if (!WEATHER_VALUES.has(input.weatherVisibility)) throw new Error("Record the visible-sun conditions.");
  if (!OBSERVED_STATES.has(input.observedState)) throw new Error("Record sun or shade at the point.");
  if (!LEAF_STATES.has(input.leafState)) throw new Error("Record the leaf state.");
  if (temporaryConditions === null) throw new Error("Temporary conditions are too long.");

  return {
    schema: verifiedPrediction.schema,
    schema_version: verifiedPrediction.schemaVersion,
    protocol_version: verifiedPrediction.protocolVersion,
    model_version: verifiedPrediction.modelVersion,
    data_pack_version: verifiedPrediction.dataPackVersion,
    data_pack_fingerprint: verifiedPrediction.dataPackFingerprint,
    observation_id: id,
    pilot_area: verifiedPrediction.pilotArea,
    planned_point_id: verifiedPrediction.plannedPointId,
    site_type: verifiedPrediction.siteType,
    latitude: verifiedPrediction.latitude,
    longitude: verifiedPrediction.longitude,
    coordinate_source: verifiedPrediction.coordinateSource,
    gps_accuracy_metres: verifiedPrediction.locationAccuracyMetres ?? null,
    pavement_side: verifiedPrediction.pavementSide,
    observed_london_datetime: verifiedPrediction.observedLondonDateTime,
    weather_visibility: input.weatherVisibility,
    observed_state: input.observedState,
    predicted_state: verifiedPrediction.predictedState,
    predicted_before_observation: true,
    temporary_conditions: temporaryConditions,
    leaf_state: input.leafState,
    observer_notes: cleanObserverNotes(input.observerNotes ?? ""),
  };
}

export function readCalibrationObservations(
  storage?: CalibrationStorageLike | null,
): CalibrationObservation[] {
  const target = resolveStorage(storage);
  if (!target) return [];
  try {
    const envelope = parseEnvelope(target.getItem(FIELD_CALIBRATION_STORAGE_KEY));
    return envelope?.observations ?? [];
  } catch {
    return [];
  }
}

export function saveCalibrationObservation(
  observation: CalibrationObservation,
  storage?: CalibrationStorageLike | null,
) {
  const target = resolveStorage(storage);
  if (!target) throw new Error("Browser storage is unavailable. Nothing was saved.");
  const clean = cleanObservation(observation);
  if (!clean) throw new Error("The calibration observation is incomplete or invalid.");
  const envelope = requireReadableEnvelope(target);
  if (envelope.observations.some((item) => item.observation_id === clean.observation_id)) {
    throw new Error("An observation with this identifier already exists. Nothing was overwritten.");
  }
  if (envelope.observations.length >= FIELD_CALIBRATION_MAX_OBSERVATIONS) {
    throw new Error(`This browser already holds ${FIELD_CALIBRATION_MAX_OBSERVATIONS} calibration observations. Export and clear them before adding more.`);
  }
  const observations = [...envelope.observations, clean];
  writeEnvelope(target, observations);
  return observations;
}

export function deleteCalibrationObservation(
  observationId: string,
  storage?: CalibrationStorageLike | null,
) {
  const target = resolveStorage(storage);
  if (!target) throw new Error("Browser storage is unavailable. Nothing was removed.");
  const envelope = requireReadableEnvelope(target);
  const observations = envelope.observations.filter((item) => item.observation_id !== observationId);
  if (observations.length === 0) {
    try {
      target.removeItem(FIELD_CALIBRATION_STORAGE_KEY);
    } catch {
      throw new Error("Browser storage is unavailable. Nothing was removed.");
    }
  } else {
    writeEnvelope(target, observations);
  }
  return observations;
}

export function clearCalibrationObservations(storage?: CalibrationStorageLike | null) {
  const target = resolveStorage(storage);
  if (!target) throw new Error("Browser storage is unavailable. Nothing was removed.");
  try {
    target.removeItem(FIELD_CALIBRATION_STORAGE_KEY);
  } catch {
    throw new Error("Browser storage is unavailable. Nothing was removed.");
  }
}

function csvCell(value: string | number | true | null) {
  if (value === null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function calibrationObservationsToCsv(observations: CalibrationObservation[]) {
  if (observations.length > FIELD_CALIBRATION_MAX_OBSERVATIONS) {
    throw new Error("Too many calibration observations to export.");
  }
  const clean = observations.map(cleanObservation);
  if (clean.some((observation) => observation === null)) {
    throw new Error("The calibration observations are incomplete or invalid.");
  }
  const rows = (clean as CalibrationObservation[]).map((observation) =>
    FIELD_CALIBRATION_COLUMNS.map((key) => csvCell(observation[key])).join(","),
  );
  return `${FIELD_CALIBRATION_COLUMNS.join(",")}\n${rows.length ? `${rows.join("\n")}\n` : ""}`;
}

function parseCsvRows(raw: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quoted) {
      if (character === '"') {
        if (raw[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (afterQuote && character !== "," && character !== "\n" && character !== "\r") return null;
    if (character === '"') {
      if (cell || afterQuote) return null;
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
      afterQuote = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && raw[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
      afterQuote = false;
    } else {
      cell += character;
    }
  }
  if (quoted) return null;
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

export function parseCalibrationCsv(raw: unknown): CalibrationObservation[] | null {
  if (typeof raw !== "string") return null;
  const byteLength = new TextEncoder().encode(raw).byteLength;
  if (!raw || byteLength > FIELD_CALIBRATION_MAX_IMPORT_BYTES) return null;
  const rows = parseCsvRows(raw.replace(/^\uFEFF/, ""));
  if (!rows?.length || rows.length - 1 > FIELD_CALIBRATION_MAX_OBSERVATIONS) return null;
  if (
    rows[0].length !== FIELD_CALIBRATION_COLUMNS.length ||
    !FIELD_CALIBRATION_COLUMNS.every((column, index) => rows[0][index] === column)
  ) {
    return null;
  }

  const observations = rows.slice(1).map((row) => {
    if (row.length !== FIELD_CALIBRATION_COLUMNS.length) return null;
    const value: Record<string, unknown> = Object.fromEntries(
      FIELD_CALIBRATION_COLUMNS.map((column, index) => [column, row[index]]),
    );
    value.latitude = Number(value.latitude);
    value.longitude = Number(value.longitude);
    value.schema_version = Number(value.schema_version);
    value.gps_accuracy_metres = value.gps_accuracy_metres === ""
      ? null
      : Number(value.gps_accuracy_metres);
    value.predicted_before_observation = value.predicted_before_observation === "true";
    return cleanObservation(value);
  });
  if (observations.some((observation) => observation === null)) return null;
  const typed = observations as CalibrationObservation[];
  if (new Set(typed.map((observation) => observation.observation_id)).size !== typed.length) return null;
  return typed;
}

export function importCalibrationCsv(raw: unknown, storage?: CalibrationStorageLike | null) {
  const imported = parseCalibrationCsv(raw);
  if (!imported) throw new Error("The CSV does not match the fixed-point calibration schema.");
  const target = resolveStorage(storage);
  if (!target) throw new Error("Browser storage is unavailable. Nothing was imported.");
  const envelope = requireReadableEnvelope(target);
  const existingIds = new Set(envelope.observations.map((observation) => observation.observation_id));
  if (imported.some((observation) => existingIds.has(observation.observation_id))) {
    throw new Error("The CSV contains an observation already stored here. Nothing was imported.");
  }
  if (envelope.observations.length + imported.length > FIELD_CALIBRATION_MAX_OBSERVATIONS) {
    throw new Error(`Import would exceed the ${FIELD_CALIBRATION_MAX_OBSERVATIONS}-observation on-device limit. Nothing was imported.`);
  }
  const observations = [...envelope.observations, ...imported];
  writeEnvelope(target, observations);
  return { importedCount: imported.length, observations };
}
