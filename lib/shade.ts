/**
 * Dependency-free, deterministic shade estimates for small walking-route areas.
 *
 * Solar azimuth is measured clockwise from true north. Distances are metres and
 * angles exposed by the public API are degrees (radian values are also returned
 * with a solar position so callers do not need to convert them repeatedly).
 */

export interface GeoPoint {
  lon: number;
  lat: number;
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

export interface SolarPosition {
  /** Clockwise from true north, in the range [0, 360). */
  azimuthDeg: number;
  /** Degrees above the astronomical horizon. Negative values are below it. */
  altitudeDeg: number;
  azimuthRad: number;
  altitudeRad: number;
  isDaylight: boolean;
}

export interface BuildingFootprint {
  id: string;
  /** The exterior ring. It may be open or explicitly closed. */
  coordinates: GeoPoint[];
  /** Explicit height takes precedence over an OSM-style level count. */
  heightM?: number;
  levels?: number;
}

export interface RouteCandidate {
  id: string;
  name: string;
  coordinates: GeoPoint[];
}

export interface ShadeOptions {
  walkingSpeedMps?: number;
  sampleSpacingM?: number;
  receiverHeightM?: number;
  levelHeightM?: number;
  fallbackBuildingHeightM?: number;
  fallbackHeightUncertaintyM?: number;
  /** Optional guard for unusually large input areas. Defaults to no limit. */
  maxShadowDistanceM?: number;
}

export interface RouteSample {
  start: GeoPoint;
  end: GeoPoint;
  midpoint: GeoPoint;
  startDistanceM: number;
  endDistanceM: number;
  midpointDistanceM: number;
  distanceM: number;
}

export type BuildingHeightSource = "height" | "levels" | "fallback";

export interface BuildingHeightEstimate {
  minM: number;
  modeM: number;
  maxM: number;
  source: BuildingHeightSource;
  uncertain: boolean;
}

export interface PointShadeEstimate {
  isDaylight: boolean;
  shadeProbability: number;
  directSunProbability: number;
  directSunRange: [bestCase: number, worstCase: number];
  occludingBuildingIds: string[];
  nearestOccluderDistanceM: number | null;
  covered: boolean;
}

export type RouteExposure = "night" | "shade" | "mixed" | "sun";

export interface RouteShadeSegment {
  start: GeoPoint;
  end: GeoPoint;
  midpoint: GeoPoint;
  startDistanceM: number;
  endDistanceM: number;
  distanceM: number;
  durationSeconds: number;
  startTime: Date;
  midpointTime: Date;
  endTime: Date;
  solarPosition: SolarPosition;
  isDaylight: boolean;
  shadeProbability: number;
  directSunProbability: number;
  estimatedSunSeconds: number;
  directSunRangeSeconds: [bestCaseSeconds: number, worstCaseSeconds: number];
  exposure: RouteExposure;
  occludingBuildingIds: string[];
}

export interface RouteShadeScore {
  id: string;
  name: string;
  distanceM: number;
  durationSeconds: number;
  estimatedSunSeconds: number;
  /** Null when the whole journey is outside daylight. */
  estimatedShadePercent: number | null;
  directSunRangeSeconds: [bestCaseSeconds: number, worstCaseSeconds: number];
  isDaylight: boolean;
  /** 100 when local building data was supplied, otherwise 0. */
  coveragePercent: number;
  segments: RouteShadeSegment[];
}

export type RouteProfile = "vulnerable" | "worker";
export type RouteLabel = "fastest" | "least-sun" | "recommended";

export interface LabelledRouteScore extends RouteShadeScore {
  labels: RouteLabel[];
}

const EARTH_RADIUS_M = 6_371_008.8;
const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const DEFAULT_OPTIONS = {
  walkingSpeedMps: 1.2,
  sampleSpacingM: 8,
  receiverHeightM: 1.5,
  levelHeightM: 3,
  fallbackBuildingHeightM: 12,
  fallbackHeightUncertaintyM: 6,
  maxShadowDistanceM: Number.POSITIVE_INFINITY,
} as const;

interface ResolvedOptions {
  walkingSpeedMps: number;
  sampleSpacingM: number;
  receiverHeightM: number;
  levelHeightM: number;
  fallbackBuildingHeightM: number;
  fallbackHeightUncertaintyM: number;
  maxShadowDistanceM: number;
}

interface PreparedBuilding {
  id: string;
  polygon: ProjectedPoint[];
  height: BuildingHeightEstimate;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normaliseDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function validatePoint(point: GeoPoint, label = "Coordinate"): void {
  assertFinite(point.lon, `${label} longitude`);
  assertFinite(point.lat, `${label} latitude`);
  if (point.lat < -90 || point.lat > 90) {
    throw new RangeError(`${label} latitude must be between -90 and 90 degrees.`);
  }
}

function positiveOption(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive finite number.`);
  }
  return resolved;
}

function nonNegativeOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${label} must be a non-negative finite number.`);
  }
  return resolved;
}

function resolveOptions(options: ShadeOptions = {}): ResolvedOptions {
  const maxShadowDistanceM = options.maxShadowDistanceM ?? DEFAULT_OPTIONS.maxShadowDistanceM;
  if (maxShadowDistanceM <= 0 || Number.isNaN(maxShadowDistanceM)) {
    throw new RangeError("maxShadowDistanceM must be positive.");
  }

  return {
    walkingSpeedMps: positiveOption(
      options.walkingSpeedMps,
      DEFAULT_OPTIONS.walkingSpeedMps,
      "walkingSpeedMps",
    ),
    sampleSpacingM: positiveOption(
      options.sampleSpacingM,
      DEFAULT_OPTIONS.sampleSpacingM,
      "sampleSpacingM",
    ),
    receiverHeightM: nonNegativeOption(
      options.receiverHeightM,
      DEFAULT_OPTIONS.receiverHeightM,
      "receiverHeightM",
    ),
    levelHeightM: positiveOption(
      options.levelHeightM,
      DEFAULT_OPTIONS.levelHeightM,
      "levelHeightM",
    ),
    fallbackBuildingHeightM: nonNegativeOption(
      options.fallbackBuildingHeightM,
      DEFAULT_OPTIONS.fallbackBuildingHeightM,
      "fallbackBuildingHeightM",
    ),
    fallbackHeightUncertaintyM: nonNegativeOption(
      options.fallbackHeightUncertaintyM,
      DEFAULT_OPTIONS.fallbackHeightUncertaintyM,
      "fallbackHeightUncertaintyM",
    ),
    maxShadowDistanceM,
  };
}

/** Local equirectangular projection. Suitable for neighbourhood-scale routes. */
export function projectGeoPoint(point: GeoPoint, origin: GeoPoint): ProjectedPoint {
  validatePoint(point);
  validatePoint(origin, "Projection origin");
  const originLatitudeRad = origin.lat * DEGREES_TO_RADIANS;
  let longitudeDeltaRad = (point.lon - origin.lon) * DEGREES_TO_RADIANS;
  if (longitudeDeltaRad > Math.PI) longitudeDeltaRad -= 2 * Math.PI;
  if (longitudeDeltaRad < -Math.PI) longitudeDeltaRad += 2 * Math.PI;
  return {
    x: EARTH_RADIUS_M * longitudeDeltaRad * Math.cos(originLatitudeRad),
    y: EARTH_RADIUS_M * (point.lat - origin.lat) * DEGREES_TO_RADIANS,
  };
}

export function unprojectGeoPoint(point: ProjectedPoint, origin: GeoPoint): GeoPoint {
  assertFinite(point.x, "Projected x");
  assertFinite(point.y, "Projected y");
  validatePoint(origin, "Projection origin");
  const cosine = Math.cos(origin.lat * DEGREES_TO_RADIANS);
  if (Math.abs(cosine) < 1e-12) {
    throw new RangeError("A local longitude cannot be recovered at a geographic pole.");
  }
  return {
    lon: origin.lon + (point.x / (EARTH_RADIUS_M * cosine)) * RADIANS_TO_DEGREES,
    lat: origin.lat + (point.y / EARTH_RADIUS_M) * RADIANS_TO_DEGREES,
  };
}

export function haversineDistanceM(a: GeoPoint, b: GeoPoint): number {
  validatePoint(a);
  validatePoint(b);
  const latitude1 = a.lat * DEGREES_TO_RADIANS;
  const latitude2 = b.lat * DEGREES_TO_RADIANS;
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = (b.lon - a.lon) * DEGREES_TO_RADIANS;
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const haversine =
    sinLatitude * sinLatitude +
    Math.cos(latitude1) * Math.cos(latitude2) * sinLongitude * sinLongitude;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(clamp(haversine, 0, 1)));
}

function interpolateGeoPoint(a: GeoPoint, b: GeoPoint, fraction: number): GeoPoint {
  return {
    lon: a.lon + (b.lon - a.lon) * fraction,
    lat: a.lat + (b.lat - a.lat) * fraction,
  };
}

/** Split a route into pieces no longer than `spacingM`, retaining route distance. */
export function densifyRoute(coordinates: GeoPoint[], spacingM = 8): RouteSample[] {
  if (!Number.isFinite(spacingM) || spacingM <= 0) {
    throw new RangeError("spacingM must be a positive finite number.");
  }
  coordinates.forEach((point, index) => validatePoint(point, `Route coordinate ${index}`));
  if (coordinates.length < 2) return [];

  const samples: RouteSample[] = [];
  let travelledM = 0;

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index];
    const end = coordinates[index + 1];
    const segmentDistanceM = haversineDistanceM(start, end);
    if (segmentDistanceM <= 1e-9) continue;
    const pieces = Math.max(1, Math.ceil(segmentDistanceM / spacingM));
    const pieceDistanceM = segmentDistanceM / pieces;

    for (let piece = 0; piece < pieces; piece += 1) {
      const fromFraction = piece / pieces;
      const toFraction = (piece + 1) / pieces;
      const midpointFraction = (fromFraction + toFraction) / 2;
      const startDistanceM = travelledM + piece * pieceDistanceM;
      const endDistanceM = startDistanceM + pieceDistanceM;
      samples.push({
        start: interpolateGeoPoint(start, end, fromFraction),
        end: interpolateGeoPoint(start, end, toFraction),
        midpoint: interpolateGeoPoint(start, end, midpointFraction),
        startDistanceM,
        endDistanceM,
        midpointDistanceM: (startDistanceM + endDistanceM) / 2,
        distanceM: pieceDistanceM,
      });
    }
    travelledM += segmentDistanceM;
  }

  return samples;
}

/**
 * NOAA's compact solar-position approximation. It uses the instant represented
 * by `date`, so the result does not depend on the runtime's local time zone.
 */
export function getSolarPosition(date: Date, point: GeoPoint): SolarPosition {
  validatePoint(point);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError("date must be valid.");

  const julianDay = timestamp / 86_400_000 + 2_440_587.5;
  const centuries = (julianDay - 2_451_545) / 36_525;
  const meanLongitudeDeg = normaliseDegrees(
    280.46646 + centuries * (36_000.76983 + centuries * 0.0003032),
  );
  const meanAnomalyDeg =
    357.52911 + centuries * (35_999.05029 - 0.0001537 * centuries);
  const eccentricity =
    0.016708634 - centuries * (0.000042037 + 0.0000001267 * centuries);
  const meanAnomalyRad = meanAnomalyDeg * DEGREES_TO_RADIANS;
  const equationOfCentreDeg =
    Math.sin(meanAnomalyRad) *
      (1.914602 - centuries * (0.004817 + 0.000014 * centuries)) +
    Math.sin(2 * meanAnomalyRad) * (0.019993 - 0.000101 * centuries) +
    Math.sin(3 * meanAnomalyRad) * 0.000289;
  const trueLongitudeDeg = meanLongitudeDeg + equationOfCentreDeg;
  const omegaDeg = 125.04 - 1934.136 * centuries;
  const apparentLongitudeDeg =
    trueLongitudeDeg -
    0.00569 -
    0.00478 * Math.sin(omegaDeg * DEGREES_TO_RADIANS);
  const meanObliquityDeg =
    23 +
    (26 +
      (21.448 -
        centuries * (46.815 + centuries * (0.00059 - centuries * 0.001813))) /
        60) /
      60;
  const correctedObliquityDeg =
    meanObliquityDeg + 0.00256 * Math.cos(omegaDeg * DEGREES_TO_RADIANS);
  const obliquityRad = correctedObliquityDeg * DEGREES_TO_RADIANS;
  const apparentLongitudeRad = apparentLongitudeDeg * DEGREES_TO_RADIANS;
  const declinationRad = Math.asin(
    Math.sin(obliquityRad) * Math.sin(apparentLongitudeRad),
  );

  const y = Math.tan(obliquityRad / 2) ** 2;
  const meanLongitudeRad = meanLongitudeDeg * DEGREES_TO_RADIANS;
  const equationOfTimeMinutes =
    4 *
    RADIANS_TO_DEGREES *
    (y * Math.sin(2 * meanLongitudeRad) -
      2 * eccentricity * Math.sin(meanAnomalyRad) +
      4 * eccentricity * y * Math.sin(meanAnomalyRad) * Math.cos(2 * meanLongitudeRad) -
      0.5 * y * y * Math.sin(4 * meanLongitudeRad) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomalyRad));

  const utcMinutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60_000;
  const trueSolarMinutes =
    ((utcMinutes + equationOfTimeMinutes + 4 * point.lon) % 1440 + 1440) % 1440;
  let hourAngleDeg = trueSolarMinutes / 4 - 180;
  if (hourAngleDeg < -180) hourAngleDeg += 360;

  const latitudeRad = point.lat * DEGREES_TO_RADIANS;
  const hourAngleRad = hourAngleDeg * DEGREES_TO_RADIANS;
  const sineAltitude =
    Math.sin(latitudeRad) * Math.sin(declinationRad) +
    Math.cos(latitudeRad) * Math.cos(declinationRad) * Math.cos(hourAngleRad);
  const altitudeRad = Math.asin(clamp(sineAltitude, -1, 1));
  const azimuthRad =
    normaliseDegrees(
      Math.atan2(
        Math.sin(hourAngleRad),
        Math.cos(hourAngleRad) * Math.sin(latitudeRad) -
          Math.tan(declinationRad) * Math.cos(latitudeRad),
      ) *
        RADIANS_TO_DEGREES +
        180,
    ) * DEGREES_TO_RADIANS;

  return {
    azimuthDeg: azimuthRad * RADIANS_TO_DEGREES,
    altitudeDeg: altitudeRad * RADIANS_TO_DEGREES,
    azimuthRad,
    altitudeRad,
    isDaylight: altitudeRad > 0,
  };
}

/** Probability that a triangularly distributed height is at least `requiredM`. */
export function triangularExceedanceProbability(
  requiredM: number,
  minM: number,
  modeM: number,
  maxM: number,
): number {
  [requiredM, minM, modeM, maxM].forEach((value, index) =>
    assertFinite(value, ["requiredM", "minM", "modeM", "maxM"][index]),
  );
  if (minM > modeM || modeM > maxM) {
    throw new RangeError("Triangular bounds must satisfy minM <= modeM <= maxM.");
  }
  if (minM === maxM) return requiredM <= minM ? 1 : 0;
  if (requiredM <= minM) return 1;
  if (requiredM >= maxM) return 0;

  if (requiredM <= modeM && modeM > minM) {
    const cdf =
      ((requiredM - minM) * (requiredM - minM)) /
      ((maxM - minM) * (modeM - minM));
    return clamp(1 - cdf, 0, 1);
  }

  const survival =
    ((maxM - requiredM) * (maxM - requiredM)) /
    ((maxM - minM) * (maxM - modeM));
  return clamp(survival, 0, 1);
}

export function resolveBuildingHeight(
  building: BuildingFootprint,
  options: ShadeOptions = {},
): BuildingHeightEstimate {
  const resolved = resolveOptions(options);
  if (typeof building.heightM === "number" && Number.isFinite(building.heightM) && building.heightM >= 0) {
    return {
      minM: building.heightM,
      modeM: building.heightM,
      maxM: building.heightM,
      source: "height",
      uncertain: false,
    };
  }
  if (typeof building.levels === "number" && Number.isFinite(building.levels) && building.levels > 0) {
    const heightM = building.levels * resolved.levelHeightM;
    return {
      minM: heightM,
      modeM: heightM,
      maxM: heightM,
      source: "levels",
      uncertain: false,
    };
  }

  return {
    minM: Math.max(0, resolved.fallbackBuildingHeightM - resolved.fallbackHeightUncertaintyM),
    modeM: resolved.fallbackBuildingHeightM,
    maxM: resolved.fallbackBuildingHeightM + resolved.fallbackHeightUncertaintyM,
    source: "fallback",
    uncertain: resolved.fallbackHeightUncertaintyM > 0,
  };
}

export function requiredOccluderHeightM(
  horizontalDistanceM: number,
  solarAltitudeDeg: number,
  receiverHeightM = 1.5,
): number {
  if (!Number.isFinite(horizontalDistanceM) || horizontalDistanceM < 0) {
    throw new RangeError("horizontalDistanceM must be non-negative and finite.");
  }
  assertFinite(solarAltitudeDeg, "solarAltitudeDeg");
  if (!Number.isFinite(receiverHeightM) || receiverHeightM < 0) {
    throw new RangeError("receiverHeightM must be non-negative and finite.");
  }
  return (
    receiverHeightM +
    horizontalDistanceM * Math.tan(solarAltitudeDeg * DEGREES_TO_RADIANS)
  );
}

function cross(a: ProjectedPoint, b: ProjectedPoint): number {
  return a.x * b.y - a.y * b.x;
}

function subtract(a: ProjectedPoint, b: ProjectedPoint): ProjectedPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function pointOnSegment(
  point: ProjectedPoint,
  start: ProjectedPoint,
  end: ProjectedPoint,
): boolean {
  const segment = subtract(end, start);
  const relative = subtract(point, start);
  if (Math.abs(cross(segment, relative)) > 1e-8) return false;
  const dot = relative.x * segment.x + relative.y * segment.y;
  const squaredLength = segment.x * segment.x + segment.y * segment.y;
  return dot >= -1e-8 && dot <= squaredLength + 1e-8;
}

function pointInPolygon(point: ProjectedPoint, polygon: ProjectedPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[previous];
    const b = polygon[index];
    if (pointOnSegment(point, a, b)) return true;
    const crossesLatitude = (a.y > point.y) !== (b.y > point.y);
    if (
      crossesLatitude &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Distance to the first polygon intersection along a unit direction vector. */
export function rayPolygonIntersectionDistanceM(
  origin: ProjectedPoint,
  direction: ProjectedPoint,
  polygon: ProjectedPoint[],
): number | null {
  if (polygon.length < 3) return null;
  const magnitude = Math.hypot(direction.x, direction.y);
  if (!Number.isFinite(magnitude) || magnitude <= 1e-12) {
    throw new RangeError("Ray direction must be non-zero and finite.");
  }
  const ray = { x: direction.x / magnitude, y: direction.y / magnitude };
  if (pointInPolygon(origin, polygon)) return 0;

  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const edge = subtract(end, start);
    if (Math.hypot(edge.x, edge.y) <= 1e-12) continue;
    const denominator = cross(ray, edge);
    if (Math.abs(denominator) <= 1e-12) continue;
    const offset = subtract(start, origin);
    const rayDistance = cross(offset, edge) / denominator;
    const edgeFraction = cross(offset, ray) / denominator;
    if (
      rayDistance >= -1e-8 &&
      edgeFraction >= -1e-8 &&
      edgeFraction <= 1 + 1e-8
    ) {
      nearest = Math.min(nearest, Math.max(0, rayDistance));
    }
  }
  return Number.isFinite(nearest) ? nearest : null;
}

function prepareBuildings(
  buildings: BuildingFootprint[],
  origin: GeoPoint,
  options: ShadeOptions,
): PreparedBuilding[] {
  return buildings.flatMap((building) => {
    if (building.coordinates.length < 3) return [];
    const polygon = building.coordinates.map((coordinate, index) => {
      validatePoint(coordinate, `Building ${building.id} coordinate ${index}`);
      return projectGeoPoint(coordinate, origin);
    });
    return [{ id: building.id, polygon, height: resolveBuildingHeight(building, options) }];
  });
}

function estimateProjectedPointShade(
  point: ProjectedPoint,
  preparedBuildings: PreparedBuilding[],
  solar: SolarPosition,
  options: ResolvedOptions,
  hasBuildingData: boolean,
): PointShadeEstimate {
  if (!solar.isDaylight) {
    return {
      isDaylight: false,
      shadeProbability: 1,
      directSunProbability: 0,
      directSunRange: [0, 0],
      occludingBuildingIds: [],
      nearestOccluderDistanceM: null,
      covered: hasBuildingData,
    };
  }

  const direction = {
    x: Math.sin(solar.azimuthRad),
    y: Math.cos(solar.azimuthRad),
  };
  let directSunProbability = 1;
  let possibleShade = false;
  let guaranteedShade = false;
  let nearestOccluderDistanceM = Number.POSITIVE_INFINITY;
  const occludingBuildingIds: string[] = [];

  for (const building of preparedBuildings) {
    const distanceM = rayPolygonIntersectionDistanceM(point, direction, building.polygon);
    if (distanceM === null || distanceM > options.maxShadowDistanceM) continue;
    const requiredHeightM = requiredOccluderHeightM(
      distanceM,
      solar.altitudeDeg,
      options.receiverHeightM,
    );
    const shadeProbability = building.height.uncertain
      ? triangularExceedanceProbability(
          requiredHeightM,
          building.height.minM,
          building.height.modeM,
          building.height.maxM,
        )
      : building.height.modeM >= requiredHeightM
        ? 1
        : 0;
    if (shadeProbability <= 0) continue;

    possibleShade = true;
    guaranteedShade ||= shadeProbability >= 1 - 1e-12;
    directSunProbability *= 1 - shadeProbability;
    nearestOccluderDistanceM = Math.min(nearestOccluderDistanceM, distanceM);
    occludingBuildingIds.push(building.id);
  }

  directSunProbability = clamp(directSunProbability, 0, 1);
  return {
    isDaylight: true,
    shadeProbability: 1 - directSunProbability,
    directSunProbability,
    directSunRange: [possibleShade ? 0 : 1, guaranteedShade ? 0 : 1],
    occludingBuildingIds,
    nearestOccluderDistanceM: Number.isFinite(nearestOccluderDistanceM)
      ? nearestOccluderDistanceM
      : null,
    covered: hasBuildingData,
  };
}

export function estimatePointShade(
  point: GeoPoint,
  buildings: BuildingFootprint[],
  solar: SolarPosition,
  options: ShadeOptions = {},
): PointShadeEstimate {
  validatePoint(point);
  const resolved = resolveOptions(options);
  const prepared = prepareBuildings(buildings, point, options);
  return estimateProjectedPointShade(
    { x: 0, y: 0 },
    prepared,
    solar,
    resolved,
    buildings.length > 0,
  );
}

function exposureFor(shade: PointShadeEstimate): RouteExposure {
  if (!shade.isDaylight) return "night";
  if (shade.shadeProbability >= 0.95) return "shade";
  if (shade.shadeProbability <= 0.05) return "sun";
  return "mixed";
}

export function scoreRouteShade(
  route: RouteCandidate,
  buildings: BuildingFootprint[],
  departure: Date,
  options: ShadeOptions = {},
): RouteShadeScore {
  if (!route.id) throw new RangeError("route.id must not be empty.");
  if (!Number.isFinite(departure.getTime())) throw new RangeError("departure must be valid.");
  const resolved = resolveOptions(options);
  const samples = densifyRoute(route.coordinates, resolved.sampleSpacingM);
  const distanceM = samples.reduce((sum, sample) => sum + sample.distanceM, 0);
  const durationSeconds = distanceM / resolved.walkingSpeedMps;
  const projectionOrigin = route.coordinates[0] ?? { lon: 0, lat: 0 };
  if (route.coordinates.length === 0) {
    throw new RangeError("route.coordinates must contain at least one point.");
  }
  const preparedBuildings = prepareBuildings(buildings, projectionOrigin, options);
  const hasBuildingData = buildings.length > 0;
  const segments: RouteShadeSegment[] = [];
  let daylightSeconds = 0;
  let expectedShadeSeconds = 0;
  let estimatedSunSeconds = 0;
  let bestCaseSunSeconds = 0;
  let worstCaseSunSeconds = 0;

  for (const sample of samples) {
    const segmentDurationSeconds = sample.distanceM / resolved.walkingSpeedMps;
    const startElapsedSeconds = sample.startDistanceM / resolved.walkingSpeedMps;
    const midpointElapsedSeconds = sample.midpointDistanceM / resolved.walkingSpeedMps;
    const endElapsedSeconds = sample.endDistanceM / resolved.walkingSpeedMps;
    const startTime = new Date(departure.getTime() + startElapsedSeconds * 1000);
    const midpointTime = new Date(departure.getTime() + midpointElapsedSeconds * 1000);
    const endTime = new Date(departure.getTime() + endElapsedSeconds * 1000);
    const solarPosition = getSolarPosition(midpointTime, sample.midpoint);
    const shade = estimateProjectedPointShade(
      projectGeoPoint(sample.midpoint, projectionOrigin),
      preparedBuildings,
      solarPosition,
      resolved,
      hasBuildingData,
    );
    const segmentSunSeconds = segmentDurationSeconds * shade.directSunProbability;
    const segmentSunRange: [number, number] = [
      segmentDurationSeconds * shade.directSunRange[0],
      segmentDurationSeconds * shade.directSunRange[1],
    ];

    if (shade.isDaylight) {
      daylightSeconds += segmentDurationSeconds;
      expectedShadeSeconds += segmentDurationSeconds * shade.shadeProbability;
      estimatedSunSeconds += segmentSunSeconds;
      bestCaseSunSeconds += segmentSunRange[0];
      worstCaseSunSeconds += segmentSunRange[1];
    }

    segments.push({
      start: sample.start,
      end: sample.end,
      midpoint: sample.midpoint,
      startDistanceM: sample.startDistanceM,
      endDistanceM: sample.endDistanceM,
      distanceM: sample.distanceM,
      durationSeconds: segmentDurationSeconds,
      startTime,
      midpointTime,
      endTime,
      solarPosition,
      isDaylight: shade.isDaylight,
      shadeProbability: shade.shadeProbability,
      directSunProbability: shade.directSunProbability,
      estimatedSunSeconds: segmentSunSeconds,
      directSunRangeSeconds: segmentSunRange,
      exposure: exposureFor(shade),
      occludingBuildingIds: shade.occludingBuildingIds,
    });
  }

  return {
    id: route.id,
    name: route.name,
    distanceM,
    durationSeconds,
    estimatedSunSeconds,
    estimatedShadePercent:
      daylightSeconds > 0 ? clamp((expectedShadeSeconds / daylightSeconds) * 100, 0, 100) : null,
    directSunRangeSeconds: [bestCaseSunSeconds, worstCaseSunSeconds],
    isDaylight: daylightSeconds > 0,
    coveragePercent: samples.length > 0 && hasBuildingData ? 100 : 0,
    segments,
  };
}

export function selectRouteLabels(
  scores: RouteShadeScore[],
  profile: RouteProfile,
): LabelledRouteScore[] {
  if (profile !== "vulnerable" && profile !== "worker") {
    throw new RangeError("profile must be 'vulnerable' or 'worker'.");
  }
  if (scores.length === 0) return [];

  const faster = (candidate: RouteShadeScore, current: RouteShadeScore) =>
    candidate.durationSeconds < current.durationSeconds ? candidate : current;
  const lessSun = (candidate: RouteShadeScore, current: RouteShadeScore) => {
    if (candidate.estimatedSunSeconds < current.estimatedSunSeconds) return candidate;
    if (
      candidate.estimatedSunSeconds === current.estimatedSunSeconds &&
      candidate.durationSeconds < current.durationSeconds
    ) {
      return candidate;
    }
    return current;
  };

  const fastest = scores.reduce(faster);
  const leastSun = scores.reduce(lessSun);
  const allowedExtraSeconds = Math.min(300, fastest.durationSeconds * 0.2);
  const eligible = scores.filter(
    (score) => score.durationSeconds <= fastest.durationSeconds + allowedExtraSeconds + 1e-9,
  );
  const recommended = eligible.reduce((current, candidate) => {
    const sunDifference = candidate.estimatedSunSeconds - current.estimatedSunSeconds;
    if (profile === "worker" && Math.abs(sunDifference) < 30) {
      return faster(candidate, current);
    }
    if (sunDifference < 0) return candidate;
    if (sunDifference === 0) return faster(candidate, current);
    return current;
  });

  return scores.map((score) => {
    const labels: RouteLabel[] = [];
    if (score.id === recommended.id) labels.push("recommended");
    if (score.id === leastSun.id) labels.push("least-sun");
    if (score.id === fastest.id) labels.push("fastest");
    return { ...score, labels };
  });
}

export function selectRouteLabelMap(
  scores: RouteShadeScore[],
  profile: RouteProfile,
): Record<string, RouteLabel[]> {
  return Object.fromEntries(
    selectRouteLabels(scores, profile).map((score) => [score.id, score.labels]),
  );
}
