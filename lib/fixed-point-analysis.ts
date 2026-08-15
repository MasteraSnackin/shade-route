import {
  CALIBRATION_PILOT_AREA_IDS,
  CALIBRATION_SITE_TYPES,
  FIELD_CALIBRATION_PROTOCOL_VERSION,
  calibrationObservationsToCsv,
  parseCalibrationCsv,
  type CalibrationObservation,
  type CalibrationPilotAreaId,
  type CalibrationSiteType,
} from "./field-calibration.ts";

export const FIXED_POINT_THRESHOLD_SCHEMA =
  "uk.shaderoute.fixed-point-threshold-plan" as const;
export const FIXED_POINT_THRESHOLD_SCHEMA_VERSION = 1 as const;

export type CalibrationTimeBandId = "morning" | "solar-noon" | "late-afternoon";

export interface FixedPointTimeBand {
  id: CalibrationTimeBandId;
  start_hour_inclusive: number;
  end_hour_exclusive: number;
}

export interface FixedPointThresholdPlan {
  schema: typeof FIXED_POINT_THRESHOLD_SCHEMA;
  schema_version: typeof FIXED_POINT_THRESHOLD_SCHEMA_VERSION;
  registration_status: "pre-specified-template-no-observations";
  specified_on: string;
  protocol_version: typeof FIELD_CALIBRATION_PROTOCOL_VERSION;
  model_version: string;
  data_pack_version: string;
  data_pack_fingerprints: Record<CalibrationPilotAreaId, string>;
  required_pilot_areas: CalibrationPilotAreaId[];
  required_site_types: CalibrationSiteType[];
  time_bands: FixedPointTimeBand[];
  minimum_unique_points_per_pilot: number;
  minimum_observations_per_pilot_time_band: number;
  maximum_gps_accuracy_metres: number;
  maximum_point_repeat_distance_metres: number;
  minimum_total_eligible_observations: number;
  minimum_classification_agreement_percent: number;
  minimum_per_pilot_classification_agreement_percent: number;
  maximum_unclassified_prediction_rate_percent: number;
}

export interface FixedPointPilotAnalysis {
  pilotArea: CalibrationPilotAreaId;
  eligibleObservationCount: number;
  classifiableObservationCount: number;
  matchingObservationCount: number;
  classificationAgreementPercent: number | null;
  unclassifiedPredictionCount: number;
  unclassifiedPredictionRatePercent: number | null;
  uniquePlannedPointCount: number;
  completeRepeatedPointCount: number;
  pointRepeatDistanceFailureCount: number;
  representedSiteTypes: CalibrationSiteType[];
  completeRepeatedSiteTypes: CalibrationSiteType[];
  observationsByTimeBand: Record<CalibrationTimeBandId, number>;
}

export interface FixedPointCalibrationAnalysis {
  evidenceStatus:
    | "no-observations"
    | "insufficient-evidence"
    | "thresholds-not-met"
    | "fixed-point-thresholds-met";
  fixedPointGateMet: boolean | null;
  canClaimModelAccuracy: false;
  totalObservationCount: number;
  eligibleObservationCount: number;
  classifiableObservationCount: number;
  matchingObservationCount: number;
  classificationAgreementPercent: number | null;
  unclassifiedPredictionCount: number;
  unclassifiedPredictionRatePercent: number | null;
  excludedObservationCounts: {
    releaseIdentityMismatch: number;
    nonClearSunConditions: number;
    gpsAccuracyAboveThreshold: number;
    outsideRegisteredTimeBands: number;
  };
  failureCodes: string[];
  pilots: FixedPointPilotAnalysis[];
}

export type FixedPointCalibrationResult =
  | { status: "invalid"; observations: null; thresholdPlan: null; analysis: null }
  | {
      status: "empty" | "analysed";
      observations: CalibrationObservation[];
      thresholdPlan: FixedPointThresholdPlan;
      analysis: FixedPointCalibrationAnalysis;
    };

const PLAN_KEYS = [
  "schema",
  "schema_version",
  "registration_status",
  "specified_on",
  "protocol_version",
  "model_version",
  "data_pack_version",
  "data_pack_fingerprints",
  "required_pilot_areas",
  "required_site_types",
  "time_bands",
  "minimum_unique_points_per_pilot",
  "minimum_observations_per_pilot_time_band",
  "maximum_gps_accuracy_metres",
  "maximum_point_repeat_distance_metres",
  "minimum_total_eligible_observations",
  "minimum_classification_agreement_percent",
  "minimum_per_pilot_classification_agreement_percent",
  "maximum_unclassified_prediction_rate_percent",
] as const;

const TIME_BAND_KEYS = ["id", "start_hour_inclusive", "end_hour_exclusive"] as const;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,119}$/;
const SHA256_FINGERPRINT = /^sha256-[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isExactSet<T extends string>(value: unknown, expected: readonly T[]): value is T[] {
  return Array.isArray(value) &&
    value.length === expected.length &&
    new Set(value).size === value.length &&
    expected.every((item) => value.includes(item));
}

function validPercentage(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validPositiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function validDataPackFingerprints(value: unknown): value is Record<CalibrationPilotAreaId, string> {
  return isPlainObject(value) &&
    hasExactKeys(value, CALIBRATION_PILOT_AREA_IDS) &&
    CALIBRATION_PILOT_AREA_IDS.every((area) =>
      typeof value[area] === "string" && SHA256_FINGERPRINT.test(value[area] as string)
    );
}

/** Fails closed; threshold files are never repaired or assigned defaults. */
export function parseFixedPointThresholdPlan(value: unknown): FixedPointThresholdPlan | null {
  try {
    if (!isPlainObject(value) || !hasExactKeys(value, PLAN_KEYS)) return null;
    if (
      value.schema !== FIXED_POINT_THRESHOLD_SCHEMA ||
      value.schema_version !== FIXED_POINT_THRESHOLD_SCHEMA_VERSION ||
      value.registration_status !== "pre-specified-template-no-observations" ||
      !validIsoDate(value.specified_on) ||
      value.protocol_version !== FIELD_CALIBRATION_PROTOCOL_VERSION ||
      typeof value.model_version !== "string" ||
      !SAFE_VERSION.test(value.model_version) ||
      typeof value.data_pack_version !== "string" ||
      !SAFE_VERSION.test(value.data_pack_version) ||
      !isExactSet(value.required_pilot_areas, CALIBRATION_PILOT_AREA_IDS) ||
      !isExactSet(value.required_site_types, CALIBRATION_SITE_TYPES) ||
      !validPositiveInteger(value.minimum_unique_points_per_pilot) ||
      !validPositiveInteger(value.minimum_observations_per_pilot_time_band) ||
      typeof value.maximum_gps_accuracy_metres !== "number" ||
      !Number.isFinite(value.maximum_gps_accuracy_metres) ||
      value.maximum_gps_accuracy_metres <= 0 ||
      typeof value.maximum_point_repeat_distance_metres !== "number" ||
      !Number.isFinite(value.maximum_point_repeat_distance_metres) ||
      value.maximum_point_repeat_distance_metres <= 0 ||
      !validPositiveInteger(value.minimum_total_eligible_observations) ||
      !validPercentage(value.minimum_classification_agreement_percent) ||
      !validPercentage(value.minimum_per_pilot_classification_agreement_percent) ||
      !validPercentage(value.maximum_unclassified_prediction_rate_percent) ||
      !validDataPackFingerprints(value.data_pack_fingerprints) ||
      !Array.isArray(value.time_bands) ||
      value.time_bands.length !== 3
    ) return null;

    const timeBands = value.time_bands as unknown[];
    const expectedIds: CalibrationTimeBandId[] = ["morning", "solar-noon", "late-afternoon"];
    if (timeBands.some((band) =>
      !isPlainObject(band) ||
      !hasExactKeys(band, TIME_BAND_KEYS) ||
      !expectedIds.includes(band.id as CalibrationTimeBandId) ||
      !Number.isInteger(band.start_hour_inclusive) ||
      !Number.isInteger(band.end_hour_exclusive) ||
      Number(band.start_hour_inclusive) < 0 ||
      Number(band.end_hour_exclusive) > 24 ||
      Number(band.start_hour_inclusive) >= Number(band.end_hour_exclusive)
    )) return null;
    const typedBands = timeBands as FixedPointTimeBand[];
    if (!isExactSet(typedBands.map((band) => band.id), expectedIds)) return null;
    const ordered = [...typedBands].sort(
      (left, right) => left.start_hour_inclusive - right.start_hour_inclusive,
    );
    if (ordered.some((band, index) =>
      index > 0 && band.start_hour_inclusive < ordered[index - 1].end_hour_exclusive
    )) return null;

    const dataPackFingerprints = value.data_pack_fingerprints as Record<string, unknown>;
    return {
      ...(value as unknown as FixedPointThresholdPlan),
      required_pilot_areas: [...value.required_pilot_areas],
      required_site_types: [...value.required_site_types],
      time_bands: typedBands.map((band) => ({ ...band })),
      data_pack_fingerprints: {
        waterloo: dataPackFingerprints.waterloo as string,
        "kings-cross": dataPackFingerprints["kings-cross"] as string,
      },
    };
  } catch {
    return null;
  }
}

function round(value: number) {
  return Math.round((value + Number.EPSILON) * 1_000) / 1_000;
}

function percentage(numerator: number, denominator: number) {
  return denominator === 0 ? null : round((numerator / denominator) * 100);
}

function timeBandFor(
  londonDateTime: string,
  bands: readonly FixedPointTimeBand[],
): CalibrationTimeBandId | null {
  const hour = Number(londonDateTime.slice(11, 13));
  const band = bands.find(
    (candidate) => hour >= candidate.start_hour_inclusive && hour < candidate.end_hour_exclusive,
  );
  return band?.id ?? null;
}

function distanceMetres(
  left: readonly [latitude: number, longitude: number],
  right: readonly [latitude: number, longitude: number],
) {
  const radians = Math.PI / 180;
  const latitudeDelta = (right[0] - left[0]) * radians;
  const longitudeDelta = (right[1] - left[1]) * radians;
  const leftLatitude = left[0] * radians;
  const rightLatitude = right[0] * radians;
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function pointHasExcessiveCoordinateSpread(
  coordinates: readonly (readonly [number, number])[],
  maximumDistanceMetres: number,
) {
  for (let left = 0; left < coordinates.length; left += 1) {
    for (let right = left + 1; right < coordinates.length; right += 1) {
      if (distanceMetres(coordinates[left], coordinates[right]) > maximumDistanceMetres) {
        return true;
      }
    }
  }
  return false;
}

function strictObservationArray(value: unknown) {
  try {
    if (!Array.isArray(value)) return null;
    return parseCalibrationCsv(calibrationObservationsToCsv(value as CalibrationObservation[]));
  } catch {
    return null;
  }
}

function emptyPilot(area: CalibrationPilotAreaId): FixedPointPilotAnalysis {
  return {
    pilotArea: area,
    eligibleObservationCount: 0,
    classifiableObservationCount: 0,
    matchingObservationCount: 0,
    classificationAgreementPercent: null,
    unclassifiedPredictionCount: 0,
    unclassifiedPredictionRatePercent: null,
    uniquePlannedPointCount: 0,
    completeRepeatedPointCount: 0,
    pointRepeatDistanceFailureCount: 0,
    representedSiteTypes: [],
    completeRepeatedSiteTypes: [],
    observationsByTimeBand: { morning: 0, "solar-noon": 0, "late-afternoon": 0 },
  };
}

function analyseCleanObservations(
  observations: CalibrationObservation[],
  plan: FixedPointThresholdPlan,
): FixedPointCalibrationAnalysis {
  const pilots = new Map(
    plan.required_pilot_areas.map((area) => [area, emptyPilot(area)]),
  );
  const pointBands = new Map<string, Set<CalibrationTimeBandId>>();
  const pointCoordinates = new Map<string, Array<readonly [number, number]>>();
  const pointSiteTypes = new Map<string, CalibrationSiteType>();
  const excluded = {
    releaseIdentityMismatch: 0,
    nonClearSunConditions: 0,
    gpsAccuracyAboveThreshold: 0,
    outsideRegisteredTimeBands: 0,
  };

  const sorted = [...observations].sort((left, right) =>
    left.pilot_area.localeCompare(right.pilot_area) ||
    left.observed_london_datetime.localeCompare(right.observed_london_datetime) ||
    left.observation_id.localeCompare(right.observation_id)
  );

  let structurallyContradictory = false;
  for (const observation of sorted) {
    const expectedFingerprint = plan.data_pack_fingerprints[observation.pilot_area];
    if (
      observation.protocol_version !== plan.protocol_version ||
      observation.model_version !== plan.model_version ||
      observation.data_pack_version !== plan.data_pack_version ||
      observation.data_pack_fingerprint !== expectedFingerprint
    ) {
      excluded.releaseIdentityMismatch += 1;
      continue;
    }
    const pointKey = `${observation.pilot_area}\u0000${observation.planned_point_id}`;
    const existingSiteType = pointSiteTypes.get(pointKey);
    if (existingSiteType && existingSiteType !== observation.site_type) {
      structurallyContradictory = true;
      continue;
    }
    pointSiteTypes.set(pointKey, observation.site_type);
    if (observation.weather_visibility !== "clear-direct-sun") {
      excluded.nonClearSunConditions += 1;
      continue;
    }
    if (
      observation.coordinate_source === "one-shot-gps" &&
      Number(observation.gps_accuracy_metres) > plan.maximum_gps_accuracy_metres
    ) {
      excluded.gpsAccuracyAboveThreshold += 1;
      continue;
    }
    const timeBand = timeBandFor(observation.observed_london_datetime, plan.time_bands);
    if (!timeBand) {
      excluded.outsideRegisteredTimeBands += 1;
      continue;
    }

    const pilot = pilots.get(observation.pilot_area);
    if (!pilot) {
      structurallyContradictory = true;
      continue;
    }
    const bands = pointBands.get(pointKey) ?? new Set<CalibrationTimeBandId>();
    bands.add(timeBand);
    pointBands.set(pointKey, bands);
    const coordinates = pointCoordinates.get(pointKey) ?? [];
    coordinates.push([observation.latitude, observation.longitude]);
    pointCoordinates.set(pointKey, coordinates);

    pilot.eligibleObservationCount += 1;
    pilot.observationsByTimeBand[timeBand] += 1;
    if (!pilot.representedSiteTypes.includes(observation.site_type)) {
      pilot.representedSiteTypes.push(observation.site_type);
    }
    if (observation.predicted_state === "sun" || observation.predicted_state === "shade") {
      pilot.classifiableObservationCount += 1;
      if (observation.predicted_state === observation.observed_state) {
        pilot.matchingObservationCount += 1;
      }
    } else {
      pilot.unclassifiedPredictionCount += 1;
    }
  }

  for (const [area, pilot] of pilots) {
    const points = [...pointBands.entries()].filter(([key]) => key.startsWith(`${area}\u0000`));
    pilot.uniquePlannedPointCount = points.length;
    pilot.completeRepeatedPointCount = points.filter(([, bands]) =>
      plan.time_bands.every((band) => bands.has(band.id))
    ).length;
    pilot.completeRepeatedSiteTypes = [...new Set(
      points
        .filter(([, bands]) => plan.time_bands.every((band) => bands.has(band.id)))
        .map(([key]) => pointSiteTypes.get(key))
        .filter((siteType): siteType is CalibrationSiteType => siteType !== undefined),
    )].sort();
    pilot.pointRepeatDistanceFailureCount = points.filter(([key]) =>
      pointHasExcessiveCoordinateSpread(
        pointCoordinates.get(key) ?? [],
        plan.maximum_point_repeat_distance_metres,
      )
    ).length;
    pilot.representedSiteTypes.sort();
    pilot.classificationAgreementPercent = percentage(
      pilot.matchingObservationCount,
      pilot.classifiableObservationCount,
    );
    pilot.unclassifiedPredictionRatePercent = percentage(
      pilot.unclassifiedPredictionCount,
      pilot.eligibleObservationCount,
    );
  }

  if (structurallyContradictory) {
    throw new Error("A planned point is assigned contradictory pilot metadata.");
  }

  const orderedPilots = plan.required_pilot_areas.map((area) => pilots.get(area) as FixedPointPilotAnalysis);
  const eligible = orderedPilots.reduce((sum, pilot) => sum + pilot.eligibleObservationCount, 0);
  const classifiable = orderedPilots.reduce((sum, pilot) => sum + pilot.classifiableObservationCount, 0);
  const matching = orderedPilots.reduce((sum, pilot) => sum + pilot.matchingObservationCount, 0);
  const unclassified = orderedPilots.reduce((sum, pilot) => sum + pilot.unclassifiedPredictionCount, 0);
  const agreement = percentage(matching, classifiable);
  const unclassifiedRate = percentage(unclassified, eligible);
  const failures: string[] = [];

  if (eligible < plan.minimum_total_eligible_observations) {
    failures.push("minimum-total-eligible-observations");
  }
  for (const pilot of orderedPilots) {
    if (pilot.uniquePlannedPointCount < plan.minimum_unique_points_per_pilot) {
      failures.push(`${pilot.pilotArea}:minimum-unique-points`);
    }
    if (pilot.completeRepeatedPointCount < plan.minimum_unique_points_per_pilot) {
      failures.push(`${pilot.pilotArea}:repeat-each-point-in-every-time-band`);
    }
    if (pilot.pointRepeatDistanceFailureCount > 0) {
      failures.push(`${pilot.pilotArea}:point-repeat-distance`);
    }
    for (const siteType of plan.required_site_types) {
      if (!pilot.representedSiteTypes.includes(siteType)) {
        failures.push(`${pilot.pilotArea}:missing-site-type:${siteType}`);
      } else if (!pilot.completeRepeatedSiteTypes.includes(siteType)) {
        failures.push(`${pilot.pilotArea}:site-type-not-repeated-in-every-time-band:${siteType}`);
      }
    }
    for (const band of plan.time_bands) {
      if (pilot.observationsByTimeBand[band.id] < plan.minimum_observations_per_pilot_time_band) {
        failures.push(`${pilot.pilotArea}:minimum-time-band:${band.id}`);
      }
    }
  }

  const coverageFailures = failures.length > 0;
  if (!coverageFailures) {
    if (agreement === null || agreement < plan.minimum_classification_agreement_percent) {
      failures.push("minimum-overall-classification-agreement");
    }
    for (const pilot of orderedPilots) {
      if (
        pilot.classificationAgreementPercent === null ||
        pilot.classificationAgreementPercent < plan.minimum_per_pilot_classification_agreement_percent
      ) failures.push(`${pilot.pilotArea}:minimum-classification-agreement`);
    }
    if (
      unclassifiedRate === null ||
      unclassifiedRate > plan.maximum_unclassified_prediction_rate_percent
    ) failures.push("maximum-unclassified-prediction-rate");
  }

  const hasObservations = observations.length > 0;
  const fixedPointGateMet = eligible === 0 || coverageFailures ? null : failures.length === 0;
  const evidenceStatus = !hasObservations
    ? "no-observations"
    : coverageFailures
      ? "insufficient-evidence"
      : fixedPointGateMet
        ? "fixed-point-thresholds-met"
        : "thresholds-not-met";

  return {
    evidenceStatus,
    fixedPointGateMet,
    canClaimModelAccuracy: false,
    totalObservationCount: observations.length,
    eligibleObservationCount: eligible,
    classifiableObservationCount: classifiable,
    matchingObservationCount: matching,
    classificationAgreementPercent: agreement,
    unclassifiedPredictionCount: unclassified,
    unclassifiedPredictionRatePercent: unclassifiedRate,
    excludedObservationCounts: excluded,
    failureCodes: failures,
    pilots: orderedPilots,
  };
}

/** Deterministic and non-throwing for untrusted arrays and threshold content. */
export function analyseFixedPointCalibration(
  observationsValue: unknown,
  thresholdValue: unknown,
): FixedPointCalibrationResult {
  try {
    const observations = strictObservationArray(observationsValue);
    const thresholdPlan = parseFixedPointThresholdPlan(thresholdValue);
    if (!observations || !thresholdPlan) {
      return { status: "invalid", observations: null, thresholdPlan: null, analysis: null };
    }
    const analysis = analyseCleanObservations(observations, thresholdPlan);
    return {
      status: observations.length === 0 ? "empty" : "analysed",
      observations,
      thresholdPlan,
      analysis,
    };
  } catch {
    return { status: "invalid", observations: null, thresholdPlan: null, analysis: null };
  }
}

/** Header-only CSV returns an explicit no-observations result, never a claim. */
export function analyseFixedPointCalibrationCsv(
  csvValue: unknown,
  thresholdValue: unknown,
): FixedPointCalibrationResult {
  try {
    const observations = parseCalibrationCsv(csvValue);
    if (!observations) {
      return { status: "invalid", observations: null, thresholdPlan: null, analysis: null };
    }
    return analyseFixedPointCalibration(observations, thresholdValue);
  } catch {
    return { status: "invalid", observations: null, thresholdPlan: null, analysis: null };
  }
}
