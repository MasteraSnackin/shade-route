import type { LabelledRasterScore } from "./raster-shade.ts";
import type { NamedPoint, WalkingRoute } from "./routes.ts";
import type { RouteProfile } from "./shade.ts";
import {
  walkingDurationSeconds,
  type WalkingPace,
} from "./walking-pace.ts";

export const DECISION_EVIDENCE_SCHEMA = "uk.shaderoute.decision-evidence" as const;
export const DECISION_EVIDENCE_VERSION = 1 as const;
export const DECISION_EVIDENCE_MAX_BYTES = 32 * 1024;
export const DECISION_EVIDENCE_MAX_JOURNEYS = 8;

const TEXT_LIMITS = {
  id: 120,
  name: 180,
  source: 300,
  sourceDate: 120,
  version: 80,
} as const;

const ROUTE_LABELS = ["fastest", "least-sun", "lowest-estimate", "recommended"] as const;
const CONFIDENCE_REASONS = [
  "incomplete-height-coverage",
  "low-sun-angle",
  "near-clearance-threshold",
  "ray-search-limit",
  "subcell-surface-variation",
  "unmodelled-passage",
] as const;

export const DECISION_EVIDENCE_LIMITATIONS = [
  "Clear-sky geometric estimate only; it does not measure heat, temperature, cloud or current conditions.",
  "Building-height coverage can be incomplete or dated, and trees, vehicles, awnings and temporary obstructions are not fully modelled.",
  "Low sun angles, passages and surfaces close to the ray-clearance threshold have greater uncertainty.",
  "Access evidence comes from route data and does not certify a step-free, open or safe route.",
  "A live custom route cannot be reproduced exactly from this privacy-bounded record because endpoint coordinates and route geometry are excluded.",
  "The model is engineering-tested but has not completed physical field calibration.",
] as const;

export type AccessEvidenceStatus =
  | "no-known-barrier-identified"
  | "known-barrier-identified"
  | "unavailable";

export interface DecisionEvidenceSourceInput {
  source: string;
  sourceDate: string;
}

export interface DecisionEvidenceProvenanceInput {
  routeData: DecisionEvidenceSourceInput;
  heightData: DecisionEvidenceSourceInput & { processedDate: string };
  model: { name: string; version: string };
}

export interface DecisionEvidenceAccessInput {
  avoidKnownStepsRequested: boolean;
  evidenceStatus: AccessEvidenceStatus;
  crossingEvidence: "mapped" | "not-mentioned" | "unavailable";
  surfaceEvidence: "rough-flag" | "not-flagged" | "unavailable";
}

export interface DecisionEvidenceInput {
  createdAt: Date | string;
  area: { id: string; name: string };
  endpoints: {
    origin: Pick<NamedPoint, "name">;
    destination: Pick<NamedPoint, "name">;
  };
  selectedRoute: WalkingRoute;
  selectedScore: LabelledRasterScore;
  fastestRoute: Pick<WalkingRoute, "id" | "distanceMetres" | "durationSeconds">;
  departure: Date | string;
  profile: RouteProfile;
  walkingPace: WalkingPace;
  schedule: { journeyCount: number; repeatEveryMinutes: number };
  access: DecisionEvidenceAccessInput;
  provenance: DecisionEvidenceProvenanceInput;
}

export interface DecisionEvidenceRecord {
  schema: typeof DECISION_EVIDENCE_SCHEMA;
  schemaVersion: typeof DECISION_EVIDENCE_VERSION;
  createdAt: string;
  privacy: {
    scope: "planned-journey-only";
    plannedEndpointCoordinatesIncluded: false;
    deviceLocationIncluded: false;
    freeTextNotesIncluded: false;
    savedHistoryIncluded: false;
    inferredHealthDataIncluded: false;
  };
  journey: {
    area: { id: string; name: string };
    plannedEndpoints: {
      origin: { name: string };
      destination: { name: string };
    };
    departure: string;
    planningProfile: {
      id: RouteProfile;
      basis: "user-selected-planning-mode";
    };
    walkingPace: WalkingPace;
    schedule: { journeyCount: number; repeatEveryMinutes: number };
  };
  decision: {
    selectedRoute: {
      id: string;
      distanceMetresPerJourney: number;
      durationSecondsPerJourney: number;
      labels: Array<(typeof ROUTE_LABELS)[number]>;
    };
    fastestAlternative: {
      routeId: string;
      distanceMetresPerJourney: number;
      durationSecondsPerJourney: number;
    };
    selectedVsFastest: {
      additionalDurationSecondsPerJourney: number;
      distanceDifferenceMetresPerJourney: number;
    };
    access: DecisionEvidenceAccessInput & {
      certification: "not-step-free-certified";
    };
  };
  modelOutput: {
    basis: "clear-sky-geometric-model";
    scope: "whole-schedule";
    estimatedPotentialDirectSunSeconds: number;
    potentialDirectSunRangeSeconds: {
      bestCase: number;
      worstCase: number;
    };
    estimatedShadePercent: number | null;
    modelledCoveragePercent: number;
    daylightSeconds: number;
    modelledDaylightSeconds: number;
    unknownDaylightSeconds: number;
    confidence: {
      limited: boolean;
      reasons: Array<(typeof CONFIDENCE_REASONS)[number]>;
    };
    journeys: Array<{
      index: number;
      departure: string;
      arrival: string;
      estimatedPotentialDirectSunSeconds: number;
      potentialDirectSunRangeSeconds: {
        bestCase: number;
        worstCase: number;
      };
      estimatedShadePercent: number | null;
      modelledCoveragePercent: number;
      confidence: {
        limited: boolean;
        reasons: Array<(typeof CONFIDENCE_REASONS)[number]>;
      };
    }>;
  };
  provenance: DecisionEvidenceProvenanceInput;
  assurance: {
    validationStatus: "uncalibrated";
    limitations: string[];
  };
}

function cleanText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maximumLength ? cleaned : null;
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function roundedPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value * 10) / 10;
}

function normaliseInstant(value: unknown): string | null {
  try {
    if (
      typeof value === "string" &&
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ) {
      return null;
    }
    const date = value instanceof Date
      ? new Date(value.getTime())
      : typeof value === "string"
        ? new Date(value)
        : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

function cleanPointName(point: Pick<NamedPoint, "name">) {
  const name = cleanText(point?.name, TEXT_LIMITS.name);
  return name ? { name } : null;
}

function canonicalLabels(labels: LabelledRasterScore["labels"]) {
  return ROUTE_LABELS.filter((label) => labels.includes(label));
}

function canonicalConfidenceReasons(reasons: LabelledRasterScore["confidenceReasons"]) {
  return CONFIDENCE_REASONS.filter((reason) => reasons.includes(reason));
}

function buildJourneyEvidence(
  score: LabelledRasterScore,
  departure: string,
  repeatEveryMinutes: number,
): DecisionEvidenceRecord["modelOutput"]["journeys"] | null {
  if (
    score.journeys.length !== score.journeyCount ||
    score.journeys.length < 1 ||
    score.journeys.length > DECISION_EVIDENCE_MAX_JOURNEYS
  ) return null;

  const baseDepartureMs = new Date(departure).getTime();
  const journeys: DecisionEvidenceRecord["modelOutput"]["journeys"] = [];
  for (const [position, journey] of score.journeys.entries()) {
    const journeyDeparture = normaliseInstant(new Date(journey.departureEpochMs));
    const journeyArrival = normaliseInstant(new Date(journey.arrivalEpochMs));
    const expectedDepartureMs = baseDepartureMs + position * repeatEveryMinutes * 60_000;
    const directSun = nonNegativeInteger(journey.score.estimatedDirectSunSeconds);
    const bestCase = nonNegativeInteger(journey.score.directSunRangeSeconds?.[0]);
    const worstCase = nonNegativeInteger(journey.score.directSunRangeSeconds?.[1]);
    const shadePercent = journey.score.estimatedShadePercent === null
      ? null
      : roundedPercent(journey.score.estimatedShadePercent);
    const coverage = roundedPercent(journey.score.coveragePercent);
    if (
      journey.index !== position || journey.score.routeId !== score.routeId ||
      !journeyDeparture || !journeyArrival ||
      journey.departureEpochMs !== expectedDepartureMs ||
      journey.arrivalEpochMs < journey.departureEpochMs ||
      directSun === null || bestCase === null || worstCase === null ||
      bestCase > directSun || directSun > worstCase ||
      coverage === null ||
      (shadePercent === null && journey.score.estimatedShadePercent !== null)
    ) return null;
    journeys.push({
      index: position,
      departure: journeyDeparture,
      arrival: journeyArrival,
      estimatedPotentialDirectSunSeconds: directSun,
      potentialDirectSunRangeSeconds: { bestCase, worstCase },
      estimatedShadePercent: shadePercent,
      modelledCoveragePercent: coverage,
      confidence: {
        limited: Boolean(journey.score.limitedConfidence),
        reasons: canonicalConfidenceReasons(journey.score.confidenceReasons),
      },
    });
  }
  return journeys;
}

/**
 * Creates a privacy-bounded decision record. It deliberately omits route
 * geometry, directions, notes, device position, saved journeys and feedback.
 */
export function createDecisionEvidence(input: DecisionEvidenceInput): DecisionEvidenceRecord | null {
  try {
    const createdAt = normaliseInstant(input.createdAt);
    const departure = normaliseInstant(input.departure);
    const areaId = cleanText(input.area?.id, TEXT_LIMITS.id);
    const areaName = cleanText(input.area?.name, TEXT_LIMITS.name);
    const origin = cleanPointName(input.endpoints?.origin);
    const destination = cleanPointName(input.endpoints?.destination);
    const selectedRouteId = cleanText(input.selectedRoute?.id, TEXT_LIMITS.id);
    const fastestRouteId = cleanText(input.fastestRoute?.id, TEXT_LIMITS.id);
    if (
      !createdAt || !departure || !areaId || !areaName || !origin || !destination ||
      !selectedRouteId || !fastestRouteId ||
      (input.profile !== "vulnerable" && input.profile !== "worker") ||
      (input.walkingPace !== "slow" && input.walkingPace !== "standard" && input.walkingPace !== "brisk") ||
      !Number.isInteger(input.schedule?.journeyCount) ||
      input.schedule.journeyCount < 1 || input.schedule.journeyCount > DECISION_EVIDENCE_MAX_JOURNEYS ||
      !Number.isInteger(input.schedule?.repeatEveryMinutes) ||
      input.schedule.repeatEveryMinutes < 5 || input.schedule.repeatEveryMinutes > 1_440 ||
      input.selectedScore?.routeId !== input.selectedRoute.id ||
      input.selectedScore?.journeyCount !== input.schedule.journeyCount ||
      input.selectedScore?.walkingPace !== input.walkingPace
    ) {
      return null;
    }

    const selectedDistance = nonNegativeInteger(input.selectedRoute.distanceMetres);
    const fastestDistance = nonNegativeInteger(input.fastestRoute.distanceMetres);
    const selectedDuration = nonNegativeInteger(walkingDurationSeconds(input.selectedRoute, input.walkingPace));
    const fastestDuration = nonNegativeInteger(walkingDurationSeconds(input.fastestRoute, input.walkingPace));
    const estimatedDirectSun = nonNegativeInteger(input.selectedScore.estimatedDirectSunSeconds);
    const bestCase = nonNegativeInteger(input.selectedScore.directSunRangeSeconds?.[0]);
    const worstCase = nonNegativeInteger(input.selectedScore.directSunRangeSeconds?.[1]);
    const coverage = roundedPercent(input.selectedScore.coveragePercent);
    const shadePercent = input.selectedScore.estimatedShadePercent === null
      ? null
      : roundedPercent(input.selectedScore.estimatedShadePercent);
    const daylight = nonNegativeInteger(input.selectedScore.daylightSeconds);
    const modelledDaylight = nonNegativeInteger(input.selectedScore.modelledDaylightSeconds);
    const unknownDaylight = nonNegativeInteger(input.selectedScore.unknownDaylightSeconds);
    const journeys = buildJourneyEvidence(
      input.selectedScore,
      departure,
      input.schedule.repeatEveryMinutes,
    );
    if (
      selectedDistance === null || selectedDistance === 0 ||
      fastestDistance === null || fastestDistance === 0 ||
      selectedDuration === null || selectedDuration === 0 ||
      fastestDuration === null || fastestDuration === 0 || fastestDuration > selectedDuration ||
      estimatedDirectSun === null || bestCase === null || worstCase === null ||
      bestCase > estimatedDirectSun || estimatedDirectSun > worstCase ||
      coverage === null || shadePercent === null && input.selectedScore.estimatedShadePercent !== null ||
      daylight === null || modelledDaylight === null || unknownDaylight === null ||
      modelledDaylight + unknownDaylight !== daylight || !journeys
    ) {
      return null;
    }
    const scheduleEstimatedDirectSun = journeys.reduce(
      (sum, journey) => sum + journey.estimatedPotentialDirectSunSeconds,
      0,
    );
    const scheduleBestCase = journeys.reduce(
      (sum, journey) => sum + journey.potentialDirectSunRangeSeconds.bestCase,
      0,
    );
    const scheduleWorstCase = journeys.reduce(
      (sum, journey) => sum + journey.potentialDirectSunRangeSeconds.worstCase,
      0,
    );
    if (
      Math.abs(estimatedDirectSun - scheduleEstimatedDirectSun) > journeys.length ||
      Math.abs(bestCase - scheduleBestCase) > journeys.length ||
      Math.abs(worstCase - scheduleWorstCase) > journeys.length
    ) return null;
    const scheduleConfidenceReasons = CONFIDENCE_REASONS.filter((reason) =>
      journeys.some((journey) => journey.confidence.reasons.includes(reason)),
    );
    const scheduleLimitedConfidence = journeys.some((journey) => journey.confidence.limited);

    const routeSource = cleanText(input.provenance?.routeData?.source, TEXT_LIMITS.source);
    const routeSourceDate = cleanText(input.provenance?.routeData?.sourceDate, TEXT_LIMITS.sourceDate);
    const heightSource = cleanText(input.provenance?.heightData?.source, TEXT_LIMITS.source);
    const heightSourceDate = cleanText(input.provenance?.heightData?.sourceDate, TEXT_LIMITS.sourceDate);
    const heightProcessedDate = cleanText(input.provenance?.heightData?.processedDate, TEXT_LIMITS.sourceDate);
    const modelName = cleanText(input.provenance?.model?.name, TEXT_LIMITS.name);
    const modelVersion = cleanText(input.provenance?.model?.version, TEXT_LIMITS.version);
    const access = input.access;
    if (
      !routeSource || !routeSourceDate || !heightSource || !heightSourceDate ||
      !heightProcessedDate || !modelName || !modelVersion ||
      typeof access?.avoidKnownStepsRequested !== "boolean" ||
      !["no-known-barrier-identified", "known-barrier-identified", "unavailable"].includes(access.evidenceStatus) ||
      !["mapped", "not-mentioned", "unavailable"].includes(access.crossingEvidence) ||
      !["rough-flag", "not-flagged", "unavailable"].includes(access.surfaceEvidence)
    ) {
      return null;
    }

    const record: DecisionEvidenceRecord = {
      schema: DECISION_EVIDENCE_SCHEMA,
      schemaVersion: DECISION_EVIDENCE_VERSION,
      createdAt,
      privacy: {
        scope: "planned-journey-only",
        plannedEndpointCoordinatesIncluded: false,
        deviceLocationIncluded: false,
        freeTextNotesIncluded: false,
        savedHistoryIncluded: false,
        inferredHealthDataIncluded: false,
      },
      journey: {
        area: { id: areaId, name: areaName },
        plannedEndpoints: { origin, destination },
        departure,
        planningProfile: {
          id: input.profile,
          basis: "user-selected-planning-mode",
        },
        walkingPace: input.walkingPace,
        schedule: {
          journeyCount: input.schedule.journeyCount,
          repeatEveryMinutes: input.schedule.repeatEveryMinutes,
        },
      },
      decision: {
        selectedRoute: {
          id: selectedRouteId,
          distanceMetresPerJourney: selectedDistance,
          durationSecondsPerJourney: selectedDuration,
          labels: canonicalLabels(input.selectedScore.labels),
        },
        fastestAlternative: {
          routeId: fastestRouteId,
          distanceMetresPerJourney: fastestDistance,
          durationSecondsPerJourney: fastestDuration,
        },
        selectedVsFastest: {
          additionalDurationSecondsPerJourney: selectedDuration - fastestDuration,
          distanceDifferenceMetresPerJourney: selectedDistance - fastestDistance,
        },
        access: {
          avoidKnownStepsRequested: access.avoidKnownStepsRequested,
          evidenceStatus: access.evidenceStatus,
          crossingEvidence: access.crossingEvidence,
          surfaceEvidence: access.surfaceEvidence,
          certification: "not-step-free-certified",
        },
      },
      modelOutput: {
        basis: "clear-sky-geometric-model",
        scope: "whole-schedule",
        estimatedPotentialDirectSunSeconds: scheduleEstimatedDirectSun,
        potentialDirectSunRangeSeconds: {
          bestCase: scheduleBestCase,
          worstCase: scheduleWorstCase,
        },
        estimatedShadePercent: shadePercent,
        modelledCoveragePercent: coverage,
        daylightSeconds: daylight,
        modelledDaylightSeconds: modelledDaylight,
        unknownDaylightSeconds: unknownDaylight,
        confidence: {
          limited: scheduleLimitedConfidence,
          reasons: scheduleConfidenceReasons,
        },
        journeys,
      },
      provenance: {
        routeData: { source: routeSource, sourceDate: routeSourceDate },
        heightData: {
          source: heightSource,
          sourceDate: heightSourceDate,
          processedDate: heightProcessedDate,
        },
        model: { name: modelName, version: modelVersion },
      },
      assurance: {
        validationStatus: "uncalibrated",
        limitations: [...DECISION_EVIDENCE_LIMITATIONS],
      },
    };

    return serialiseDecisionEvidence(record) ? record : null;
  } catch {
    return null;
  }
}

function exactKeys(value: object, expected: readonly string[]) {
  try {
    const keys = Object.keys(value).sort();
    return keys.length === expected.length &&
      keys.every((key, index) => key === [...expected].sort()[index]);
  } catch {
    return false;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function strictText(value: unknown, limit: number) {
  return typeof value === "string" && value.length > 0 && value.length <= limit && value === value.trim();
}

function strictPointName(value: unknown) {
  return plainObject(value) && exactKeys(value, ["name"]) &&
    strictText(value.name, TEXT_LIMITS.name);
}

function strictSource(value: unknown, height = false) {
  const keys = height ? ["source", "sourceDate", "processedDate"] : ["source", "sourceDate"];
  if (!plainObject(value) || !exactKeys(value, keys)) return false;
  return strictText(value.source, TEXT_LIMITS.source) &&
    strictText(value.sourceDate, TEXT_LIMITS.sourceDate) &&
    (!height || strictText(value.processedDate, TEXT_LIMITS.sourceDate));
}

function strictCanonicalArray(value: unknown, allowed: readonly string[]) {
  if (!Array.isArray(value) || value.length > allowed.length) return false;
  if (value.some((item) => typeof item !== "string" || !allowed.includes(item))) return false;
  const canonical = allowed.filter((item) => value.includes(item));
  return value.every((item, index) => item === canonical[index]);
}

function strictJourneyEvidence(
  value: unknown,
  expectedIndex: number,
  baseDeparture: string,
  repeatEveryMinutes: number,
) {
  if (!plainObject(value) || !exactKeys(value, [
    "index", "departure", "arrival", "estimatedPotentialDirectSunSeconds",
    "potentialDirectSunRangeSeconds", "estimatedShadePercent",
    "modelledCoveragePercent", "confidence",
  ])) return false;
  const range = value.potentialDirectSunRangeSeconds;
  const confidence = value.confidence;
  const expectedDeparture = new Date(
    new Date(baseDeparture).getTime() + expectedIndex * repeatEveryMinutes * 60_000,
  ).toISOString();
  return value.index === expectedIndex &&
    normaliseInstant(value.departure) === value.departure && value.departure === expectedDeparture &&
    normaliseInstant(value.arrival) === value.arrival &&
    new Date(value.arrival as string).getTime() >= new Date(value.departure as string).getTime() &&
    finiteInteger(value.estimatedPotentialDirectSunSeconds) &&
    plainObject(range) && exactKeys(range, ["bestCase", "worstCase"]) &&
    finiteInteger(range.bestCase) && finiteInteger(range.worstCase) &&
    range.bestCase <= value.estimatedPotentialDirectSunSeconds &&
    value.estimatedPotentialDirectSunSeconds <= range.worstCase &&
    (value.estimatedShadePercent === null ||
      typeof value.estimatedShadePercent === "number" && Number.isFinite(value.estimatedShadePercent) &&
      value.estimatedShadePercent >= 0 && value.estimatedShadePercent <= 100) &&
    typeof value.modelledCoveragePercent === "number" &&
    Number.isFinite(value.modelledCoveragePercent) &&
    value.modelledCoveragePercent >= 0 && value.modelledCoveragePercent <= 100 &&
    plainObject(confidence) && exactKeys(confidence, ["limited", "reasons"]) &&
    typeof confidence.limited === "boolean" &&
    strictCanonicalArray(confidence.reasons, CONFIDENCE_REASONS);
}

function isStrictDecisionEvidence(value: unknown): value is DecisionEvidenceRecord {
  try {
    if (!plainObject(value) || !exactKeys(value, [
      "schema", "schemaVersion", "createdAt", "privacy", "journey", "decision",
      "modelOutput", "provenance", "assurance",
    ])) return false;
    if (
      value.schema !== DECISION_EVIDENCE_SCHEMA ||
      value.schemaVersion !== DECISION_EVIDENCE_VERSION ||
      normaliseInstant(value.createdAt) !== value.createdAt
    ) return false;

    const privacy = value.privacy;
    if (!plainObject(privacy) || !exactKeys(privacy, [
      "scope", "plannedEndpointCoordinatesIncluded", "deviceLocationIncluded",
      "freeTextNotesIncluded", "savedHistoryIncluded", "inferredHealthDataIncluded",
    ]) || privacy.scope !== "planned-journey-only" ||
      privacy.plannedEndpointCoordinatesIncluded !== false ||
      privacy.deviceLocationIncluded !== false || privacy.freeTextNotesIncluded !== false ||
      privacy.savedHistoryIncluded !== false || privacy.inferredHealthDataIncluded !== false
    ) return false;

    const journey = value.journey;
    if (!plainObject(journey) || !exactKeys(journey, [
      "area", "plannedEndpoints", "departure", "planningProfile", "walkingPace", "schedule",
    ])) return false;
    const area = journey.area;
    const endpoints = journey.plannedEndpoints;
    const planningProfile = journey.planningProfile;
    const schedule = journey.schedule;
    if (
      !plainObject(area) || !exactKeys(area, ["id", "name"]) ||
      !strictText(area.id, TEXT_LIMITS.id) || !strictText(area.name, TEXT_LIMITS.name) ||
      !plainObject(endpoints) || !exactKeys(endpoints, ["origin", "destination"]) ||
      !strictPointName(endpoints.origin) || !strictPointName(endpoints.destination) ||
      normaliseInstant(journey.departure) !== journey.departure ||
      !plainObject(planningProfile) || !exactKeys(planningProfile, ["id", "basis"]) ||
      !["vulnerable", "worker"].includes(planningProfile.id as string) ||
      planningProfile.basis !== "user-selected-planning-mode" ||
      !["slow", "standard", "brisk"].includes(journey.walkingPace as string) ||
      !plainObject(schedule) || !exactKeys(schedule, ["journeyCount", "repeatEveryMinutes"]) ||
      !finiteInteger(schedule.journeyCount, 1, DECISION_EVIDENCE_MAX_JOURNEYS) ||
      !finiteInteger(schedule.repeatEveryMinutes, 5, 1_440)
    ) return false;

    const decision = value.decision;
    if (!plainObject(decision) || !exactKeys(decision, [
      "selectedRoute", "fastestAlternative", "selectedVsFastest", "access",
    ])) return false;
    const selected = decision.selectedRoute;
    const fastest = decision.fastestAlternative;
    const tradeOff = decision.selectedVsFastest;
    const access = decision.access;
    if (
      !plainObject(selected) || !exactKeys(selected, ["id", "distanceMetresPerJourney", "durationSecondsPerJourney", "labels"]) ||
      !strictText(selected.id, TEXT_LIMITS.id) ||
      !finiteInteger(selected.distanceMetresPerJourney, 1, 100_000) ||
      !finiteInteger(selected.durationSecondsPerJourney, 1, 86_400) ||
      !strictCanonicalArray(selected.labels, ROUTE_LABELS) ||
      !plainObject(fastest) || !exactKeys(fastest, ["routeId", "distanceMetresPerJourney", "durationSecondsPerJourney"]) ||
      !strictText(fastest.routeId, TEXT_LIMITS.id) ||
      !finiteInteger(fastest.distanceMetresPerJourney, 1, 100_000) ||
      !finiteInteger(fastest.durationSecondsPerJourney, 1, 86_400) ||
      fastest.durationSecondsPerJourney > selected.durationSecondsPerJourney ||
      !plainObject(tradeOff) || !exactKeys(tradeOff, ["additionalDurationSecondsPerJourney", "distanceDifferenceMetresPerJourney"]) ||
      tradeOff.additionalDurationSecondsPerJourney !== selected.durationSecondsPerJourney - fastest.durationSecondsPerJourney ||
      tradeOff.distanceDifferenceMetresPerJourney !== selected.distanceMetresPerJourney - fastest.distanceMetresPerJourney ||
      !plainObject(access) || !exactKeys(access, [
        "avoidKnownStepsRequested", "evidenceStatus", "crossingEvidence", "surfaceEvidence", "certification",
      ]) || typeof access.avoidKnownStepsRequested !== "boolean" ||
      !["no-known-barrier-identified", "known-barrier-identified", "unavailable"].includes(access.evidenceStatus as string) ||
      !["mapped", "not-mentioned", "unavailable"].includes(access.crossingEvidence as string) ||
      !["rough-flag", "not-flagged", "unavailable"].includes(access.surfaceEvidence as string) ||
      access.certification !== "not-step-free-certified"
    ) return false;

    const output = value.modelOutput;
    if (!plainObject(output) || !exactKeys(output, [
      "basis", "scope", "estimatedPotentialDirectSunSeconds", "potentialDirectSunRangeSeconds",
      "estimatedShadePercent", "modelledCoveragePercent", "daylightSeconds",
      "modelledDaylightSeconds", "unknownDaylightSeconds", "confidence", "journeys",
    ]) || output.basis !== "clear-sky-geometric-model" || output.scope !== "whole-schedule") return false;
    const range = output.potentialDirectSunRangeSeconds;
    const confidence = output.confidence;
    if (
      !finiteInteger(output.estimatedPotentialDirectSunSeconds) ||
      !plainObject(range) || !exactKeys(range, ["bestCase", "worstCase"]) ||
      !finiteInteger(range.bestCase) || !finiteInteger(range.worstCase) ||
      range.bestCase > output.estimatedPotentialDirectSunSeconds ||
      output.estimatedPotentialDirectSunSeconds > range.worstCase ||
      !(output.estimatedShadePercent === null ||
        typeof output.estimatedShadePercent === "number" && Number.isFinite(output.estimatedShadePercent) && output.estimatedShadePercent >= 0 && output.estimatedShadePercent <= 100) ||
      typeof output.modelledCoveragePercent !== "number" || !Number.isFinite(output.modelledCoveragePercent) ||
      output.modelledCoveragePercent < 0 || output.modelledCoveragePercent > 100 ||
      !finiteInteger(output.daylightSeconds) || !finiteInteger(output.modelledDaylightSeconds) ||
      !finiteInteger(output.unknownDaylightSeconds) ||
      output.modelledDaylightSeconds + output.unknownDaylightSeconds !== output.daylightSeconds ||
      !plainObject(confidence) || !exactKeys(confidence, ["limited", "reasons"]) ||
      typeof confidence.limited !== "boolean" ||
      !strictCanonicalArray(confidence.reasons, CONFIDENCE_REASONS)
    ) return false;
    const outputJourneys = output.journeys;
    if (
      !Array.isArray(outputJourneys) ||
      outputJourneys.length !== schedule.journeyCount ||
      outputJourneys.length > DECISION_EVIDENCE_MAX_JOURNEYS ||
      outputJourneys.some((item, index) => !strictJourneyEvidence(
        item,
        index,
        journey.departure as string,
        schedule.repeatEveryMinutes as number,
      ))
    ) return false;
    const scheduleDirectSun = outputJourneys.reduce(
      (sum, item) => sum + (item as Record<string, number>).estimatedPotentialDirectSunSeconds,
      0,
    );
    const scheduleBestCase = outputJourneys.reduce(
      (sum, item) => sum + ((item as Record<string, unknown>).potentialDirectSunRangeSeconds as Record<string, number>).bestCase,
      0,
    );
    const scheduleWorstCase = outputJourneys.reduce(
      (sum, item) => sum + ((item as Record<string, unknown>).potentialDirectSunRangeSeconds as Record<string, number>).worstCase,
      0,
    );
    const scheduleLimited = outputJourneys.some(
      (item) => ((item as Record<string, unknown>).confidence as Record<string, unknown>).limited === true,
    );
    const scheduleReasons = CONFIDENCE_REASONS.filter((reason) => outputJourneys.some(
      (item) => (((item as Record<string, unknown>).confidence as Record<string, unknown>).reasons as unknown[]).includes(reason),
    ));
    if (
      scheduleDirectSun !== output.estimatedPotentialDirectSunSeconds ||
      scheduleBestCase !== range.bestCase || scheduleWorstCase !== range.worstCase ||
      scheduleLimited !== confidence.limited ||
      !Array.isArray(confidence.reasons) ||
      confidence.reasons.length !== scheduleReasons.length ||
      !strictCanonicalArray(confidence.reasons, scheduleReasons)
    ) return false;

    const provenance = value.provenance;
    if (!plainObject(provenance) || !exactKeys(provenance, ["routeData", "heightData", "model"]) ||
      !strictSource(provenance.routeData) || !strictSource(provenance.heightData, true) ||
      !plainObject(provenance.model) || !exactKeys(provenance.model, ["name", "version"]) ||
      !strictText(provenance.model.name, TEXT_LIMITS.name) || !strictText(provenance.model.version, TEXT_LIMITS.version)
    ) return false;

    const assurance = value.assurance;
    return plainObject(assurance) && exactKeys(assurance, ["validationStatus", "limitations"]) &&
      assurance.validationStatus === "uncalibrated" && Array.isArray(assurance.limitations) &&
      assurance.limitations.length === DECISION_EVIDENCE_LIMITATIONS.length &&
      assurance.limitations.every((limitation, index) => limitation === DECISION_EVIDENCE_LIMITATIONS[index]);
  } catch {
    return false;
  }
}

/** Parses untrusted input without throwing. Unknown versions, extra fields and malformed data fail closed. */
export function parseDecisionEvidence(raw: unknown): DecisionEvidenceRecord | null {
  try {
    if (typeof raw !== "string") return null;
    if (new TextEncoder().encode(raw).byteLength > DECISION_EVIDENCE_MAX_BYTES) return null;
    const value: unknown = JSON.parse(raw);
    return isStrictDecisionEvidence(value) ? value : null;
  } catch {
    return null;
  }
}

/** Serialises only records which still satisfy the strict v1 schema and byte limit. */
export function serialiseDecisionEvidence(record: DecisionEvidenceRecord): string | null {
  try {
    const raw = `${JSON.stringify(record, null, 2)}\n`;
    return parseDecisionEvidence(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function decisionEvidenceFilename(record: DecisionEvidenceRecord) {
  const area = record.journey.area.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "area";
  const route = record.decision.selectedRoute.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "route";
  return `shaderoute-evidence-${area}-${route}-${record.createdAt.slice(0, 10)}.json`;
}
