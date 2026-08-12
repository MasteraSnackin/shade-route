import type { ExposureSection, ExposureState } from "./raster-shade.ts";
import { haversineMetres, type Coordinate } from "./routes.ts";

export const SHADE_PLAYER_START_MINUTES = 0;
export const SHADE_PLAYER_END_MINUTES = 23 * 60 + 45;

const EXPOSURES = ["sun", "shade", "uncertain", "unknown", "night"] as const;
const exposureSet = new Set<string>(EXPOSURES);

export interface ShadeProfileSegment {
  exposure: ExposureState;
  distanceMetres: number;
  startDistanceMetres: number;
  endDistanceMetres: number;
  percent: number;
  start: Coordinate;
  end: Coordinate;
}

export interface ShadeProfileTotal {
  distanceMetres: number;
  percent: number;
}

export interface ShadeProfile {
  segments: ShadeProfileSegment[];
  totals: Record<ExposureState, ShadeProfileTotal>;
}

function exposureOrUnknown(value: unknown): ExposureState {
  return typeof value === "string" && exposureSet.has(value)
    ? (value as ExposureState)
    : "unknown";
}

function emptyTotals(): Record<ExposureState, ShadeProfileTotal> {
  return {
    sun: { distanceMetres: 0, percent: 0 },
    shade: { distanceMetres: 0, percent: 0 },
    uncertain: { distanceMetres: 0, percent: 0 },
    unknown: { distanceMetres: 0, percent: 0 },
    night: { distanceMetres: 0, percent: 0 },
  };
}

/**
 * Builds a compact, distance-based profile from the scored raster sections.
 *
 * Adjacent sections with the same normalised exposure are merged. When a
 * route total is supplied it is used as the percentage denominator; measured
 * segment distances and ranges always remain based on the section geometry.
 */
export function buildShadeProfile(
  sections: ExposureSection[],
  totalDistanceMetres?: number,
): ShadeProfile {
  const measuredSections = sections.map((section) => ({
    section,
    exposure: exposureOrUnknown(
      (section as ExposureSection & { exposure?: unknown }).exposure,
    ),
    distanceMetres: haversineMetres(section.start, section.end),
  }));
  const measuredDistanceMetres = measuredSections.reduce(
    (sum, item) => sum + item.distanceMetres,
    0,
  );
  const suppliedDistanceMetres =
    typeof totalDistanceMetres === "number" &&
    Number.isFinite(totalDistanceMetres) &&
    totalDistanceMetres > 0
      ? totalDistanceMetres
      : measuredDistanceMetres;
  const denominator = Math.max(measuredDistanceMetres, suppliedDistanceMetres);

  // A routing service can report a little more distance than appears in its
  // decoded geometry. Keep that missing share explicit rather than implying
  // that the modelled sections cover the entire route.
  const unmeasuredDistanceMetres = denominator - measuredDistanceMetres;
  if (unmeasuredDistanceMetres > 0.01 && measuredSections.length) {
    const finalSection = measuredSections.at(-1)!.section;
    measuredSections.push({
      section: {
        ...finalSection,
        start: finalSection.end,
        end: finalSection.end,
        exposure: "unknown",
        shadeFraction: null,
        rayCoverage: "incomplete",
        confidenceReasons: ["incomplete-height-coverage"],
      },
      exposure: "unknown",
      distanceMetres: unmeasuredDistanceMetres,
    });
  }

  const merged: Array<
    Omit<ShadeProfileSegment, "startDistanceMetres" | "endDistanceMetres" | "percent">
  > = [];

  for (const item of measuredSections) {
    const previous = merged.at(-1);
    if (previous?.exposure === item.exposure) {
      previous.distanceMetres += item.distanceMetres;
      previous.end = item.section.end;
    } else {
      merged.push({
        exposure: item.exposure,
        distanceMetres: item.distanceMetres,
        start: item.section.start,
        end: item.section.end,
      });
    }
  }

  let distanceSoFar = 0;
  const segments = merged.map((segment): ShadeProfileSegment => {
    const startDistanceMetres = distanceSoFar;
    distanceSoFar += segment.distanceMetres;
    return {
      ...segment,
      startDistanceMetres,
      endDistanceMetres: distanceSoFar,
      percent: denominator > 0 ? (segment.distanceMetres / denominator) * 100 : 0,
    };
  });

  const totals = emptyTotals();
  for (const segment of segments) {
    totals[segment.exposure].distanceMetres += segment.distanceMetres;
  }
  for (const exposure of EXPOSURES) {
    totals[exposure].percent =
      denominator > 0 ? (totals[exposure].distanceMetres / denominator) * 100 : 0;
  }

  return { segments, totals };
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function clampPlayerMinutes(minutes: number): number {
  return Math.max(
    SHADE_PLAYER_START_MINUTES,
    Math.min(SHADE_PLAYER_END_MINUTES, minutes),
  );
}

/** Extracts wall-clock minutes from a valid datetime-local value. */
export function minutesFromDateTimeLocal(value: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(
    value,
  );
  if (!match || !isValidIsoDate(match[1])) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Combines an ISO civil date and player minutes into a London datetime-local value. */
export function dateTimeLocalAtMinutes(date: string, minutes: number): string {
  if (!isValidIsoDate(date)) throw new RangeError("date must be a valid YYYY-MM-DD value.");
  if (!Number.isFinite(minutes)) throw new RangeError("minutes must be finite.");
  const clamped = clampPlayerMinutes(Math.round(minutes));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
