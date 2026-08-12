import {
  labelRouteScores,
  scoreRouteSchedule,
  type ConfidenceReason,
  type HeightGrid,
  type LabelledRasterScore,
} from "./raster-shade.ts";
import type { WalkingRoute } from "./routes.ts";
import type { WalkingPace } from "./walking-pace.ts";

export type DepartureAdviceProfile = "vulnerable" | "worker";

export type DepartureAdviceConfidence = "moderate" | "limited" | "unavailable";

export type DepartureAdviceWithheldReason =
  | "no-routes"
  | "no-daylight"
  | "low-model-coverage"
  | "insufficient-saving"
  | "sensitivity-overlap"
  | "low-sun-confidence";

export interface DepartureAdviceInput {
  routes: WalkingRoute[];
  grid: HeightGrid;
  /** A real instant, normally parsed from a Europe/London datetime-local value. */
  departure: Date;
  profile: DepartureAdviceProfile;
  journeyCount: number;
  repeatEveryMinutes: number;
  /** Defaults to the routing provider's standard walking duration. */
  walkingPace?: WalkingPace;
  /** Forward-looking scan length. Defaults to two hours. */
  windowMinutes?: number;
  /** Interval between candidates. Defaults to 15 minutes. */
  stepMinutes?: number;
  /** Required displayed reduction per journey. Defaults to 60 seconds. */
  minimumSavingSeconds?: number;
  /** Required route-model coverage. Defaults to 80%. */
  minimumCoveragePercent?: number;
}

export interface DepartureAdviceOption {
  route: WalkingRoute;
  routeId: string;
  departureDate: Date;
  walkingSecondsPerJourney: number;
  directSunSecondsPerJourney: number;
  directSunRangeSecondsPerJourney: [bestCaseSeconds: number, worstCaseSeconds: number];
  modelCoveragePercent: number;
  isDaylight: boolean;
  limitedConfidence: boolean;
  confidenceReasons: ConfidenceReason[];
  /** The labelled aggregate is retained for map/card integration. */
  score: LabelledRasterScore;
}

export interface DepartureAdviceResult {
  currentOption: DepartureAdviceOption | null;
  bestOption: DepartureAdviceOption | null;
  selectedRoute: WalkingRoute | null;
  departureDate: Date | null;
  directSunSecondsPerJourney: number | null;
  directSunRangeSecondsPerJourney:
    | [bestCaseSeconds: number, worstCaseSeconds: number]
    | null;
  /** Additional walking time per journey compared with the current option. */
  extraWalkingSeconds: number;
  /** Reduction in the displayed direct-sun estimate per journey. */
  sunSecondsSaved: number;
  modelCoveragePercent: number | null;
  confidence: DepartureAdviceConfidence;
  withheldReason: DepartureAdviceWithheldReason | null;
  /** True only when the advice is sufficiently supported to be actionable. */
  recommended: boolean;
  scannedDepartureCount: number;
  windowMinutes: number;
  stepMinutes: number;
}

export const DEFAULT_DEPARTURE_WINDOW_MINUTES = 120;
export const DEFAULT_DEPARTURE_STEP_MINUTES = 15;
export const DEFAULT_MINIMUM_SAVING_SECONDS = 60;
export const DEFAULT_MINIMUM_COVERAGE_PERCENT = 80;

const EPSILON_SECONDS = 1e-6;

function finiteNonNegative(value: number | undefined, fallback: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number.`);
  }
  return resolved;
}

function finitePositive(value: number | undefined, fallback: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a finite number greater than zero.`);
  }
  return resolved;
}

function selectedScore(scores: LabelledRasterScore[]) {
  return scores.find((score) => score.labels.includes("recommended")) ?? scores[0] ?? null;
}

function toOption(
  score: LabelledRasterScore,
  routesById: Map<string, WalkingRoute>,
  departureDate: Date,
): DepartureAdviceOption | null {
  const route = routesById.get(score.routeId);
  if (!route) return null;
  const count = Math.max(1, score.journeyCount);
  return {
    route,
    routeId: route.id,
    departureDate: new Date(departureDate),
    walkingSecondsPerJourney: score.durationSeconds / count,
    directSunSecondsPerJourney: score.estimatedDirectSunSeconds / count,
    directSunRangeSecondsPerJourney: [
      score.directSunRangeSeconds[0] / count,
      score.directSunRangeSeconds[1] / count,
    ],
    modelCoveragePercent: score.coveragePercent,
    isDaylight: score.isDaylight,
    limitedConfidence: score.limitedConfidence,
    confidenceReasons: [...score.confidenceReasons],
    score,
  };
}

function betterOption(
  candidate: DepartureAdviceOption,
  current: DepartureAdviceOption,
  routeOrder: Map<string, number>,
) {
  const estimateDifference =
    candidate.directSunSecondsPerJourney - current.directSunSecondsPerJourney;
  if (estimateDifference < -EPSILON_SECONDS) return candidate;
  if (estimateDifference > EPSILON_SECONDS) return current;

  const worstCaseDifference =
    candidate.directSunRangeSecondsPerJourney[1] -
    current.directSunRangeSecondsPerJourney[1];
  if (worstCaseDifference < -EPSILON_SECONDS) return candidate;
  if (worstCaseDifference > EPSILON_SECONDS) return current;

  const walkDifference = candidate.walkingSecondsPerJourney - current.walkingSecondsPerJourney;
  if (walkDifference < -EPSILON_SECONDS) return candidate;
  if (walkDifference > EPSILON_SECONDS) return current;

  const timeDifference = candidate.departureDate.getTime() - current.departureDate.getTime();
  if (timeDifference < 0) return candidate;
  if (timeDifference > 0) return current;

  return (routeOrder.get(candidate.routeId) ?? Number.MAX_SAFE_INTEGER) <
    (routeOrder.get(current.routeId) ?? Number.MAX_SAFE_INTEGER)
    ? candidate
    : current;
}

function emptyResult(
  windowMinutes: number,
  stepMinutes: number,
): DepartureAdviceResult {
  return {
    currentOption: null,
    bestOption: null,
    selectedRoute: null,
    departureDate: null,
    directSunSecondsPerJourney: null,
    directSunRangeSecondsPerJourney: null,
    extraWalkingSeconds: 0,
    sunSecondsSaved: 0,
    modelCoveragePercent: null,
    confidence: "unavailable",
    withheldReason: "no-routes",
    recommended: false,
    scannedDepartureCount: 0,
    windowMinutes,
    stepMinutes,
  };
}

function resultFor(
  currentOption: DepartureAdviceOption,
  bestOption: DepartureAdviceOption,
  scannedDepartureCount: number,
  windowMinutes: number,
  stepMinutes: number,
  confidence: DepartureAdviceConfidence,
  withheldReason: DepartureAdviceWithheldReason | null,
): DepartureAdviceResult {
  return {
    currentOption,
    bestOption,
    selectedRoute: bestOption.route,
    departureDate: new Date(bestOption.departureDate),
    directSunSecondsPerJourney: bestOption.directSunSecondsPerJourney,
    directSunRangeSecondsPerJourney: [...bestOption.directSunRangeSecondsPerJourney],
    extraWalkingSeconds: Math.max(
      0,
      bestOption.walkingSecondsPerJourney - currentOption.walkingSecondsPerJourney,
    ),
    sunSecondsSaved: Math.max(
      0,
      currentOption.directSunSecondsPerJourney - bestOption.directSunSecondsPerJourney,
    ),
    modelCoveragePercent: Math.min(
      currentOption.modelCoveragePercent,
      bestOption.modelCoveragePercent,
    ),
    confidence,
    withheldReason,
    recommended: withheldReason === null,
    scannedDepartureCount,
    windowMinutes,
    stepMinutes,
  };
}

/**
 * Finds a lower-direct-sun departure without implying calibrated certainty.
 *
 * At every step, the existing profile-aware route labeller first selects the
 * eligible route trade-off. The scan then compares those selected options.
 * Sensitivity ranges are used as a guard: their ordering must still support a
 * reduction before the result becomes actionable.
 */
export function buildDepartureAdvice({
  routes,
  grid,
  departure,
  profile,
  journeyCount,
  repeatEveryMinutes,
  walkingPace = "standard",
  windowMinutes: requestedWindowMinutes,
  stepMinutes: requestedStepMinutes,
  minimumSavingSeconds: requestedMinimumSavingSeconds,
  minimumCoveragePercent: requestedMinimumCoveragePercent,
}: DepartureAdviceInput): DepartureAdviceResult {
  if (Number.isNaN(departure.getTime())) {
    throw new RangeError("departure must be a valid Date.");
  }

  const windowMinutes = finiteNonNegative(
    requestedWindowMinutes,
    DEFAULT_DEPARTURE_WINDOW_MINUTES,
    "windowMinutes",
  );
  const stepMinutes = finitePositive(
    requestedStepMinutes,
    DEFAULT_DEPARTURE_STEP_MINUTES,
    "stepMinutes",
  );
  const minimumSavingSeconds = finiteNonNegative(
    requestedMinimumSavingSeconds,
    DEFAULT_MINIMUM_SAVING_SECONDS,
    "minimumSavingSeconds",
  );
  const minimumCoveragePercent = finiteNonNegative(
    requestedMinimumCoveragePercent,
    DEFAULT_MINIMUM_COVERAGE_PERCENT,
    "minimumCoveragePercent",
  );
  if (minimumCoveragePercent > 100) {
    throw new RangeError("minimumCoveragePercent must not exceed 100.");
  }
  if (!routes.length) return emptyResult(windowMinutes, stepMinutes);

  const routesById = new Map(routes.map((route) => [route.id, route]));
  const routeOrder = new Map(routes.map((route, index) => [route.id, index]));
  const options: DepartureAdviceOption[] = [];

  for (let offsetMinutes = 0; offsetMinutes <= windowMinutes; offsetMinutes += stepMinutes) {
    const candidateDate = new Date(departure.getTime() + offsetMinutes * 60_000);
    const labelled = labelRouteScores(
      routes.map((route) =>
        scoreRouteSchedule(
          route,
          grid,
          candidateDate,
          journeyCount,
          repeatEveryMinutes,
          walkingPace,
        ),
      ),
      profile,
    );
    const score = selectedScore(labelled);
    const option = score ? toOption(score, routesById, candidateDate) : null;
    if (option) options.push(option);
  }

  const currentOption = options[0];
  if (!currentOption) return emptyResult(windowMinutes, stepMinutes);
  const comparableOptions = currentOption.isDaylight
    ? options.filter((option) => option.isDaylight)
    : options;
  const bestOption = comparableOptions.reduce(
    (best, candidate) => betterOption(candidate, best, routeOrder),
    currentOption,
  );
  const base = (
    confidence: DepartureAdviceConfidence,
    reason: DepartureAdviceWithheldReason | null,
  ) => resultFor(
    currentOption,
    bestOption,
    options.length,
    windowMinutes,
    stepMinutes,
    confidence,
    reason,
  );

  if (!currentOption.isDaylight) return base("unavailable", "no-daylight");
  if (
    currentOption.modelCoveragePercent < minimumCoveragePercent ||
    bestOption.modelCoveragePercent < minimumCoveragePercent
  ) {
    return base("unavailable", "low-model-coverage");
  }

  const sunSecondsSaved = Math.max(
    0,
    currentOption.directSunSecondsPerJourney - bestOption.directSunSecondsPerJourney,
  );
  const relativeThreshold = currentOption.directSunSecondsPerJourney * 0.1;
  const meaningfulThreshold = Math.max(minimumSavingSeconds, relativeThreshold);
  if (sunSecondsSaved + EPSILON_SECONDS < meaningfulThreshold) {
    return base("limited", "insufficient-saving");
  }

  if (
    currentOption.confidenceReasons.includes("low-sun-angle") ||
    bestOption.confidenceReasons.includes("low-sun-angle")
  ) {
    return base("limited", "low-sun-confidence");
  }

  const sensitivitySupportedSaving =
    currentOption.directSunRangeSecondsPerJourney[0] -
    bestOption.directSunRangeSecondsPerJourney[1];
  if (sensitivitySupportedSaving <= EPSILON_SECONDS) {
    return base("limited", "sensitivity-overlap");
  }

  // "Moderate" is deliberate: the engine is deterministic, but its output is
  // a clear-sky model estimate and has not been field-calibrated.
  return base("moderate", null);
}
