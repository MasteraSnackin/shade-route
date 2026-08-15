import proj4 from "proj4";
import * as SunCalc from "suncalc";
import { haversineMetres, type Coordinate, type WalkingRoute } from "./routes.ts";
import {
  walkingDurationSeconds,
  type WalkingPace,
} from "./walking-pace.ts";

export {
  isWalkingPace,
  resolveWalkingPace,
  WALKING_PACE_PRESETS,
  walkingDurationSeconds,
  type WalkingPace,
  type WalkingPacePreset,
} from "./walking-pace.ts";

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
  terrainFile?: string;
  minimumSurfaceFile?: string;
  maximumSurfaceFile?: string;
  elevationEncoding?: "float32-le";
  elevationAggregation?: string;
  minimumTerrainElevationMetres?: number;
  maximumTerrainElevationMetres?: number;
  minimumSurfaceElevationMetres?: number;
  maximumSurfaceElevationMetres?: number;
  clippedLegacyHeightCells?: number;
  source: string;
  sourceDate: string;
  processed: string;
}

export interface HeightGrid {
  metadata: HeightGridMetadata;
  heights: Uint8Array;
  /** 255 means every source pixel represented by this cell was valid. */
  validity?: Uint8Array;
  /** Absolute ground elevation above datum, retained so slopes affect ray clearance. */
  terrainElevations?: Float32Array;
  /** Minimum and maximum absolute DSM values among the native source pixels in each cell. */
  minimumSurfaceElevations?: Float32Array;
  maximumSurfaceElevations?: Float32Array;
}

export type ExposureState = "sun" | "shade" | "uncertain" | "unknown" | "night";
export type RayCoverage = "complete" | "incomplete" | "not-required";
export type ConfidenceReason =
  | "low-sun-angle"
  | "incomplete-height-coverage"
  | "near-clearance-threshold"
  | "subcell-surface-variation"
  | "ray-search-limit"
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

export interface ScheduleJourney {
  /** Zero-based index in the repeated-journey schedule. */
  index: number;
  departureEpochMs: number;
  arrivalEpochMs: number;
  score: RasterRouteScore;
}

export interface ScheduleScore extends RasterRouteScore {
  journeyCount: number;
  walkingPace: WalkingPace;
  /** Individual journeys retained for shift and repeated-trip presentation. */
  journeys: ScheduleJourney[];
}

export type RouteLabel = "recommended" | "least-sun" | "lowest-estimate" | "fastest";

export interface LabelledRasterScore extends ScheduleScore {
  labels: RouteLabel[];
  recommendationReason: string | null;
}

export interface RouteSample {
  start: Coordinate;
  end: Coordinate;
  midpoint: Coordinate;
  midpointBng: [easting: number, northing: number];
  lengthMetres: number;
  midpointFraction: number;
  originalSegmentIndex: number;
}

export interface PreparedRouteGeometry {
  identity: string;
  samples: readonly RouteSample[];
  sampleLengthMetres: number;
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
const preparedRouteCache = new Map<string, PreparedRouteGeometry>();
const MAXIMUM_PREPARED_ROUTE_CACHE_ENTRIES = 32;
const LOW_SUN_ALTITUDE_RADIANS = (3 * Math.PI) / 180;
const CLEARANCE_MARGIN_METRES = 2;
const OBSERVER_HEIGHT_METRES = 1.5;
const MAXIMUM_RAY_DISTANCE_METRES = 250;

function decodeFloat32LittleEndian(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  if (view.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Absolute elevation coverage is incomplete.");
  }
  const values = new Float32Array(view.byteLength / Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return values;
}

export function loadHeightGrid(areaId: string): Promise<HeightGrid> {
  const existing = gridCache.get(areaId);
  if (existing) return existing;

  const pending = fetch(`/data/${areaId}-heights.json`)
    .then((response) => {
      if (!response.ok) throw new Error("Height metadata is unavailable.");
      return response.json() as Promise<HeightGridMetadata>;
    })
    .then(async (metadata) => {
      const [
        heightResponse,
        validityResponse,
        terrainResponse,
        minimumSurfaceResponse,
        maximumSurfaceResponse,
      ] = await Promise.all([
        fetch(`/data/${areaId}-heights.bin`),
        metadata.validityFile ? fetch(`/data/${metadata.validityFile}`) : Promise.resolve(null),
        metadata.terrainFile ? fetch(`/data/${metadata.terrainFile}`) : Promise.resolve(null),
        metadata.minimumSurfaceFile
          ? fetch(`/data/${metadata.minimumSurfaceFile}`)
          : Promise.resolve(null),
        metadata.maximumSurfaceFile
          ? fetch(`/data/${metadata.maximumSurfaceFile}`)
          : Promise.resolve(null),
      ]);
      if (!heightResponse.ok) throw new Error("Height coverage is unavailable.");
      if (validityResponse && !validityResponse.ok) {
        throw new Error("Height validity coverage is unavailable.");
      }
      if (
        (terrainResponse && !terrainResponse.ok) ||
        (minimumSurfaceResponse && !minimumSurfaceResponse.ok) ||
        (maximumSurfaceResponse && !maximumSurfaceResponse.ok)
      ) {
        throw new Error("Absolute elevation coverage is unavailable.");
      }
      const hasCompleteAbsoluteFiles = Boolean(
        terrainResponse && minimumSurfaceResponse && maximumSurfaceResponse,
      );
      if (
        Boolean(terrainResponse) !== hasCompleteAbsoluteFiles ||
        Boolean(minimumSurfaceResponse) !== hasCompleteAbsoluteFiles ||
        Boolean(maximumSurfaceResponse) !== hasCompleteAbsoluteFiles
      ) {
        throw new Error("Absolute elevation metadata is incomplete.");
      }
      const heights = new Uint8Array(await heightResponse.arrayBuffer());
      const validity = validityResponse
        ? new Uint8Array(await validityResponse.arrayBuffer())
        : undefined;
      const terrainElevations = terrainResponse
        ? decodeFloat32LittleEndian(await terrainResponse.arrayBuffer())
        : undefined;
      const minimumSurfaceElevations = minimumSurfaceResponse
        ? decodeFloat32LittleEndian(await minimumSurfaceResponse.arrayBuffer())
        : undefined;
      const maximumSurfaceElevations = maximumSurfaceResponse
        ? decodeFloat32LittleEndian(await maximumSurfaceResponse.arrayBuffer())
        : undefined;
      const expectedLength = metadata.width * metadata.height;
      if (
        heights.length !== expectedLength ||
        (validity && validity.length !== expectedLength) ||
        (terrainElevations && terrainElevations.length !== expectedLength) ||
        (minimumSurfaceElevations && minimumSurfaceElevations.length !== expectedLength) ||
        (maximumSurfaceElevations && maximumSurfaceElevations.length !== expectedLength)
      ) {
        throw new Error("Height coverage is incomplete.");
      }
      return {
        metadata,
        heights,
        validity,
        terrainElevations,
        minimumSurfaceElevations,
        maximumSurfaceElevations,
      };
    });

  gridCache.set(areaId, pending);
  void pending.catch(() => {
    // A temporary network/cache failure must not poison every later retry.
    // Identity guards against an old rejected request evicting a newer one.
    if (gridCache.get(areaId) === pending) gridCache.delete(areaId);
  });
  return pending;
}

export function longitudeLatitudeToBng(coordinate: Coordinate): [number, number] {
  return proj4("EPSG:4326", "EPSG:27700", coordinate) as [number, number];
}

function gridIndexAt(grid: HeightGrid, easting: number, northing: number) {
  const { bboxBng, resolutionMetres, width, height } = grid.metadata;
  const x = Math.floor((easting - bboxBng[0]) / resolutionMetres);
  const y = Math.floor((bboxBng[3] - northing) / resolutionMetres);
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const index = y * width + x;
  if (grid.validity && grid.validity[index] !== 255) return null;
  return index;
}

function heightAt(grid: HeightGrid, easting: number, northing: number) {
  const index = gridIndexAt(grid, easting, northing);
  if (index === null) return null;
  const { heightStepMetres } = grid.metadata;
  return grid.heights[index] * heightStepMetres;
}

interface AbsoluteElevationEnvelope {
  terrain: number;
  minimumSurface: number;
  maximumSurface: number;
}

function absoluteElevationAt(
  grid: HeightGrid,
  easting: number,
  northing: number,
): AbsoluteElevationEnvelope | null {
  if (
    !grid.terrainElevations ||
    !grid.minimumSurfaceElevations ||
    !grid.maximumSurfaceElevations
  ) {
    return null;
  }
  const index = gridIndexAt(grid, easting, northing);
  if (index === null) return null;
  const terrain = grid.terrainElevations[index];
  const minimumSurface = grid.minimumSurfaceElevations[index];
  const maximumSurface = grid.maximumSurfaceElevations[index];
  return Number.isFinite(terrain) &&
    Number.isFinite(minimumSurface) &&
    Number.isFinite(maximumSurface) &&
    minimumSurface <= maximumSurface
    ? { terrain, minimumSurface, maximumSurface }
    : null;
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
        midpointBng: longitudeLatitudeToBng(midpoint),
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

function routeGeometryIdentity(coordinates: Coordinate[], intervalMetres: number) {
  return `${intervalMetres}|${coordinates
    .map(([longitude, latitude]) => `${longitude},${latitude}`)
    .join(";")}`;
}

/**
 * Densify and project a route once. Time scans reuse this immutable geometry,
 * while the small LRU cache bounds retained live-route data.
 */
export function prepareRouteGeometry(
  route: WalkingRoute,
  intervalMetres = 8,
): PreparedRouteGeometry {
  const identity = routeGeometryIdentity(route.coordinates, intervalMetres);
  const cached = preparedRouteCache.get(identity);
  if (cached) {
    preparedRouteCache.delete(identity);
    preparedRouteCache.set(identity, cached);
    return cached;
  }

  const samples = densifyRoute(route.coordinates, intervalMetres);
  const prepared: PreparedRouteGeometry = {
    identity,
    samples,
    sampleLengthMetres: samples.reduce((sum, sample) => sum + sample.lengthMetres, 0),
  };
  preparedRouteCache.set(identity, prepared);
  while (preparedRouteCache.size > MAXIMUM_PREPARED_ROUTE_CACHE_ENTRIES) {
    const oldestIdentity = preparedRouteCache.keys().next().value;
    if (oldestIdentity === undefined) break;
    preparedRouteCache.delete(oldestIdentity);
  }
  return prepared;
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
  projectedCoordinate: [easting: number, northing: number] = longitudeLatitudeToBng(coordinate),
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
  const [easting, northing] = projectedCoordinate;
  const usesAbsoluteElevations = Boolean(
    grid.terrainElevations &&
    grid.minimumSurfaceElevations &&
    grid.maximumSurfaceElevations,
  );
  const originElevation = usesAbsoluteElevations
    ? absoluteElevationAt(grid, easting, northing)
    : null;
  if (
    (usesAbsoluteElevations && originElevation === null) ||
    (!usesAbsoluteElevations && heightAt(grid, easting, northing) === null)
  ) {
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
  const maximumPotentialHeight = usesAbsoluteElevations && originElevation
    ? Math.max(
        0,
        (grid.metadata.maximumSurfaceElevationMetres ?? originElevation.maximumSurface) -
          originElevation.terrain,
      )
    : 255 * grid.metadata.heightStepMetres;
  const naturalMaximumRayDistance = Math.max(
    grid.metadata.resolutionMetres,
    (maximumPotentialHeight - OBSERVER_HEIGHT_METRES) / tangent,
  );
  const maximumRayDistance = Math.min(
    MAXIMUM_RAY_DISTANCE_METRES,
    naturalMaximumRayDistance,
  );
  const rayWasSearchLimited = usesAbsoluteElevations &&
    naturalMaximumRayDistance > MAXIMUM_RAY_DISTANCE_METRES;
  let bestCertainClearance = Number.NEGATIVE_INFINITY;
  let bestExpectedClearance = Number.NEGATIVE_INFINITY;
  let bestPossibleClearance = Number.NEGATIVE_INFINITY;
  let surfaceEnvelopeAffectedResult = false;
  let rayComplete = true;

  for (
    let distance = grid.metadata.resolutionMetres;
    distance <= maximumRayDistance;
    distance += grid.metadata.resolutionMetres
  ) {
    const sampleEasting = easting + eastDirection * distance;
    const sampleNorthing = northing + northDirection * distance;
    if (usesAbsoluteElevations && originElevation) {
      const envelope = absoluteElevationAt(grid, sampleEasting, sampleNorthing);
      if (!envelope) {
        rayComplete = false;
        break;
      }
      const requiredElevation =
        originElevation.terrain + OBSERVER_HEIGHT_METRES + distance * tangent;
      const certainClearance = envelope.minimumSurface - requiredElevation;
      const possibleClearance = envelope.maximumSurface - requiredElevation;
      const expectedClearance =
        (envelope.minimumSurface + envelope.maximumSurface) / 2 - requiredElevation;
      bestCertainClearance = Math.max(bestCertainClearance, certainClearance);
      bestExpectedClearance = Math.max(bestExpectedClearance, expectedClearance);
      bestPossibleClearance = Math.max(bestPossibleClearance, possibleClearance);
      surfaceEnvelopeAffectedResult ||=
        possibleClearance >= -CLEARANCE_MARGIN_METRES &&
        certainClearance < CLEARANCE_MARGIN_METRES &&
        envelope.maximumSurface - envelope.minimumSurface > CLEARANCE_MARGIN_METRES;
    } else {
      const obstacleHeight = heightAt(grid, sampleEasting, sampleNorthing);
      if (obstacleHeight === null) {
        rayComplete = false;
        break;
      }
      const requiredHeight = OBSERVER_HEIGHT_METRES + distance * tangent;
      const clearance = obstacleHeight - requiredHeight;
      bestCertainClearance = Math.max(bestCertainClearance, clearance);
      bestExpectedClearance = Math.max(bestExpectedClearance, clearance);
      bestPossibleClearance = Math.max(bestPossibleClearance, clearance);
    }
    // Once an observed object clears the ray by the full uncertainty margin,
    // farther raster cells are no longer relevant to the shade classification.
    if (bestCertainClearance >= CLEARANCE_MARGIN_METRES) break;
  }

  const guaranteedShade = bestCertainClearance >= CLEARANCE_MARGIN_METRES;
  if (rayWasSearchLimited && !guaranteedShade) rayComplete = false;
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
      confidenceReasons: uniqueReasons([
        ...lowSunReasons,
        rayWasSearchLimited ? "ray-search-limit" : "incomplete-height-coverage",
      ]),
    };
  }

  const possibleShade = bestPossibleClearance >= -CLEARANCE_MARGIN_METRES;
  const shadeFraction = clamp(
    (bestExpectedClearance + CLEARANCE_MARGIN_METRES) / (2 * CLEARANCE_MARGIN_METRES),
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
    ...(surfaceEnvelopeAffectedResult ? (["subcell-surface-variation"] as const) : []),
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
  preparedGeometry: PreparedRouteGeometry = prepareRouteGeometry(route),
  walkingPace: WalkingPace = "standard",
): RasterRouteScore {
  const samples = preparedGeometry.samples;
  const sampleLength = preparedGeometry.sampleLengthMetres;
  const durationSeconds = walkingDurationSeconds(route, walkingPace);
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
      ? (sample.lengthMetres / sampleLength) * durationSeconds
      : 0;
    const sampleDate = new Date(
      departure.getTime() + sample.midpointFraction * durationSeconds * 1000,
    );
    let shade = assessPointExposure(sample.midpoint, sampleDate, grid, sample.midpointBng);
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
    durationSeconds,
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
  journeys: ScheduleJourney[],
  walkingPace: WalkingPace = "standard",
): ScheduleScore {
  if (!journeys.length) throw new Error("At least one journey score is required.");
  const scores = journeys.map((journey) => journey.score);
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
    durationSeconds: scores.reduce((sum, score) => sum + score.durationSeconds, 0),
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
    walkingPace,
    journeys,
  };
}

export function scoreRouteSchedule(
  route: WalkingRoute,
  grid: HeightGrid,
  departure: Date,
  journeyCount: number,
  repeatEveryMinutes: number,
  walkingPace: WalkingPace = "standard",
): ScheduleScore {
  const count = Math.max(1, Math.floor(journeyCount));
  const repeatMinutes = Number.isFinite(repeatEveryMinutes) ? repeatEveryMinutes : 0;
  const preparedGeometry = prepareRouteGeometry(route);
  const journeys = Array.from({ length: count }, (_, index) => {
    const journeyDeparture = new Date(departure.getTime() + index * repeatMinutes * 60_000);
    const score = scoreRouteAgainstGrid(
      route,
      grid,
      journeyDeparture,
      preparedGeometry,
      walkingPace,
    );
    return {
      index,
      departureEpochMs: journeyDeparture.getTime(),
      arrivalEpochMs: journeyDeparture.getTime() + score.durationSeconds * 1000,
      score,
    };
  });
  return aggregateScheduleScores(route, journeys, walkingPace);
}

function perJourneyDuration(score: ScheduleScore) {
  return score.durationSeconds / Math.max(1, score.journeyCount);
}

type DirectSunSensitivity = Pick<ScheduleScore, "directSunRangeSeconds">;

/**
 * A lower point estimate is not enough to claim a lower-sun option. The
 * candidate's worst-case sensitivity bound must also sit below the reference
 * route's best-case bound; touching or overlapping ranges are inconclusive.
 */
export function sensitivitySupportsLowerSun(
  reference: DirectSunSensitivity,
  candidate: DirectSunSensitivity,
) {
  return candidate.directSunRangeSeconds[1] < reference.directSunRangeSeconds[0];
}

/**
 * Establish a lowest-sun ordering only when the candidate's complete
 * sensitivity range is strictly below every other displayed route. A point
 * estimate alone, or touching bounds, can support only a descriptive label.
 */
export function sensitivityEstablishesLowestSun(
  candidate: ScheduleScore,
  scores: readonly ScheduleScore[],
) {
  return scores.every(
    (other) =>
      other.routeId === candidate.routeId || sensitivitySupportsLowerSun(other, candidate),
  );
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
  const leastSunOrderingEstablished =
    hasMeaningfulSunDifference && sensitivityEstablishesLowestSun(leastSun, scores);

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
  const meaningfulImprovement = Math.max(
    minimumVisibleDifference,
    fastest.estimatedDirectSunSeconds * 0.05,
  );
  const eligibleSensitivityAlternatives = eligible.filter(
    (score) =>
      score.routeId !== fastest.routeId &&
      fastest.estimatedDirectSunSeconds - score.estimatedDirectSunSeconds >=
        meaningfulImprovement &&
      sensitivitySupportsLowerSun(fastest, score),
  );
  const sensitivityLowestAlternative = eligibleSensitivityAlternatives.find((candidate) =>
    sensitivityEstablishesLowestSun(candidate, eligibleSensitivityAlternatives),
  );
  const supportedAlternativesOverlap =
    eligibleSensitivityAlternatives.length > 1 && !sensitivityLowestAlternative;
  // If several alternatives are all demonstrably below the fastest route but
  // overlap one another, prefer the shortest journey rather than breaking the
  // uncertainty tie with their point estimates.
  const bestSensitivityAlternative = sensitivityLowestAlternative ??
    eligibleSensitivityAlternatives.reduce<ScheduleScore | null>(
      (best, score) =>
        !best || perJourneyDuration(score) < perJourneyDuration(best) ? score : best,
      null,
    );
  const pointEstimateImprovement =
    fastest.estimatedDirectSunSeconds - bestEligible.estimatedDirectSunSeconds;
  const estimateSupportsAlternative =
    bestEligible.routeId !== fastest.routeId &&
    pointEstimateImprovement >= meaningfulImprovement;
  const recommended = bestSensitivityAlternative ?? fastest;
  const improvement = fastest.estimatedDirectSunSeconds - recommended.estimatedDirectSunSeconds;
  const extraPerJourney = Math.max(0, perJourneyDuration(recommended) - fastestDuration);
  let recommendationReason: string;
  if (!scores.some((score) => score.isDaylight)) {
    recommendationReason = "No daylight exposure is expected, so the fastest route is suggested.";
  } else if (recommended.routeId === fastest.routeId && recommended.routeId === leastSun.routeId) {
    recommendationReason =
      "This is both the fastest eligible route and the route with the lowest displayed direct-sun estimate.";
  } else if (estimateSupportsAlternative && !bestSensitivityAlternative) {
    recommendationReason =
      "The fastest route is suggested because the lower point estimate on an alternative is not established by the overlapping model sensitivity ranges.";
  } else if (recommended.routeId === fastest.routeId) {
    recommendationReason =
      `The fastest route is suggested because eligible alternatives save ${readableMinutes(Math.max(0, improvement))} of displayed direct sun.`;
  } else if (supportedAlternativesOverlap) {
    recommendationReason =
      `Several eligible lower-sun ranges overlap, so this is the fastest option whose whole sensitivity range is below the fastest route, adding ${readableMinutes(extraPerJourney)} per journey.`;
  } else {
    recommendationReason =
      `This route saves about ${readableMinutes(improvement)} of displayed direct sun for ${readableMinutes(extraPerJourney)} extra per journey, within the ${readableMinutes(allowedExtraPerJourney)} detour limit.`;
  }

  return scores.map((score) => {
    const labels: RouteLabel[] = [];
    if (score.routeId === recommended.routeId) labels.push("recommended");
    if (hasMeaningfulSunDifference && score.routeId === leastSun.routeId) {
      labels.push(leastSunOrderingEstablished ? "least-sun" : "lowest-estimate");
    }
    if (score.routeId === fastest.routeId) labels.push("fastest");
    return {
      ...score,
      labels,
      recommendationReason: score.routeId === recommended.routeId ? recommendationReason : null,
    };
  });
}
