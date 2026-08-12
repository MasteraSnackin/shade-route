"use client";

import type {
  DepartureAdviceResult,
  DepartureAdviceWithheldReason,
} from "../lib/departure-advice";

export interface DepartureAdviceProps {
  advice: DepartureAdviceResult | null;
  unavailable?: boolean;
  /** Human-readable name for advice.selectedRoute. */
  routeName?: string;
  onChoose: (departureDate: Date, routeId: string) => void;
}

const londonTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

function roundedMinutes(seconds: number) {
  return Math.max(0, Math.round(seconds / 60));
}

function durationPhrase(seconds: number) {
  if (seconds < 30) return "under 1 min";
  const minutes = Math.max(1, roundedMinutes(seconds));
  return `${minutes} min`;
}

function rangePhrase(range: [number, number]) {
  const low = roundedMinutes(range[0]);
  const high = roundedMinutes(range[1]);
  return low === high ? `${low} min` : `${low}–${high} min`;
}

function withheldMessage(
  reason: DepartureAdviceWithheldReason,
  windowMinutes: number,
) {
  const windowHours = windowMinutes / 60;
  const windowDescription = Number.isInteger(windowHours)
    ? `${windowHours}-hour`
    : `${windowMinutes}-minute`;

  switch (reason) {
    case "no-routes":
      return "Departure advice will appear when walking routes are available.";
    case "no-daylight":
      return "No daylight exposure is modelled for the current journey, so there is no lower-sun departure to suggest.";
    case "low-model-coverage":
      return "Route coverage is too limited for the model to recommend a different departure.";
    case "insufficient-saving":
      return `No meaningfully lower-sun option was found in the next ${windowDescription} window.`;
    case "sensitivity-overlap":
      return "The model sensitivity ranges overlap, so a lower-sun departure cannot be recommended confidently.";
    case "low-sun-confidence":
      return "The sun is too low for small position or surface-data errors to support a departure recommendation.";
  }
}

export function DepartureAdvice({
  advice,
  unavailable = false,
  routeName,
  onChoose,
}: DepartureAdviceProps) {
  if (unavailable) {
    return (
      <aside className="departure-advice">
        <span className="departure-advice__label">Model estimate</span>
        <p>Nearby departure advice is temporarily unavailable. The current route comparison still works.</p>
      </aside>
    );
  }

  if (!advice) {
    return (
      <aside className="departure-advice">
        <span className="departure-advice__label">Model estimate</span>
        <p>Checking nearby departure times…</p>
      </aside>
    );
  }

  if (
    !advice.recommended ||
    advice.withheldReason ||
    !advice.currentOption ||
    !advice.bestOption ||
    !advice.selectedRoute ||
    !advice.departureDate ||
    !advice.directSunRangeSecondsPerJourney
  ) {
    return (
      <aside className="departure-advice">
        <span className="departure-advice__label">Model estimate</span>
        <p>
          {withheldMessage(
            advice.withheldReason ?? "insufficient-saving",
            advice.windowMinutes,
          )}
        </p>
        {advice.modelCoveragePercent !== null && (
          <small>{Math.round(advice.modelCoveragePercent)}% model coverage for the comparison.</small>
        )}
      </aside>
    );
  }

  const laterMinutes = Math.max(
    0,
    Math.round(
      (advice.departureDate.getTime() - advice.currentOption.departureDate.getTime()) /
        60_000,
    ),
  );
  const routeClause = routeName ? ` via ${routeName}` : "";
  const walkingClause = advice.extraWalkingSeconds >= 30
    ? `, with about ${durationPhrase(advice.extraWalkingSeconds)} extra walking`
    : "";
  const recommendation = laterMinutes > 0
    ? `Leave ${laterMinutes} min later${routeClause} to reduce the modelled direct sun by about ${durationPhrase(advice.sunSecondsSaved)} per journey${walkingClause}.`
    : `Use ${routeName ?? "the suggested route"} to reduce the modelled direct sun by about ${durationPhrase(advice.sunSecondsSaved)} per journey${walkingClause}.`;
  const chooseLabel = laterMinutes > 0
    ? `Use the ${londonTime.format(advice.departureDate)} departure${routeName ? ` via ${routeName}` : ""}`
    : `Use ${routeName ?? "the suggested route"}`;

  return (
    <aside
      className="departure-advice departure-advice--recommended"
    >
      <span className="departure-advice__label">Model estimate</span>
      <p><strong>{recommendation}</strong></p>
      <small>
        {rangePhrase(advice.directSunRangeSecondsPerJourney)} direct sun per journey
        {` · ${Math.round(advice.modelCoveragePercent ?? 0)}% model coverage`}
        {` · ${advice.confidence} confidence`}
      </small>
      <button
        type="button"
        onClick={() =>
          onChoose(new Date(advice.departureDate!), advice.selectedRoute!.id)
        }
        aria-label={chooseLabel}
      >
        Choose {londonTime.format(advice.departureDate)}
      </button>
    </aside>
  );
}
