"use client";

import { useEffect, useMemo, useRef } from "react";
import type { WalkingRoute } from "../lib/routes";
import {
  buildJourneyProgress,
  buildJourneySteps,
  formatJourneyDistance,
  locatePositionOnJourney,
  type JourneyCurrentPosition,
  type JourneyModeScore,
} from "../lib/journey-mode";

export type JourneyLocationRequestStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "denied"
  | "unavailable"
  | "error";

export interface JourneyModeProps {
  route: WalkingRoute;
  score: JourneyModeScore;
  departure: Date;
  activeDirectionIndex: number;
  onActiveDirectionChange: (index: number) => void;
  onExit: () => void;
  currentPosition?: JourneyCurrentPosition | null;
  routeName?: string;
  onReportSection?: () => void;
  /** Requests one browser position reading. It must not start a location watch. */
  onRequestLocation?: () => void;
  locationRequestStatus?: JourneyLocationRequestStatus;
}

const londonTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDuration(seconds: number) {
  if (seconds <= 0) return "0 min";
  if (seconds < 30) return "under 1 min";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function exposureLabel(exposure: string) {
  switch (exposure) {
    case "shade":
      return "Shade ahead";
    case "sun":
      return "Direct sun ahead";
    case "uncertain":
      return "Shade uncertain";
    case "night":
      return "Outside daylight";
    default:
      return "Shade data unavailable";
  }
}

export function JourneyMode({
  route,
  score,
  departure,
  activeDirectionIndex,
  onActiveDirectionChange,
  onExit,
  currentPosition = null,
  routeName,
  onReportSection,
  onRequestLocation,
  locationRequestStatus = currentPosition ? "ready" : "idle",
}: JourneyModeProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const steps = useMemo(() => buildJourneySteps(route), [route]);
  const progress = useMemo(
    () => buildJourneyProgress(route, score, activeDirectionIndex, departure),
    [activeDirectionIndex, departure, route, score],
  );
  const locationEstimate = useMemo(
    () => currentPosition ? locatePositionOnJourney(route, currentPosition) : null,
    [currentPosition, route],
  );
  const locationIsUsable = Boolean(
    locationEstimate && locationEstimate.distanceFromRouteMetres <= 50,
  );
  const stepNumber = progress.activeDirectionIndex + 1;
  const finalStep = progress.activeDirectionIndex === steps.length - 1;
  const locationStatusText = (() => {
    switch (locationRequestStatus) {
      case "requesting":
        return "Checking your current position…";
      case "ready":
        return currentPosition
          ? "Position received. Review the step suggestion below."
          : "A position was received, but no usable coordinates are available.";
      case "denied":
        return "Location permission was not granted. Continue with manual route progress.";
      case "unavailable":
        return "This device could not provide a position. Continue with manual route progress.";
      case "error":
        return "The position check did not work. Continue with manual route progress or try again.";
      default:
        return "Location has not been checked.";
    }
  })();

  useEffect(() => {
    if (!openerRef.current && document.activeElement instanceof HTMLElement) {
      openerRef.current = document.activeElement;
    }
    sectionRef.current?.focus({ preventScroll: true });
  }, []);

  const exitJourneyMode = () => {
    const opener = openerRef.current;
    onExit();
    window.requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
  };

  return (
    <section
      ref={sectionRef}
      className="journey-mode"
      aria-labelledby="journey-mode-title"
      aria-describedby="journey-mode-warning"
      tabIndex={-1}
    >
      <style>{journeyModeStyles}</style>
      <header className="journey-mode__header">
        <div>
          <span className="journey-mode__eyebrow">Route reference</span>
          <h2 id="journey-mode-title">Walk this route</h2>
          {routeName ? <p className="journey-mode__route-name">{routeName}</p> : null}
        </div>
        <button type="button" className="journey-mode__exit" onClick={exitJourneyMode}>
          Exit
        </button>
      </header>

      <div id="journey-mode-warning" className="journey-mode__warning" role="note">
        <strong>Reference only — not emergency navigation.</strong>
        <span>
          Follow signs, crossings, closures and local instructions. Shade and access
          conditions can differ from the model.
        </span>
      </div>

      <p className="journey-mode__sr-status" role="status" aria-atomic="true">
        Step {stepNumber} of {steps.length}. {progress.current.instruction}{" "}
        {progress.complete
          ? "Journey complete."
          : `${progress.upcomingExposure.description} ${formatJourneyDistance(progress.remainingDistanceMetres)} and ${formatDuration(progress.remainingDurationSeconds)} remaining.`}
      </p>

      <div className="journey-mode__status">
        <span>Step {stepNumber} of {steps.length}</span>
        <strong>{progress.current.instruction}</strong>
        <small>
          Expected around {londonTime.format(progress.estimatedStepTime)}
          {progress.current.distanceMetres > 0
            ? ` · ${formatJourneyDistance(progress.current.distanceMetres)}`
            : ""}
        </small>
      </div>

      {progress.complete ? (
        <div className="journey-mode__exposure is-complete">
          <span>Journey complete</span>
          <strong>No route remains to assess.</strong>
          <small>Check your surroundings and follow local signs on arrival.</small>
        </div>
      ) : (
        <div className={`journey-mode__exposure is-${progress.upcomingExposure.exposure}`}>
          <span>{exposureLabel(progress.upcomingExposure.exposure)}</span>
          <strong>{progress.upcomingExposure.description}</strong>
          <small>Clear-sky geometry estimate; it does not predict temperature or UV.</small>
        </div>
      )}

      <dl className="journey-mode__remaining">
        <div>
          <dt>Remaining distance</dt>
          <dd>{formatJourneyDistance(progress.remainingDistanceMetres)}</dd>
        </div>
        <div>
          <dt>Remaining time</dt>
          <dd>{formatDuration(progress.remainingDurationSeconds)}</dd>
        </div>
      </dl>

      {progress.next && (
        <div className="journey-mode__next">
          <span>Then</span>
          <strong>{progress.next.instruction}</strong>
        </div>
      )}

      <div className="journey-mode__controls">
        <label htmlFor="journey-mode-progress">
          Manual route progress
        </label>
        <small id="journey-mode-progress-help" className="journey-mode__controls-help">
          Move this control as you complete each instruction.
        </small>
        <input
          id="journey-mode-progress"
          type="range"
          min={0}
          max={Math.max(0, steps.length - 1)}
          step={1}
          value={progress.activeDirectionIndex}
          onChange={(event) => onActiveDirectionChange(Number(event.target.value))}
          aria-describedby="journey-mode-progress-help"
          aria-valuetext={`Step ${stepNumber} of ${steps.length}: ${progress.current.instruction}`}
        />
        <div className="journey-mode__button-row">
          <button
            type="button"
            disabled={progress.activeDirectionIndex === 0}
            onClick={() => onActiveDirectionChange(progress.activeDirectionIndex - 1)}
          >
            Previous step
          </button>
          <button
            type="button"
            disabled={finalStep}
            onClick={() => onActiveDirectionChange(progress.activeDirectionIndex + 1)}
          >
            Next step
          </button>
        </div>
      </div>

      {onRequestLocation && (
        <div className="journey-mode__position-check">
          <div>
            <strong>Optional position check</strong>
            <small id="journey-mode-location-help">
              Your browser may ask for location. One reading suggests a nearby step;
              it never changes route progress automatically.
            </small>
          </div>
          <button
            type="button"
            disabled={locationRequestStatus === "requesting"}
            onClick={onRequestLocation}
            aria-describedby="journey-mode-location-help journey-mode-location-status"
          >
            {locationRequestStatus === "requesting"
              ? "Checking position…"
              : currentPosition
                ? "Check position again"
                : "Check my position"}
          </button>
          <p id="journey-mode-location-status" role="status" aria-atomic="true">
            {locationStatusText}
          </p>
        </div>
      )}

      {locationEstimate && (
        <div className="journey-mode__location">
          <div>
            <span>Optional location estimate</span>
            <strong>
              {locationIsUsable
                ? `Near step ${locationEstimate.suggestedDirectionIndex + 1}`
                : `${formatJourneyDistance(locationEstimate.distanceFromRouteMetres)} from the route`}
            </strong>
            <small>
              {locationIsUsable
                ? `About ${Math.round(locationEstimate.distanceFromRouteMetres)} m from the route line. Progress is not changed automatically.`
                : "The position is too far from the route line to suggest a step."}
            </small>
          </div>
          {locationIsUsable &&
            locationEstimate.suggestedDirectionIndex !== progress.activeDirectionIndex && (
              <button
                type="button"
                onClick={() =>
                  onActiveDirectionChange(locationEstimate.suggestedDirectionIndex)
                }
              >
                Use suggested step
              </button>
            )}
        </div>
      )}

      {onReportSection && !progress.complete ? (
        <button type="button" className="journey-mode__report" onClick={onReportSection}>
          Report the current section
        </button>
      ) : null}
    </section>
  );
}

const journeyModeStyles = `
  .journey-mode {
    --journey-ink: #13251d;
    --journey-muted: #5d6c65;
    --journey-line: #d9e2dd;
    --journey-green: #176744;
    width: min(100%, 640px);
    margin: 0 auto;
    padding: 18px;
    color: var(--journey-ink);
    background: #fbfdfb;
    border: 1px solid var(--journey-line);
    border-radius: 20px;
    box-shadow: 0 18px 55px rgba(21, 45, 34, 0.14);
  }
  .journey-mode button, .journey-mode input { font: inherit; }
  .journey-mode:focus-visible { outline: 3px solid #e6a43c; outline-offset: 3px; }
  .journey-mode__sr-status {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  .journey-mode__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .journey-mode__header h2 { margin: 3px 0 0; font-size: 24px; letter-spacing: -0.025em; }
  .journey-mode__route-name { margin: 4px 0 0; color: var(--journey-muted); font-size: 12px; }
  .journey-mode__eyebrow, .journey-mode__status > span, .journey-mode__exposure > span,
  .journey-mode__next > span, .journey-mode__location span {
    display: block; color: var(--journey-muted); font-size: 11px; font-weight: 750;
    letter-spacing: .075em; text-transform: uppercase;
  }
  .journey-mode__exit, .journey-mode__button-row button, .journey-mode__location button,
  .journey-mode__position-check button {
    min-height: 44px; padding: 0 14px; border: 1px solid var(--journey-line); border-radius: 11px;
    color: var(--journey-ink); background: #fff; cursor: pointer; font-weight: 700;
  }
  .journey-mode__warning { display: grid; gap: 4px; margin: 16px 0; padding: 12px 14px; border-radius: 12px; background: #fff3d7; }
  .journey-mode__warning strong { font-size: 13px; }
  .journey-mode__warning span { color: #5c4a22; font-size: 12px; line-height: 1.45; }
  .journey-mode__status { min-height: 150px; display: flex; flex-direction: column; justify-content: center; padding: 22px; border-radius: 16px; background: #17392b; color: #fff; }
  .journey-mode__status > span { color: #b9d8ca; }
  .journey-mode__status strong { margin-top: 8px; font-size: clamp(20px, 5vw, 30px); line-height: 1.18; }
  .journey-mode__status small { margin-top: 10px; color: #d5e7df; }
  .journey-mode__exposure { display: grid; gap: 6px; margin-top: 12px; padding: 15px; border-left: 5px solid #77847e; border-radius: 12px; background: #f0f3f1; }
  .journey-mode__exposure.is-shade { border-left-color: #237451; background: #eaf6ef; }
  .journey-mode__exposure.is-sun { border-left-color: #d68712; background: #fff4d9; }
  .journey-mode__exposure.is-uncertain { border-left-color: #8065a8; background: #f4effa; }
  .journey-mode__exposure.is-night { border-left-color: #44516b; background: #edf0f6; }
  .journey-mode__exposure.is-complete { border-left-color: var(--journey-green); background: #eaf6ef; }
  .journey-mode__exposure strong { font-size: 15px; line-height: 1.4; }
  .journey-mode__exposure small { color: var(--journey-muted); font-size: 11px; line-height: 1.4; }
  .journey-mode__remaining { display: grid; grid-template-columns: 1fr 1fr; margin: 12px 0 0; border: 1px solid var(--journey-line); border-radius: 12px; overflow: hidden; }
  .journey-mode__remaining div { padding: 13px 15px; }
  .journey-mode__remaining div + div { border-left: 1px solid var(--journey-line); }
  .journey-mode__remaining dt { color: var(--journey-muted); font-size: 11px; }
  .journey-mode__remaining dd { margin: 4px 0 0; font-size: 18px; font-weight: 780; }
  .journey-mode__next { display: grid; gap: 4px; margin-top: 12px; padding: 12px 15px; border: 1px solid var(--journey-line); border-radius: 12px; }
  .journey-mode__next strong { font-size: 13px; }
  .journey-mode__controls { margin-top: 18px; }
  .journey-mode__controls label { display: block; font-size: 13px; font-weight: 750; }
  .journey-mode__controls-help { display: block; margin-top: 2px; color: var(--journey-muted); font-size: 11px; }
  .journey-mode__controls input { width: 100%; height: 44px; margin: 5px 0 8px; accent-color: var(--journey-green); cursor: pointer; }
  .journey-mode__button-row { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  .journey-mode__button-row button:last-child { border-color: var(--journey-green); color: #fff; background: var(--journey-green); }
  .journey-mode button:disabled { cursor: not-allowed; opacity: .42; }
  .journey-mode__location { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding: 13px 15px; border: 1px dashed #aebbb4; border-radius: 12px; }
  .journey-mode__location strong, .journey-mode__location small { display: block; margin-top: 3px; }
  .journey-mode__location small { color: var(--journey-muted); font-size: 11px; line-height: 1.35; }
  .journey-mode__position-check { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px 14px; margin-top: 12px; padding: 13px 15px; border: 1px solid var(--journey-line); border-radius: 12px; }
  .journey-mode__position-check strong, .journey-mode__position-check small { display: block; }
  .journey-mode__position-check strong { font-size: 13px; }
  .journey-mode__position-check small, .journey-mode__position-check p { color: var(--journey-muted); font-size: 11px; line-height: 1.4; }
  .journey-mode__position-check small { margin-top: 3px; }
  .journey-mode__position-check p { grid-column: 1 / -1; margin: 0; }
  .journey-mode__report { width: 100%; min-height: 44px; margin-top: 12px; border: 1px solid var(--journey-green); border-radius: 11px; color: var(--journey-green); background: #fff; font-weight: 750; cursor: pointer; }
  @media (max-width: 520px) {
    .journey-mode { padding: 13px; border-radius: 0; box-shadow: none; }
    .journey-mode__status { min-height: 135px; padding: 18px; }
    .journey-mode__location { align-items: stretch; flex-direction: column; }
    .journey-mode__position-check { grid-template-columns: 1fr; align-items: stretch; }
    .journey-mode__position-check p { grid-column: auto; }
  }
`;
