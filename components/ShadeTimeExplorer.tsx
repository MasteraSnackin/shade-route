"use client";

import { useEffect, useId, useMemo, useState } from "react";
import * as SunCalc from "suncalc";
import type { ExposureState, ScheduleScore } from "../lib/raster-shade";
import {
  londonDateTimeValue,
  parseLondonDateTime,
} from "../lib/london-time";
import {
  buildShadeProfile,
  dateTimeLocalAtMinutes,
  minutesFromDateTimeLocal,
  SHADE_PLAYER_END_MINUTES,
  SHADE_PLAYER_START_MINUTES,
} from "../lib/shade-profile";

interface ShadeTimeExplorerProps {
  departure: string;
  formattedDeparture: string;
  routeName: string;
  originName: string;
  destinationName: string;
  latitude: number;
  longitude: number;
  score: ScheduleScore | null;
  onDepartureChange: (value: string) => void;
  onPlaybackChange?: (playing: boolean) => void;
}

const FIRST_MINUTE = SHADE_PLAYER_START_MINUTES;
const LAST_MINUTE = SHADE_PLAYER_END_MINUTES;
const PLAYER_STEP_MINUTES = 15;
const PLAY_INTERVAL_MILLISECONDS = 900;

const EXPOSURE_LABELS: Record<ExposureState, string> = {
  sun: "potential direct sun",
  shade: "estimated shade",
  uncertain: "uncertain",
  unknown: "unknown or unmodelled",
  night: "after sunset",
};

const EXPOSURE_ORDER: ExposureState[] = [
  "sun",
  "shade",
  "uncertain",
  "unknown",
  "night",
];

function clockTime(minutes: number) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function wrappedMinute(current: number, change: number) {
  const playerSpan = LAST_MINUTE - FIRST_MINUTE + PLAYER_STEP_MINUTES;
  return FIRST_MINUTE + (
    ((current - FIRST_MINUTE + change) % playerSpan) + playerSpan
  ) % playerSpan;
}

export function ShadeTimeExplorer({
  departure,
  formattedDeparture,
  routeName,
  originName,
  destinationName,
  latitude,
  longitude,
  score,
  onDepartureChange,
  onPlaybackChange,
}: ShadeTimeExplorerProps) {
  const dateInputId = useId();
  const timeInputId = useId();
  const timeHelpId = useId();
  const [playing, setPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 2 | 4>(1);
  const [controlsExpanded, setControlsExpanded] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);

  const dateValue = /^(\d{4}-\d{2}-\d{2})T/.exec(departure)?.[1] ?? "";
  const departureMinutes = minutesFromDateTimeLocal(departure);
  const selectedMinute = departureMinutes === null
    ? FIRST_MINUTE
    : Math.max(FIRST_MINUTE, Math.min(LAST_MINUTE, departureMinutes));
  const controlsDisabled = !dateValue;
  const sunlight = useMemo(() => {
    const date = parseLondonDateTime(dateValue ? `${dateValue}T12:00` : departure);
    if (!date) return null;
    const times = SunCalc.getTimes(date, latitude, longitude);
    if (!times.sunrise || !times.sunset) return null;
    const sunrise = minutesFromDateTimeLocal(londonDateTimeValue(times.sunrise));
    const sunset = minutesFromDateTimeLocal(londonDateTimeValue(times.sunset));
    if (sunrise === null || sunset === null) return null;
    return { sunrise, sunset };
  }, [dateValue, departure, latitude, longitude]);
  const routeDistance = score
    ? score.distanceMetres / Math.max(1, score.journeyCount)
    : undefined;
  const profile = useMemo(
    () => buildShadeProfile(score?.sections ?? [], routeDistance),
    [routeDistance, score?.sections],
  );
  const visibleTotals = EXPOSURE_ORDER.filter(
    (exposure) => profile.totals[exposure].distanceMetres > 0,
  );
  const distanceSummary = visibleTotals
    .map((exposure) => `${Math.round(profile.totals[exposure].percent)}% ${EXPOSURE_LABELS[exposure]}`)
    .join(", ");

  const shadePercent = Math.round(profile.totals.shade.percent);
  const sunPercent = Math.round(profile.totals.sun.percent);
  const nightPercent = Math.round(profile.totals.night.percent);
  const routeSummary = !score || !profile.segments.length
    ? "Calculating this route’s shade"
    : nightPercent >= 99
      ? "After sunset — direct-sun routing is paused"
      : `${shadePercent}% estimated shade · ${sunPercent}% potential direct sun`;
  const liveSummary = score && profile.segments.length
    ? `${routeName} at ${formattedDeparture}: ${distanceSummary} by route distance.`
    : `A shade profile for ${routeName} at ${formattedDeparture} is unavailable.`;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const compact = window.matchMedia("(max-width: 760px)");
    const update = (event: MediaQueryListEvent) => {
      setReducedMotion(event.matches);
      if (event.matches) {
        setPlaying(false);
        onPlaybackChange?.(false);
      }
    };
    media.addEventListener("change", update);
    const frame = window.requestAnimationFrame(() => {
      setReducedMotion(media.matches);
      if (media.matches) setPlaying(false);
      if (compact.matches) setControlsExpanded(false);
    });
    const updateCompact = (event: MediaQueryListEvent) => {
      if (!event.matches) setControlsExpanded(true);
    };
    compact.addEventListener("change", updateCompact);
    return () => {
      media.removeEventListener("change", update);
      compact.removeEventListener("change", updateCompact);
      window.cancelAnimationFrame(frame);
      onPlaybackChange?.(false);
    };
  }, [onPlaybackChange]);

  useEffect(() => {
    if (!playing || controlsDisabled) return;
    const timer = window.setInterval(() => {
      const current = minutesFromDateTimeLocal(departure) ?? FIRST_MINUTE;
      onDepartureChange(
        dateTimeLocalAtMinutes(
          dateValue,
          wrappedMinute(current, PLAYER_STEP_MINUTES * playbackSpeed),
        ),
      );
    }, PLAY_INTERVAL_MILLISECONDS);
    return () => window.clearInterval(timer);
  }, [controlsDisabled, dateValue, departure, onDepartureChange, playbackSpeed, playing]);

  function changeDate(value: string) {
    if (value) onDepartureChange(dateTimeLocalAtMinutes(value, selectedMinute));
  }

  function changeTime(minutes: number) {
    if (dateValue) onDepartureChange(dateTimeLocalAtMinutes(dateValue, minutes));
  }

  function moveTime(change: number) {
    changeTime(wrappedMinute(selectedMinute, change));
  }

  function showNow() {
    onDepartureChange(londonDateTimeValue(new Date()));
  }

  return (
    <section
      className={`shade-explorer${controlsExpanded ? "" : " is-collapsed"}`}
      aria-labelledby={`${timeInputId}-title`}
    >
      <header className="shade-explorer__header">
        <div className="shade-explorer__heading">
          <span className="shade-explorer__eyebrow">3D shade playback</span>
          <h3 id={`${timeInputId}-title`}>Watch the shade move</h3>
          <p>
            {routeName}
            {score && score.journeyCount > 1 ? ` · first of ${score.journeyCount} journeys` : ""}
          </p>
        </div>
        <div className="shade-explorer__departure">
          <span>London time</span>
          <strong>{formattedDeparture}</strong>
        </div>
        <button
          type="button"
          className="shade-explorer__collapse"
          aria-expanded={controlsExpanded}
          aria-controls={`${timeInputId}-controls`}
          onClick={() => setControlsExpanded((current) => !current)}
        >
          {controlsExpanded ? "Hide controls" : "Show controls"}
        </button>
      </header>

      <div id={`${timeInputId}-controls`} className="shade-explorer__controls">
      <div className="shade-explorer__timeline" role="group" aria-label="Shade time controls">
        <button
          type="button"
          className="shade-explorer__step"
          disabled={controlsDisabled}
          aria-label="Show 30 minutes earlier"
          onClick={() => moveTime(-30)}
        >
          −30
        </button>
        <button
          type="button"
          className="shade-explorer__play-button"
          disabled={controlsDisabled || reducedMotion}
          aria-pressed={playing}
          title={reducedMotion ? "Animation is disabled by your reduced-motion setting" : undefined}
          onClick={() => setPlaying((current) => {
            const next = !current;
            onPlaybackChange?.(next);
            return next;
          })}
        >
          {playing ? "Pause" : "Play"}
        </button>

        <div className="shade-explorer__time-field">
          <div className="shade-explorer__time-label">
            <label htmlFor={timeInputId}>Time of day</label>
            <output htmlFor={timeInputId}>{clockTime(selectedMinute)}</output>
          </div>
          <input
            id={timeInputId}
            type="range"
            min={FIRST_MINUTE}
            max={LAST_MINUTE}
            step={PLAYER_STEP_MINUTES}
            value={selectedMinute}
            disabled={controlsDisabled}
            aria-describedby={timeHelpId}
            aria-valuetext={`Departure ${formattedDeparture}, London time`}
            onChange={(event) => changeTime(Number(event.currentTarget.value))}
          />
          {sunlight && (
            <div className="shade-explorer__sun-window" aria-hidden="true">
              <i style={{ left: `${(sunlight.sunrise / LAST_MINUTE) * 100}%` }} />
              <span
                style={{
                  left: `${(sunlight.sunrise / LAST_MINUTE) * 100}%`,
                  width: `${((sunlight.sunset - sunlight.sunrise) / LAST_MINUTE) * 100}%`,
                }}
              />
              <i style={{ left: `${(sunlight.sunset / LAST_MINUTE) * 100}%` }} />
            </div>
          )}
          <div className="shade-explorer__range-ends" aria-hidden="true">
            <span>00:00</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>23:45</span>
          </div>
          <p id={timeHelpId} className="shade-explorer__time-help">
            Drag to move the ground shadows in 15-minute steps.
          </p>
        </div>

        <button
          type="button"
          className="shade-explorer__step"
          disabled={controlsDisabled}
          aria-label="Show 30 minutes later"
          onClick={() => moveTime(30)}
        >
          +30
        </button>
      </div>

      <footer className="shade-explorer__footer">
        <label className="shade-explorer__date-field" htmlFor={dateInputId}>
          <span>Date</span>
          <input
            id={dateInputId}
            type="date"
            value={dateValue}
            onChange={(event) => changeDate(event.currentTarget.value)}
          />
        </label>

        <div className="shade-explorer__quick-times" aria-label="Quick shade times">
          <button type="button" onClick={showNow}>Now</button>
          {sunlight && (
            <>
              <button type="button" onClick={() => changeTime(sunlight.sunrise)}>
                Sunrise {clockTime(sunlight.sunrise)}
              </button>
              <button type="button" onClick={() => changeTime(sunlight.sunset)}>
                Sunset {clockTime(sunlight.sunset)}
              </button>
            </>
          )}
          <label>
            Playback
            <select
              value={playbackSpeed}
              disabled={reducedMotion}
              onChange={(event) => setPlaybackSpeed(Number(event.currentTarget.value) as 1 | 2 | 4)}
            >
              <option value={1}>1×</option>
              <option value={2}>2×</option>
              <option value={4}>4×</option>
            </select>
          </label>
        </div>

        <div className="shade-explorer__route-profile">
          <div className="shade-profile__endpoints" aria-hidden="true">
            <b>A</b>
            <span>{originName} to {destinationName}</span>
            <b>B</b>
          </div>
          <div
            className="shade-profile__track"
            role="img"
            aria-label={`${routeName}: ${distanceSummary || "shade still calculating"}`}
          >
            {profile.segments.map((segment) => (
              <span
                key={`${segment.startDistanceMetres}-${segment.endDistanceMetres}-${segment.exposure}`}
                className={`shade-profile__segment shade-profile__segment--${segment.exposure}`}
                style={{ flexBasis: `${segment.percent}%` }}
                aria-hidden="true"
              />
            ))}
          </div>
          <p>{routeSummary}</p>
        </div>
      </footer>

      <p
        className="shade-explorer__live-summary"
        aria-live={playing ? "off" : "polite"}
        aria-atomic="true"
      >
        {liveSummary}
      </p>
      </div>
    </section>
  );
}
