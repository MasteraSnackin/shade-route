import type { LabelledRasterScore } from "./raster-shade.ts";
import { haversineMetres } from "./routes.ts";

function scheduleOffsetMilliseconds(index: number, repeatEveryMinutes: number) {
  const safeIndex = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const safeInterval = Number.isFinite(repeatEveryMinutes)
    ? Math.max(0, repeatEveryMinutes)
    : 0;
  return safeIndex * safeInterval * 60_000;
}

/** Keeps a selected repeated journey stable while its newly timed score is pending. */
export function departureForShiftJourney(
  baseDeparture: Date,
  index: number,
  repeatEveryMinutes: number,
) {
  return new Date(
    baseDeparture.getTime() + scheduleOffsetMilliseconds(index, repeatEveryMinutes),
  );
}

/** Converts a scrubbed journey time back into the schedule's first departure. */
export function baseDepartureFromShiftJourney(
  journeyDeparture: Date,
  index: number,
  repeatEveryMinutes: number,
) {
  return new Date(
    journeyDeparture.getTime() - scheduleOffsetMilliseconds(index, repeatEveryMinutes),
  );
}

export interface ShiftTimelineJourney {
  index: number;
  departureEpochMs: number;
  arrivalEpochMs: number;
  durationSeconds: number;
  directSunSeconds: number;
  directSunRangeSeconds: [number, number];
  shadePercent: number | null;
  coveragePercent: number;
  isDaylight: boolean;
  limitedConfidence: boolean;
  longestDefiniteSunRunMetres: number;
  highestDirectSunInSchedule: boolean;
}

function longestDefiniteSunRunMetres(
  sections: LabelledRasterScore["sections"],
) {
  let current = 0;
  let longest = 0;
  for (const section of sections) {
    if (section.exposure !== "sun") {
      current = 0;
      continue;
    }
    current += haversineMetres(section.start, section.end);
    longest = Math.max(longest, current);
  }
  return longest;
}

/** Create stable, presentation-ready values without changing the scored schedule. */
export function buildShiftTimeline(
  score: LabelledRasterScore,
): ShiftTimelineJourney[] {
  const highest = score.journeys.reduce<number | null>((bestIndex, journey) => {
    if (!journey.score.isDaylight) return bestIndex;
    if (bestIndex === null) return journey.index;
    const best = score.journeys.find((candidate) => candidate.index === bestIndex);
    return !best || journey.score.estimatedDirectSunSeconds > best.score.estimatedDirectSunSeconds
      ? journey.index
      : bestIndex;
  }, null);

  return score.journeys.map((journey) => ({
    index: journey.index,
    departureEpochMs: journey.departureEpochMs,
    arrivalEpochMs: journey.arrivalEpochMs,
    durationSeconds: journey.score.durationSeconds,
    directSunSeconds: journey.score.estimatedDirectSunSeconds,
    directSunRangeSeconds: [...journey.score.directSunRangeSeconds],
    shadePercent: journey.score.estimatedShadePercent,
    coveragePercent: journey.score.coveragePercent,
    isDaylight: journey.score.isDaylight,
    limitedConfidence: journey.score.limitedConfidence,
    longestDefiniteSunRunMetres: longestDefiniteSunRunMetres(journey.score.sections),
    highestDirectSunInSchedule: highest === journey.index,
  }));
}
