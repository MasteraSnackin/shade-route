export type RouteTimeDifference =
  | { kind: "same"; displayedMinutes: 0 }
  | { kind: "under-minute"; displayedMinutes: 0 }
  | { kind: "minutes"; displayedMinutes: number };

const SAME_TIME_TOLERANCE_SECONDS = 1;

/**
 * Describes extra walking time without contradicting the rounded journey totals.
 * A sub-minute difference remains visible instead of being rounded to "no extra time".
 */
export function compareRouteTimes(
  durationSeconds: number,
  fastestDurationSeconds: number,
): RouteTimeDifference {
  const extraSeconds = Math.max(0, durationSeconds - fastestDurationSeconds);
  if (extraSeconds <= SAME_TIME_TOLERANCE_SECONDS) {
    return { kind: "same", displayedMinutes: 0 };
  }

  const displayedMinutes = Math.max(
    0,
    Math.round(durationSeconds / 60) - Math.round(fastestDurationSeconds / 60),
  );
  return displayedMinutes > 0
    ? { kind: "minutes", displayedMinutes }
    : { kind: "under-minute", displayedMinutes: 0 };
}

export function routeCardExtraTimeLabel(comparison: RouteTimeDifference) {
  if (comparison.kind === "same") return "No extra time";
  if (comparison.kind === "under-minute") return "Under 1 min vs fastest";
  return `+${comparison.displayedMinutes} min vs fastest`;
}

export function routeLongerTimeLabel(comparison: RouteTimeDifference) {
  if (comparison.kind === "same") return "Similar journey time";
  if (comparison.kind === "under-minute") return "Under 1 min longer per journey";
  return `${comparison.displayedMinutes} min longer per journey`;
}

export function routeExtraWalkingLabel(comparison: RouteTimeDifference) {
  if (comparison.kind === "same") return "No extra walking time";
  if (comparison.kind === "under-minute") return "Under 1 min extra walking";
  return `${comparison.displayedMinutes} min extra walking`;
}
