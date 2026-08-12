import proj4 from "proj4";
import * as SunCalc from "suncalc";
import { haversineMetres, type Coordinate, type WalkingRoute } from "./routes.ts";

proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs",
);

export interface HeightGridMetadata {
  id: string;
  width: number;
  height: number;
  bboxBng: [minEasting: number, minNorthing: number, maxEasting: number, maxNorthing: number];
  resolutionMetres: number;
  heightStepMetres: number;
  coveragePercent: number;
  anyCoveragePercent?: number;
  validityFile?: string;
  validityEncoding?: "fraction-255";
  source: string;
  sourceDate: string;
  processed: string;
}

export interface HeightGrid {
  metadata: HeightGridMetadata;
  heights: Uint8Array;
  /** 255 means every source pixel represented by this cell was valid. */
  validity?: Uint8Array;
}

export type ExposureState = "sun" | "shade" | "uncertain" | "unknown" | "night";
export type RayCoverage = "complete" | "incomplete" | "not-required";
export type ConfidenceReason =
  | "low-sun-angle"
  | "incomplete-height-coverage"
  | "near-clearance-threshold"
  | "unmodelled-passage";

export interface ExposureSection {
  start: Coordinate;
  end: Coordinate;
  /** Index of the source route segment represented by this sampled section. */
  routeSegmentIndex: number;
  exposure: ExposureState;
  /** Modelled share of this section in shade. Null means the data cannot support an estimate. */
  shadeFraction: number | null;
  daylight: boolean;
  lowSun: boolean;
  rayCoverage: RayCoverage;
  confidenceReasons: ConfidenceReason[];
}

export interface RasterRouteScore {
  routeId: string;
  distanceMetres: number;
  durationSeconds: number;
  estimatedDirectSunSeconds: number;
  directSunRangeSeconds: [bestCaseSeconds: number, worstCaseSeconds: number];
  estimatedShadePercent: number | null;
  daylightSeconds: number;
  modelledDaylightSeconds: number;
  unknownDaylightSeconds: number;
  isDaylight: boolean;
  lowSunConfidence: boolean;
  limitedConfidence: boolean;
  confidenceReasons: ConfidenceReason[];
  coveragePercent: number;
  sections: ExposureSection[];
}

export interface ScheduleScore extends RasterRouteScore {
  journeyCount: number;
}

export type RouteLabel = "recommended" | "least-sun" | "fastest";

export interface LabelledRasterScore extends ScheduleScore {
  labels: RouteLabel[];
  recommendationReason: string | null;
}

interface RouteSample {
  start: Coordinate;
  end: Coordinate;
  midpoint: Coordinate;
  lengthMetres: number;
  midpointFraction: number;
  originalSegmentIndex: number;
}

interface PointExposureAssessment {
  shadeFraction: number | null;
  guaranteedShade: boolean;
  possibleShade: boolean;
  daylight: boolean;
  lowSun: boolean;
  covered: boolean;
  exposure: ExposureState;
  rayCoverage: RayCoverage;
  confidenceReasons: ConfidenceReason[];
}

const gridCache = new Map<string, Promise<HeightGrid>>();
const LOW_SUN_ALTITUDE_RADIANS = (3 * Math.PI) / 180;
const CLEARANCE_MARGIN_METRES = 2;
const OBSERVER_HEIGHT_METRES = 1.5;
const MAXIMUM_RAY_DISTANCE_METRES = 250;

export function loadHeightGrid(areaId: string): Promise<HeightGrid> {
  const existing = gridCache.get(areaId);
  if (existing) return existing;

  const pending = fetch(`/data/${areaId}-heights.json`)
    .then((response) => {
      if (!response.ok) throw new Error("Height metadata is unavailable.");
      return response.json() as Promise<HeightGridMetadata>;
    })
    .then(async (metadata) => {
      const [heightResponse, validityResponse] = await Promise.all([
        fetch(`/data/${areaId}-heights.bin`),
        metadata.validityFile ? fetch(`/data/${metadata.validityFile}`) : Promise.resolve(null),
      ]);
      if (!heightResponse.ok) throw new Error("Height coverage is unavailable.");
      if (validityResponse && !validityResponse.ok) {
        throw new Error("Height validity coverage is unavailable.");
      }
      const heights = new Uint8Array(await heightResponse.arrayBuffer());
      const validity = validityResponse
        ? new Uint8Array(await validityResponse.arrayBuffer())
        : undefined;
      const expectedLength = metadata.width * metadata.height;
      if (heights.length !== expectedLength || (validity && validity.length !== expectedLength)) {
        throw new Error("Height coverage is incomplete.");
      }
      return { metadata, heights, validity };
    });

  gridCache.set(areaId, pending);
  return pending;
}

export function longitudeLatitudeToBng(coordinate: Coordinate): [number, number] {
  return proj4("EPSG:4326", "EPSG:27700", coordinate) as [number, number];
}

function heightAt(grid: HeightGrid, easting: number, northing: number) {
  const { bboxBng, resolutionMetres, width, height, heightStepMetres } = grid.metadata;
  const x = Math.floor((easting - bboxBng[0]) / resolutionMetres);
  const y = Math.floor((bboxBng[3] - northing) / resolutionMetres);
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const index = y * width + x;
  if (grid.validity && grid.validity[index] !== 255) return null;
  return grid.heights[index] * heightStepMetres;
}

function densifyRoute(coordinates: Coordinate[], intervalMetres = 8): RouteSample[] {
  const segmentLengths = coordinates.slice(1).map((coordinate, index) =>
    haversineMetres(coordinates[index], coordinate),
  );
  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
  const samples: RouteSample[] = [];
  let travelled = 0;

  for (let index = 0; index < segmentLengths.length; index += 1) {
    const start = coordinates[index];
    const end = coordinates[index + 1];
    const segmentLength = segmentLengths[index];
    const pieces = Math.max(1, Math.ceil(segmentLength / intervalMetres));
    for (let piece = 0; piece < pieces; piece += 1) {
      const fromFraction = piece / pieces;
      const toFraction = (piece + 1) / pieces;
      const midpointFractionOnSegment = (fromFraction + toFraction) / 2;
      const from: Coordinate = [
        start[0] + (end[0] - start[0]) * fromFraction,
        start[1] + (end[1] - start[1]) * fromFraction,
      ];
      const to: Coordinate = [
        start[0] + (end[0] - start[0]) * toFraction,
        start[1] + (end[1] - start[1]) * toFraction,
      ];
      const midpoint: Coordinate = [
        start[0] + (end[0] - start[0]) * midpointFractionOnSegment,
        start[1] + (end[1] - start[1]) * midpointFractionOnSegment,
      ];
      const lengthMetres = segmentLength / pieces;
      samples.push({
        start: from,
        end: to,
        midpoint,
        lengthMetres,
        midpointFraction: totalLength
          ? (travelled + segmentLength * midpointFractionOnSegment) / totalLength
          : 0,
        originalSegmentIndex: index,
      });
    }
    travelled += segmentLength;
  }
  return samples;
}

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

function uniqueReasons(reasons: ConfidenceReason[]) {
  return [...new Set(reasons)];
}

/** Assess a single point against the raster. Exported to support deterministic engine tests. */
export function assessPointExposure(
  coordinate: Coordinate,
  date: Date,
  grid: HeightGrid,
): PointExposureAssessment {
  const position = SunCalc.getPosition(date, coordinate[1], coordinate[0]);
  // SunCalc v2 returns degrees, with azimuth clockwise from north.
  const altitude = (position.altitude * Math.PI) / 180;
  if (altitude <= 0) {
    return {
      shadeFraction: null,
      guaranteedShade: false,
      possibleShade: false,
      daylight: false,
      lowSun: false,
      covered: true,
      exposure: "night",
      rayCoverage: "not-required",
      confidenceReasons: [],
    };
  }

  const lowSun = altitude < LOW_SUN_ALTITUDE_RADIANS;
  const lowSunReasons: ConfidenceReason[] = lowSun ? ["low-sun-angle"] : [];
  const [easting, northing] = longitudeLatitudeToBng(coordinate);
  if (heightAt(grid, easting, northing) === null) {
    return {
      shadeFraction: null,
      guaranteedShade: false,
      possibleShade: true,
      daylight: true,
      lowSun,
      covered: false,
      exposure: "unknown",
      rayCoverage: "incomplete",
      confidenceReasons: [...lowSunReasons, "incomplete-height-coverage"],
    };
  }

  // This vector points from the observer towards the sun, where an occluder
  // would cast shade.
  const azimuth = (position.azimuth * Math.PI) / 180;
  const eastDirection = Math.sin(azimuth);
  const northDirection = Math.cos(azimuth);
  const tangent = Math.tan(altitude);
  const maximumEncodedHeight = 255 * grid.metadata.heightStepMetres;
  const maximumRayDistance = Math.min(
    MAXIMUM_RAY_DISTANCE_METRES,
    Math.max(
      grid.metadata.resolutionMetres,
      (maximumEncodedHeight - OBSERVER_HEIGHT_METRES) / tangent,
    ),
  );
  let bestClearance = Number.NEGATIVE_INFINITY;
  let rayComplete = true;

  for (
    let distance = grid.metadata.resolutionMetres;
    distance <= maximumRayDistance;
    distance += grid.metadata.resolutionMetres
  ) {
    const obstacleHeight = heightAt(
      grid,
      easting + eastDirection * distance,
      northing + northDirection * distance,
    );
    if (obstacleHeight === null) {
      rayComplete = false;
      break;
    }
    const requiredHeight = OBSERVER_HEIGHT_METRES + distance * tangent;
    bestClearance = Math.max(bestClearance, obstacleHeight - requiredHeight);
    // Once an observed object clears the ray by the full uncertainty margin,
    // farther raster cells are no longer relevant to the shade classification.
    if (bestClearance >= CLEARANCE_MARGIN_METRES) break;
  }

  const guaranteedShade = bestClearance >= CLEARANCE_MARGIN_METRES;
  if (!rayComplete && !guaranteedShade) {
    return {
      shadeFraction: null,
      guaranteedShade: false,
      possibleShade: true,
      daylight: true,
      lowSun,
      covered: false,
      exposure: "unknown",
      rayCoverage: "incomplete",
      confidenceReasons: [...lowSunReasons, "incomplete-height-coverage"],
    };
  }

  const possibleShade = bestClearance >= -CLEARANCE_MARGIN_METRES;
  const shadeFraction = clamp(
    (bestClearance + CLEARANCE_MARGIN_METRES) / (2 * CLEARANCE_MARGIN_METRES),
    0,
    1,
  );
  const exposure: ExposureState = guaranteedShade
    ? "shade"
    : possibleShade
      ? "uncertain"
      : "sun";
  const confidenceReasons: ConfidenceReason[] = [
    ...lowSunReasons,
    ...(exposure === "uncertain" ? (["near-clearance-threshold"] as const) : []),
  ];
  return {
    shadeFraction,
    guaranteedShade,
    possibleShade,
    daylight: true,
    lowSun,
    covered: true,
    exposure,
    rayCoverage: "complete",
    confidenceReasons,
  };
}

const UNMODELLED_PASSAGE_PATTERN =
  /\b(stairs?|stairway|escalator|underground|subway|tunnel|indoors?|inside)\b|level\s*-\s*\d/i;

function sampleUsesUnmodelledPassage(route: WalkingRoute, sample: RouteSample) {
  return route.directions.some((direction) => {
    if (!UNMODELLED_PASSAGE_PATTERN.test(direction.instruction)) return false;
    const begin = Math.max(0, Math.floor(direction.beginIndex));
    const end = Math.max(begin + 1, Math.floor(direction.endIndex));
    return sample.originalSegmentIndex >= begin && sample.originalSegmentIndex < end;
  });
}

export function scoreRouteAgainstGrid(
  route: WalkingRoute,
  grid: HeightGrid,
  departure: Date,
): RasterRouteScore {
  const samples = densifyRoute(route.coordinates);
  const sampleLength = samples.reduce((sum, sample) => sum + sample.lengthMetres, 0);
  let daylightSeconds = 0;
  let expectedShadeSeconds = 0;
  let guaranteedShadeSeconds = 0;
  let possibleShadeSeconds = 0;
  let modelledDaylightSeconds = 0;
  let unknownDaylightSeconds = 0;
  let lowSunConfidence = false;
  const confidenceReasons: ConfidenceReason[] = [];
  const sections: ExposureSection[] = [];

  for (const sample of samples) {
    const duration = sampleLength
      ? (sample.lengthMetres / sampleLength) * route.durationSeconds
      : 0;
    const sampleDate = new Date(
      departure.getTime() + sample.midpointFraction * route.durationSeconds * 1000,
    );
    let shade = assessPointExposure(sample.midpoint, sampleDate, grid);
    if (shade.daylight && sampleUsesUnmodelledPassage(route, sample)) {
      shade = {
        ...shade,
        shadeFraction: null,
        guaranteedShade: false,
        possibleShade: true,
        covered: false,
        exposure: "unknown",
        rayCoverage: "not-required",
        confidenceReasons: uniqueReasons([...shade.confidenceReasons, "unmodelled-passage"]),
      };
    }

    if (shade.daylight) {
      daylightSeconds += duration;
      if (shade.covered && shade.shadeFraction !== null) {
        modelledDaylightSeconds += duration;
        expectedShadeSeconds += duration * shade.shadeFraction;
      } else {
        // Unknown sections are conservatively counted as direct sun in the
        // displayed estimate so missing data cannot make a route rank better.
        unknownDaylightSeconds += duration;
      }
      if (shade.guaranteedShade) guaranteedShadeSeconds += duration;
      if (shade.possibleShade) possibleShadeSeconds += duration;
      lowSunConfidence ||= shade.lowSun;
      confidenceReasons.push(...shade.confidenceReasons);
    }
    sections.push({
      start: sample.start,
      end: sample.end,
      routeSegmentIndex: sample.originalSegmentIndex,
      exposure: shade.exposure,
      shadeFraction: shade.shadeFraction,
      daylight: shade.daylight,
      lowSun: shade.lowSun,
      rayCoverage: shade.rayCoverage,
      confidenceReasons: shade.confidenceReasons,
    });
  }

  const estimatedDirectSunSeconds = Math.max(0, daylightSeconds - expectedShadeSeconds);
  const bestCase = Math.max(0, daylightSeconds - possibleShadeSeconds);
  const worstCase = Math.max(0, daylightSeconds - guaranteedShadeSeconds);
  const reasons = uniqueReasons(confidenceReasons);
  return {
    routeId: route.id,
    distanceMetres: route.distanceMetres,
    durationSeconds: route.durationSeconds,
    estimatedDirectSunSeconds,
    directSunRangeSeconds: [bestCase, worstCase],
    estimatedShadePercent: daylightSeconds
      ? clamp((expectedShadeSeconds / daylightSeconds) * 100, 0, 100)
      : null,
    daylightSeconds,
    modelledDaylightSeconds,
    unknownDaylightSeconds,
    isDaylight: daylightSeconds > 0,
    lowSunConfidence,
    limitedConfidence: reasons.length > 0,
    confidenceReasons: reasons,
    coveragePercent: daylightSeconds
      ? clamp((modelledDaylightSeconds / daylightSeconds) * 100, 0, 100)
      : 100,
    sections,
  };
}

/** Combines journey scores using daylight duration, rather than averaging percentages. */
export function aggregateScheduleScores(
  route: WalkingRoute,
  scores: RasterRouteScore[],
): ScheduleScore {
  if (!scores.length) throw new Error("At least one journey score is required.");
  const expectedSun = scores.reduce((sum, score) => sum + score.estimatedDirectSunSeconds, 0);
  const bestCase = scores.reduce((sum, score) => sum + score.directSunRangeSeconds[0], 0);
  const worstCase = scores.reduce((sum, score) => sum + score.directSunRangeSeconds[1], 0);
  const daylightSeconds = scores.reduce((sum, score) => sum + score.daylightSeconds, 0);
  const modelledDaylightSeconds = scores.reduce(
    (sum, score) => sum + score.modelledDaylightSeconds,
    0,
  );
  const unknownDaylightSeconds = scores.reduce(
    (sum, score) => sum + score.unknownDaylightSeconds,
    0,
  );
  const expectedShadeSeconds = Math.max(0, daylightSeconds - expectedSun);
  const reasons = uniqueReasons(scores.flatMap((score) => score.confidenceReasons));
  return {
    ...scores[0],
    durationSeconds: route.durationSeconds * scores.length,
    distanceMetres: route.distanceMetres * scores.length,
    estimatedDirectSunSeconds: expectedSun,
    directSunRangeSeconds: [bestCase, worstCase],
    estimatedShadePercent: daylightSeconds
      ? clamp((expectedShadeSeconds / daylightSeconds) * 100, 0, 100)
      : null,
    daylightSeconds,
    modelledDaylightSeconds,
    unknownDaylightSeconds,
    isDaylight: daylightSeconds > 0,
    lowSunConfidence: scores.some((score) => score.lowSunConfidence),
    limitedConfidence: reasons.length > 0,
    confidenceReasons: reasons,
    coveragePercent: daylightSeconds
      ? clamp((modelledDaylightSeconds / daylightSeconds) * 100, 0, 100)
      : 100,
    sections: scores[0].sections,
    journeyCount: scores.length,
  };
}

export function scoreRouteSchedule(
  route: WalkingRoute,
  grid: HeightGrid,
  departure: Date,
  journeyCount: number,
  repeatEveryMinutes: number,
): ScheduleScore {
  const count = Math.max(1, Math.floor(journeyCount));
  const repeatMinutes = Number.isFinite(repeatEveryMinutes) ? repeatEveryMinutes : 0;
  const scores = Array.from({ length: count }, (_, index) =>
    scoreRouteAgainstGrid(
      route,
      grid,
      new Date(departure.getTime() + index * repeatMinutes * 60_000),
    ),
  );
  return aggregateScheduleScores(route, scores);
}

function perJourneyDuration(score: ScheduleScore) {
  return score.durationSeconds / Math.max(1, score.journeyCount);
}

function readableMinutes(seconds: number) {
  if (seconds < 60) return "less than 1 min";
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

export function labelRouteScores(
  scores: ScheduleScore[],
  profile: "vulnerable" | "worker",
): LabelledRasterScore[] {
  if (!scores.length) return [];
  const fastest = scores.reduce((best, score) =>
    perJourneyDuration(score) < perJourneyDuration(best) ? score : best,
  );
  const leastSun = scores.reduce((best, score) => {
    const sunDifference = score.estimatedDirectSunSeconds - best.estimatedDirectSunSeconds;
    if (sunDifference < 0) return score;
    if (sunDifference === 0 && perJourneyDuration(score) < perJourneyDuration(best)) return score;
    return best;
  });
  const journeyCount = Math.max(1, fastest.journeyCount);
  const minimumVisibleDifference = 30 * journeyCount;
  const sunValues = scores.map((score) => score.estimatedDirectSunSeconds);
  const hasMeaningfulSunDifference =
    scores.some((score) => score.isDaylight) &&
    Math.max(...sunValues) - Math.min(...sunValues) >= minimumVisibleDifference;

  const fastestDuration = perJourneyDuration(fastest);
  const profileDetourFraction = profile === "vulnerable" ? 0.2 : 0.15;
  const profileDetourCap = profile === "vulnerable" ? 300 : 180;
  const allowedExtraPerJourney = Math.min(profileDetourCap, fastestDuration * profileDetourFraction);
  const eligible = scores.filter(
    (score) => perJourneyDuration(score) <= fastestDuration + allowedExtraPerJourney,
  );
  const tieTolerance = profile === "worker" ? minimumVisibleDifference : 0;
  const bestEligible = eligible.reduce((best, score) => {
    const sunDifference = score.estimatedDirectSunSeconds - best.estimatedDirectSunSeconds;
    if (sunDifference < -tieTolerance) return score;
    if (Math.abs(sunDifference) <= tieTolerance && perJourneyDuration(score) < perJourneyDuration(best)) {
      return score;
    }
    return best;
  });
  const improvement = fastest.estimatedDirectSunSeconds - bestEligible.estimatedDirectSunSeconds;
  const meaningfulImprovement = Math.max(
    minimumVisibleDifference,
    fastest.estimatedDirectSunSeconds * 0.05,
  );
  const recommended = improvement >= meaningfulImprovement ? bestEligible : fastest;
  const extraPerJourney = Math.max(0, perJourneyDuration(recommended) - fastestDuration);
  let recommendationReason: string;
  if (!scores.some((score) => score.isDaylight)) {
    recommendationReason = "No daylight exposure is expected, so the fastest route is suggested.";
  } else if (recommended.routeId === fastest.routeId && recommended.routeId === leastSun.routeId) {
    recommendationReason =
      "This is both the fastest eligible route and the route with the lowest displayed direct-sun estimate.";
  } else if (recommended.routeId === fastest.routeId) {
    recommendationReason =
      `The fastest route is suggested because eligible alternatives save ${readableMinutes(Math.max(0, improvement))} of displayed direct sun.`;
  } else {
    recommendationReason =
      `This route saves about ${readableMinutes(improvement)} of displayed direct sun for ${readableMinutes(extraPerJourney)} extra per journey, within the ${readableMinutes(allowedExtraPerJourney)} detour limit.`;
  }

  return scores.map((score) => {
    const labels: RouteLabel[] = [];
    if (score.routeId === recommended.routeId) labels.push("recommended");
    if (hasMeaningfulSunDifference && score.routeId === leastSun.routeId) labels.push("least-sun");
    if (score.routeId === fastest.routeId) labels.push("fastest");
    return {
      ...score,
      labels,
      recommendationReason: score.routeId === recommended.routeId ? recommendationReason : null,
    };
  });
}
