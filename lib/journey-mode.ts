import type { ExposureState, RasterRouteScore } from "./raster-shade.ts";
import type { RouteShadeScore } from "./shade.ts";
import { buildShadeProfile } from "./shade-profile.ts";
import { haversineMetres, type Coordinate, type WalkingRoute } from "./routes.ts";

export type JourneyModeScore =
  | Pick<RasterRouteScore, "distanceMetres" | "sections">
  | Pick<RouteShadeScore, "distanceM" | "segments">
  | null;

export type JourneyCurrentPosition =
  | Coordinate
  | { longitude: number; latitude: number };

export interface JourneyStep {
  index: number;
  instruction: string;
  distanceMetres: number;
  durationSeconds: number;
  startDistanceMetres: number;
  endDistanceMetres: number;
  startOffsetSeconds: number;
  endOffsetSeconds: number;
}

export interface JourneyExposureSpan {
  exposure: ExposureState;
  startDistanceMetres: number;
  endDistanceMetres: number;
  distanceMetres: number;
}

export interface UpcomingExposure {
  exposure: ExposureState;
  distanceMetres: number;
  nextExposure: ExposureState | null;
  description: string;
}

export interface JourneyLocationEstimate {
  distanceAlongRouteMetres: number;
  distanceFromRouteMetres: number;
  suggestedDirectionIndex: number;
}

export interface JourneyProgressSummary {
  activeDirectionIndex: number;
  current: JourneyStep;
  next: JourneyStep | null;
  complete: boolean;
  remainingDistanceMetres: number;
  remainingDurationSeconds: number;
  estimatedStepTime: Date;
  upcomingExposure: UpcomingExposure;
}

const EXPOSURE_STATES = new Set<ExposureState>([
  "sun",
  "shade",
  "uncertain",
  "unknown",
  "night",
]);

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteNonNegative(value: number, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function routeCumulativeDistances(route: WalkingRoute) {
  const cumulative = [0];
  for (let index = 1; index < route.coordinates.length; index += 1) {
    cumulative.push(
      cumulative[index - 1] +
        haversineMetres(route.coordinates[index - 1], route.coordinates[index]),
    );
  }
  return cumulative;
}

/**
 * Turns routing maneuvers into a stable, distance- and time-based journey model.
 * Geometry indices are preferred for position; maneuver totals are used as a
 * fallback when a provider omits usable indices.
 */
export function buildJourneySteps(route: WalkingRoute): JourneyStep[] {
  const routeDistance = finiteNonNegative(route.distanceMetres);
  const routeDuration = finiteNonNegative(route.durationSeconds);
  const directions = route.directions.length
    ? route.directions
    : [
        {
          instruction: "Continue to the destination.",
          distanceMetres: routeDistance,
          durationSeconds: routeDuration,
          beginIndex: 0,
          endIndex: Math.max(0, route.coordinates.length - 1),
        },
      ];
  const cumulativeGeometry = routeCumulativeDistances(route);
  const geometryDistance = cumulativeGeometry.at(-1) ?? 0;
  const directionDistance = directions.reduce(
    (sum, direction) => sum + finiteNonNegative(direction.distanceMetres),
    0,
  );
  const directionDuration = directions.reduce(
    (sum, direction) => sum + finiteNonNegative(direction.durationSeconds),
    0,
  );
  let fallbackDistance = 0;
  let elapsedDirectionSeconds = 0;

  return directions.map((direction, index) => {
    const beginIndex = Math.floor(direction.beginIndex);
    const endIndex = Math.floor(direction.endIndex);
    const indicesUsable =
      geometryDistance > 0 &&
      beginIndex >= 0 &&
      endIndex >= beginIndex &&
      endIndex < cumulativeGeometry.length;
    const fallbackStart = directionDistance > 0
      ? (fallbackDistance / directionDistance) * routeDistance
      : index === 0
        ? 0
        : routeDistance;
    const fallbackEnd = directionDistance > 0
      ? ((fallbackDistance + finiteNonNegative(direction.distanceMetres)) /
          directionDistance) *
        routeDistance
      : routeDistance;
    let startDistanceMetres = indicesUsable
      ? (cumulativeGeometry[beginIndex] / geometryDistance) * routeDistance
      : fallbackStart;
    let endDistanceMetres = indicesUsable
      ? (cumulativeGeometry[endIndex] / geometryDistance) * routeDistance
      : fallbackEnd;

    startDistanceMetres = clamp(startDistanceMetres, 0, routeDistance);
    endDistanceMetres = clamp(
      Math.max(startDistanceMetres, endDistanceMetres),
      0,
      routeDistance,
    );
    const startOffsetSeconds = directionDuration > 0
      ? (elapsedDirectionSeconds / directionDuration) * routeDuration
      : routeDistance > 0
        ? (startDistanceMetres / routeDistance) * routeDuration
        : 0;
    const nextElapsedDirectionSeconds =
      elapsedDirectionSeconds + finiteNonNegative(direction.durationSeconds);
    const endOffsetSeconds = directionDuration > 0
      ? (nextElapsedDirectionSeconds / directionDuration) * routeDuration
      : routeDistance > 0
        ? (endDistanceMetres / routeDistance) * routeDuration
        : routeDuration;

    fallbackDistance += finiteNonNegative(direction.distanceMetres);
    elapsedDirectionSeconds = nextElapsedDirectionSeconds;
    return {
      index,
      instruction: direction.instruction.trim() || "Continue.",
      distanceMetres: finiteNonNegative(direction.distanceMetres),
      durationSeconds: finiteNonNegative(direction.durationSeconds),
      startDistanceMetres,
      endDistanceMetres,
      startOffsetSeconds: clamp(startOffsetSeconds, 0, routeDuration),
      endOffsetSeconds: clamp(endOffsetSeconds, 0, routeDuration),
    };
  });
}

function mergeExposureSpans(spans: JourneyExposureSpan[]) {
  const merged: JourneyExposureSpan[] = [];
  for (const span of spans) {
    if (span.endDistanceMetres - span.startDistanceMetres <= 0.01) continue;
    const previous = merged.at(-1);
    if (
      previous?.exposure === span.exposure &&
      Math.abs(previous.endDistanceMetres - span.startDistanceMetres) <= 0.1
    ) {
      previous.endDistanceMetres = span.endDistanceMetres;
      previous.distanceMetres = previous.endDistanceMetres - previous.startDistanceMetres;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function completeExposureCoverage(
  spans: JourneyExposureSpan[],
  routeDistanceMetres: number,
) {
  const routeDistance = finiteNonNegative(routeDistanceMetres);
  const completed: JourneyExposureSpan[] = [];
  let cursor = 0;
  const sorted = [...spans].sort(
    (left, right) => left.startDistanceMetres - right.startDistanceMetres,
  );

  for (const span of sorted) {
    const start = clamp(span.startDistanceMetres, cursor, routeDistance);
    const end = clamp(span.endDistanceMetres, start, routeDistance);
    if (start > cursor + 0.01) {
      completed.push({
        exposure: "unknown",
        startDistanceMetres: cursor,
        endDistanceMetres: start,
        distanceMetres: start - cursor,
      });
    }
    if (end > start + 0.01) {
      completed.push({
        ...span,
        startDistanceMetres: start,
        endDistanceMetres: end,
        distanceMetres: end - start,
      });
      cursor = end;
    }
    if (cursor >= routeDistance) break;
  }
  if (cursor < routeDistance - 0.01) {
    completed.push({
      exposure: "unknown",
      startDistanceMetres: cursor,
      endDistanceMetres: routeDistance,
      distanceMetres: routeDistance - cursor,
    });
  }
  if (!completed.length && routeDistance === 0) {
    completed.push({
      exposure: "unknown",
      startDistanceMetres: 0,
      endDistanceMetres: 0,
      distanceMetres: 0,
    });
  }
  return mergeExposureSpans(completed);
}

/** Supports both the current raster score and the earlier geometric score. */
export function exposureSpansForJourney(
  score: JourneyModeScore,
  routeDistanceMetres: number,
): JourneyExposureSpan[] {
  const routeDistance = finiteNonNegative(routeDistanceMetres);
  if (!score) return completeExposureCoverage([], routeDistance);

  if ("sections" in score) {
    const profile = buildShadeProfile(score.sections, routeDistance);
    const profileDistance = profile.segments.at(-1)?.endDistanceMetres ?? 0;
    const distanceScale = profileDistance > 0 ? routeDistance / profileDistance : 1;
    return completeExposureCoverage(
      profile.segments.map((segment) => ({
        exposure: EXPOSURE_STATES.has(segment.exposure)
          ? segment.exposure
          : "unknown",
        startDistanceMetres: segment.startDistanceMetres * distanceScale,
        endDistanceMetres: segment.endDistanceMetres * distanceScale,
        distanceMetres: segment.distanceMetres * distanceScale,
      })),
      routeDistance,
    );
  }

  const scoreDistance = finiteNonNegative(score.distanceM, routeDistance);
  const distanceScale = scoreDistance > 0 ? routeDistance / scoreDistance : 1;
  return completeExposureCoverage(
    score.segments.map((segment) => {
      const exposure: ExposureState = segment.exposure === "mixed"
        ? "uncertain"
        : EXPOSURE_STATES.has(segment.exposure as ExposureState)
          ? (segment.exposure as ExposureState)
          : "unknown";
      const startDistanceMetres = segment.startDistanceM * distanceScale;
      const endDistanceMetres = segment.endDistanceM * distanceScale;
      return {
        exposure,
        startDistanceMetres,
        endDistanceMetres,
        distanceMetres: Math.max(0, endDistanceMetres - startDistanceMetres),
      };
    }),
    routeDistance,
  );
}

export function formatJourneyDistance(metres: number) {
  const safeMetres = finiteNonNegative(metres);
  if (safeMetres < 1) return "0 m";
  if (safeMetres < 10) return "under 10 m";
  if (safeMetres < 1000) return `${Math.max(10, Math.round(safeMetres / 10) * 10)} m`;
  return `${(safeMetres / 1000).toFixed(1)} km`;
}

function nextExposurePhrase(exposure: ExposureState) {
  switch (exposure) {
    case "shade":
      return "estimated shade";
    case "sun":
      return "estimated direct sun";
    case "uncertain":
      return "an uncertain section";
    case "night":
      return "a section outside daylight";
    default:
      return "a section without shade data";
  }
}

function exposureDescription(
  exposure: ExposureState,
  distanceMetres: number,
  nextExposure: ExposureState | null,
) {
  const distance = formatJourneyDistance(distanceMetres);
  const following = nextExposure && nextExposure !== exposure
    ? ` Then ${nextExposurePhrase(nextExposure)}.`
    : "";
  switch (exposure) {
    case "shade":
      return `Estimated shade for the next ${distance}.${following}`;
    case "sun":
      return `Estimated direct sun under clear skies for the next ${distance}.${following}`;
    case "uncertain":
      return `Shade is uncertain for the next ${distance}; small model or position changes could alter it.${following}`;
    case "night":
      return `The next ${distance} is outside daylight.${following}`;
    default:
      return `Shade data is unavailable for the next ${distance}.${following}`;
  }
}

export function upcomingExposureAtDistance(
  spans: JourneyExposureSpan[],
  distanceAlongRouteMetres: number,
  routeDistanceMetres: number,
): UpcomingExposure {
  const routeDistance = finiteNonNegative(routeDistanceMetres);
  const distance = clamp(
    finiteNonNegative(distanceAlongRouteMetres),
    0,
    routeDistance,
  );
  if (routeDistance <= 0.01 || distance >= routeDistance - 0.01) {
    return {
      exposure: "unknown",
      distanceMetres: 0,
      nextExposure: null,
      description: "The journey is complete; no route remains to assess.",
    };
  }
  const activeIndex = spans.findIndex(
    (span, index) =>
      span.endDistanceMetres > distance + 0.01 ||
      (index === spans.length - 1 && distance <= span.endDistanceMetres + 0.01),
  );
  const active = activeIndex >= 0 ? spans[activeIndex] : null;
  const exposure = active?.exposure ?? "unknown";
  const distanceMetres = active
    ? Math.max(0, active.endDistanceMetres - distance)
    : Math.max(0, routeDistance - distance);
  const nextExposure = activeIndex >= 0
    ? spans.slice(activeIndex + 1).find((span) => span.exposure !== exposure)?.exposure ?? null
    : null;
  return {
    exposure,
    distanceMetres,
    nextExposure,
    description: exposureDescription(exposure, distanceMetres, nextExposure),
  };
}

/**
 * Finds the closest point on the route using a local planar projection. The
 * caller decides whether an off-route estimate is close enough to act on.
 */
export function locatePositionOnJourney(
  route: WalkingRoute,
  currentPosition: JourneyCurrentPosition,
): JourneyLocationEstimate | null {
  if (route.coordinates.length < 2) return null;
  const position: Coordinate = Array.isArray(currentPosition)
    ? currentPosition
    : [currentPosition.longitude, currentPosition.latitude];
  if (!position.every(Number.isFinite)) return null;

  const latitudeRadians = (position[1] * Math.PI) / 180;
  const longitudeScale = 111_320 * Math.cos(latitudeRadians);
  const latitudeScale = 110_540;
  const toLocal = (coordinate: Coordinate) => ({
    x: (coordinate[0] - position[0]) * longitudeScale,
    y: (coordinate[1] - position[1]) * latitudeScale,
  });
  const cumulative = routeCumulativeDistances(route);
  const geometryDistance = cumulative.at(-1) ?? 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  let distanceAlongGeometry = 0;

  for (let index = 1; index < route.coordinates.length; index += 1) {
    const start = toLocal(route.coordinates[index - 1]);
    const end = toLocal(route.coordinates[index]);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const squaredLength = dx * dx + dy * dy;
    const fraction = squaredLength > 0
      ? clamp((-(start.x * dx + start.y * dy)) / squaredLength, 0, 1)
      : 0;
    const nearestX = start.x + dx * fraction;
    const nearestY = start.y + dy * fraction;
    const distanceFromSegment = Math.hypot(nearestX, nearestY);
    if (distanceFromSegment < closestDistance) {
      closestDistance = distanceFromSegment;
      distanceAlongGeometry =
        cumulative[index - 1] +
        (cumulative[index] - cumulative[index - 1]) * fraction;
    }
  }

  const routeDistance = finiteNonNegative(route.distanceMetres);
  const distanceAlongRouteMetres = geometryDistance > 0
    ? (distanceAlongGeometry / geometryDistance) * routeDistance
    : 0;
  const steps = buildJourneySteps(route);
  let suggestedDirectionIndex = steps.findIndex(
    (step) => step.endDistanceMetres > distanceAlongRouteMetres + 0.01,
  );
  if (suggestedDirectionIndex < 0) suggestedDirectionIndex = Math.max(0, steps.length - 1);
  return {
    distanceAlongRouteMetres,
    distanceFromRouteMetres: closestDistance,
    suggestedDirectionIndex,
  };
}

export function buildJourneyProgress(
  route: WalkingRoute,
  score: JourneyModeScore,
  activeDirectionIndex: number,
  departure: Date,
): JourneyProgressSummary {
  const steps = buildJourneySteps(route);
  const resolvedIndex = clamp(
    Number.isFinite(activeDirectionIndex) ? Math.floor(activeDirectionIndex) : 0,
    0,
    Math.max(0, steps.length - 1),
  );
  const current = steps[resolvedIndex];
  const routeDistance = finiteNonNegative(route.distanceMetres);
  const routeDuration = finiteNonNegative(route.durationSeconds);
  const remainingDistanceMetres = Math.max(
    0,
    routeDistance - current.startDistanceMetres,
  );
  const remainingDurationSeconds = Math.max(
    0,
    routeDuration - current.startOffsetSeconds,
  );
  const complete =
    remainingDistanceMetres <= 0.01 && remainingDurationSeconds <= 0.01;
  const departureTime = departure instanceof Date && Number.isFinite(departure.getTime())
    ? departure.getTime()
    : Date.now();
  const spans = exposureSpansForJourney(score, routeDistance);

  return {
    activeDirectionIndex: resolvedIndex,
    current,
    next: steps[resolvedIndex + 1] ?? null,
    complete,
    remainingDistanceMetres,
    remainingDurationSeconds,
    estimatedStepTime: new Date(departureTime + current.startOffsetSeconds * 1000),
    upcomingExposure: upcomingExposureAtDistance(
      spans,
      current.startDistanceMetres,
      routeDistance,
    ),
  };
}
