"use client";

import type { LabelledRasterScore } from "../lib/raster-shade";
import { buildShiftTimeline } from "../lib/shift-timeline";
import { WALKING_PACE_PRESETS } from "../lib/walking-pace";

export interface ShiftExposureTimelineProps {
  routeName: string;
  score: LabelledRasterScore;
  selectedJourneyIndex: number;
  onSelectJourney: (index: number) => void;
}

const londonTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

const londonDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
});

function minutes(seconds: number) {
  return Math.max(0, Math.round(seconds / 60));
}

function metres(value: number) {
  if (value < 10) return "under 10 m";
  return `${Math.round(value / 10) * 10} m`;
}

export function ShiftExposureTimeline({
  routeName,
  score,
  selectedJourneyIndex,
  onSelectJourney,
}: ShiftExposureTimelineProps) {
  const journeys = buildShiftTimeline(score);
  if (journeys.length < 2) return null;

  return (
    <section className="shift-timeline" aria-labelledby="shift-timeline-title">
      <header>
        <div>
          <span>Repeated-journey model</span>
          <h3 id="shift-timeline-title">Exposure across this shift</h3>
          <p>{routeName} · {WALKING_PACE_PRESETS[score.walkingPace].label.toLowerCase()} planning pace</p>
        </div>
        <strong>{minutes(score.estimatedDirectSunSeconds)} min potential direct sun in total</strong>
      </header>
      <p>
        Select a journey to preview its timed route sections and ground shadows. This changes the
        preview only; it does not change the planned schedule.
      </p>
      <ol aria-label="Modelled journeys in this shift">
        {journeys.map((journey) => {
          const selected = journey.index === selectedJourneyIndex;
          const range = `${minutes(journey.directSunRangeSeconds[0])}–${minutes(journey.directSunRangeSeconds[1])} min`;
          const departureDay = londonDate.format(journey.departureEpochMs);
          const arrivalDay = londonDate.format(journey.arrivalEpochMs);
          return (
            <li key={journey.index}>
              <button
                type="button"
                aria-pressed={selected}
                className={selected ? "is-selected" : undefined}
                onClick={() => onSelectJourney(journey.index)}
              >
                <span className="shift-timeline__trip">
                  <b>Journey {journey.index + 1}</b>
                  {journey.highestDirectSunInSchedule && <em>Highest potential direct sun</em>}
                </span>
                <span className="shift-timeline__time">
                  <span>
                    <time dateTime={new Date(journey.departureEpochMs).toISOString()}>
                      {londonTime.format(journey.departureEpochMs)}
                    </time>
                    <i aria-hidden="true">→</i>
                    <time dateTime={new Date(journey.arrivalEpochMs).toISOString()}>
                      {londonTime.format(journey.arrivalEpochMs)}
                    </time>
                  </span>
                  <small>{departureDay === arrivalDay ? departureDay : `${departureDay} → ${arrivalDay}`}</small>
                </span>
                <span className="shift-timeline__metrics">
                  <b>
                    {journey.isDaylight
                      ? `${minutes(journey.directSunSeconds)} min potential direct sun · sensitivity ${range}`
                      : "Outside daylight; direct-sun comparison paused"}
                  </b>
                  <small>
                    {journey.shadePercent === null ? "Shade not applicable" : `${Math.round(journey.shadePercent)}% estimated shade`}
                    {journey.isDaylight
                      ? ` · ${Math.round(journey.coveragePercent)}% of daylight journey modelled`
                      : " · daylight coverage not applicable"}
                  </small>
                  <small>
                    {journey.longestDefiniteSunRunMetres > 0
                      ? `Longest definite-sun run about ${metres(journey.longestDefiniteSunRunMetres)}`
                      : "No definite-sun run identified"}
                    {journey.limitedConfidence ? " · limitations flagged" : ""}
                  </small>
                </span>
                <span className="shift-timeline__action">{selected ? "Shown on map" : "Preview on map"}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <small>
        Clear-sky geometric estimates only. Unknown sections remain conservatively included in the
        direct-sun total.
      </small>
    </section>
  );
}
