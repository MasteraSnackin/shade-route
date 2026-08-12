export type Coordinate = [longitude: number, latitude: number];

export interface NamedPoint {
  name: string;
  lat: number;
  lon: number;
}

export interface RouteDirection {
  instruction: string;
  distanceMetres: number;
  durationSeconds: number;
  beginIndex: number;
  endIndex: number;
  /** Valhalla manoeuvre type, retained so the UI can add tested turn icons later. */
  maneuverType?: number;
  /** Direction of travel after the manoeuvre, clockwise from north. */
  bearingAfter?: number;
  /** A shorter instruction suitable for a compact walking view or optional speech. */
  succinctInstruction?: string;
  /** Routing-data flag only; this is not a surveyed pavement-condition assessment. */
  roughSurfaceFlag?: boolean;
  travelType?: string;
}

export interface WalkingRoute {
  id: string;
  coordinates: Coordinate[];
  distanceMetres: number;
  durationSeconds: number;
  directions: RouteDirection[];
  /** Preserved source text used only when directions cannot safely be displayed, such as a reversed pilot route. */
  accessReference?: string;
}

export interface PilotArea {
  id: "waterloo" | "kings-cross";
  name: string;
  bbox: [west: number, south: number, east: number, north: number];
  start: NamedPoint;
  destination: NamedPoint;
  routes: WalkingRoute[];
}

export interface PilotRouteData {
  generated: string;
  areas: PilotArea[];
}

interface ValhallaManeuver {
  type?: number;
  instruction?: string;
  verbal_succinct_transition_instruction?: string;
  bearing_after?: number;
  length?: number;
  time?: number;
  begin_shape_index?: number;
  end_shape_index?: number;
  rough?: boolean;
  travel_type?: string;
}

interface ValhallaTrip {
  summary: { length: number; time: number };
  legs: Array<{ shape: string; maneuvers?: ValhallaManeuver[] }>;
}

export interface RouteValidationContext {
  origin: Pick<NamedPoint, "lat" | "lon">;
  destination: Pick<NamedPoint, "lat" | "lon">;
  bbox: PilotArea["bbox"];
  endpointToleranceMetres?: number;
}

const ROUTE_COMPARISON_SAMPLES = 41;
const DUPLICATE_MEAN_SEPARATION_METRES = 10;
const DUPLICATE_P90_SEPARATION_METRES = 20;
const DUPLICATE_MAX_SEPARATION_METRES = 35;
const MAX_ROUTE_COORDINATES = 10_000;
const MAX_ROUTE_DIRECTIONS = 512;
const MAX_ROUTE_DISTANCE_METRES = 10_000;
const MAX_ROUTE_DURATION_SECONDS = 4 * 60 * 60;
const DEFAULT_ENDPOINT_TOLERANCE_METRES = 100;

export function decodePolyline(encoded: string, precision = 6): Coordinate[] {
  const factor = 10 ** precision;
  const coordinates: Coordinate[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  const decodeValue = () => {
    let shift = 0;
    let result = 0;

    while (true) {
      if (index >= encoded.length || shift > 30) {
        throw new Error("The routing service returned an invalid route shape.");
      }
      const byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) {
        throw new Error("The routing service returned an invalid route shape.");
      }
      result |= (byte & 0x1f) << shift;
      if (byte < 0x20) break;
      shift += 5;
    }

    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    if (coordinates.length >= MAX_ROUTE_COORDINATES) {
      throw new Error("The routing service returned too many route coordinates.");
    }
    latitude += decodeValue();
    longitude += decodeValue();
    const coordinate: Coordinate = [longitude / factor, latitude / factor];
    if (
      !Number.isFinite(coordinate[0]) ||
      !Number.isFinite(coordinate[1]) ||
      Math.abs(coordinate[0]) > 180 ||
      Math.abs(coordinate[1]) > 90
    ) {
      throw new Error("The routing service returned an invalid route shape.");
    }
    coordinates.push(coordinate);
  }

  return coordinates;
}

function isValhallaTrip(value: unknown): value is ValhallaTrip {
  if (!value || typeof value !== "object") return false;
  const trip = value as Partial<ValhallaTrip>;
  return Boolean(
    trip.summary &&
      typeof trip.summary.length === "number" &&
      Number.isFinite(trip.summary.length) &&
      trip.summary.length > 0 &&
      Math.round(trip.summary.length * 1000) > 0 &&
      trip.summary.length * 1000 <= MAX_ROUTE_DISTANCE_METRES &&
      typeof trip.summary.time === "number" &&
      Number.isFinite(trip.summary.time) &&
      trip.summary.time > 0 &&
      Math.round(trip.summary.time) > 0 &&
      trip.summary.time <= MAX_ROUTE_DURATION_SECONDS &&
      Array.isArray(trip.legs) &&
      trip.legs.length === 1,
  );
}

function compactDirections(
  maneuvers: ValhallaManeuver[] | undefined,
  coordinateCount: number,
): RouteDirection[] {
  if (!maneuvers) return [];
  if (maneuvers.length > MAX_ROUTE_DIRECTIONS) {
    throw new Error("The routing service returned too many walking instructions.");
  }
  return maneuvers.map((maneuver) => {
    const beginIndex = maneuver.begin_shape_index;
    const endIndex = maneuver.end_shape_index;
    if (
      !Number.isSafeInteger(beginIndex) ||
      !Number.isSafeInteger(endIndex) ||
      beginIndex! < 0 ||
      endIndex! < beginIndex! ||
      endIndex! >= coordinateCount ||
      !Number.isFinite(maneuver.length) ||
      maneuver.length! < 0 ||
      !Number.isFinite(maneuver.time) ||
      maneuver.time! < 0
    ) {
      throw new Error("The routing service returned invalid walking instructions.");
    }
    const instruction = typeof maneuver.instruction === "string"
      ? maneuver.instruction.trim()
      : "";
    if (instruction.length > 500) {
      throw new Error("The routing service returned an invalid walking instruction.");
    }
    return {
      instruction: instruction || "Continue",
      distanceMetres: Math.round(maneuver.length! * 1000),
      durationSeconds: Math.round(maneuver.time!),
      beginIndex: beginIndex!,
      endIndex: endIndex!,
      maneuverType: Number.isFinite(maneuver.type) ? maneuver.type : undefined,
      bearingAfter: Number.isFinite(maneuver.bearing_after) ? maneuver.bearing_after : undefined,
      succinctInstruction: typeof maneuver.verbal_succinct_transition_instruction === "string"
        ? maneuver.verbal_succinct_transition_instruction.slice(0, 500)
        : undefined,
      roughSurfaceFlag: maneuver.rough === true,
      travelType: typeof maneuver.travel_type === "string"
        ? maneuver.travel_type.slice(0, 40)
        : undefined,
    };
  });
}

function routeGeometryDistanceMetres(coordinates: Coordinate[]) {
  return coordinates.slice(1).reduce(
    (sum, coordinate, index) => sum + haversineMetres(coordinates[index], coordinate),
    0,
  );
}

function coordinateInsideBbox(coordinate: Coordinate, bbox: PilotArea["bbox"]) {
  const [west, south, east, north] = bbox;
  return coordinate[0] >= west &&
    coordinate[0] <= east &&
    coordinate[1] >= south &&
    coordinate[1] <= north;
}

export function validateWalkingRoute(
  route: WalkingRoute,
  context: RouteValidationContext,
) {
  if (
    route.coordinates.length < 2 ||
    !Number.isFinite(route.distanceMetres) ||
    route.distanceMetres <= 0 ||
    !Number.isFinite(route.durationSeconds) ||
    route.durationSeconds <= 0
  ) {
    return false;
  }
  const tolerance = context.endpointToleranceMetres ?? DEFAULT_ENDPOINT_TOLERANCE_METRES;
  if (
    haversineMetres(route.coordinates[0], [context.origin.lon, context.origin.lat]) > tolerance ||
    haversineMetres(route.coordinates.at(-1)!, [context.destination.lon, context.destination.lat]) > tolerance
  ) {
    return false;
  }
  if (!route.coordinates.every((coordinate) => coordinateInsideBbox(coordinate, context.bbox))) {
    return false;
  }
  const geometryDistance = routeGeometryDistanceMetres(route.coordinates);
  const allowedDifference = Math.max(100, route.distanceMetres * 0.15);
  return Math.abs(geometryDistance - route.distanceMetres) <= allowedDifference;
}

function compactTrip(
  value: unknown,
  id: string,
  validationContext?: RouteValidationContext,
): WalkingRoute {
  if (!isValhallaTrip(value)) {
    throw new Error("The routing service returned an incomplete journey.");
  }
  const trip = value;
  const leg = trip.legs[0];
  if (!leg?.shape) throw new Error("Routing response did not include a walkable shape.");
  const coordinates = decodePolyline(leg.shape);
  if (coordinates.length < 2 || coordinates.length > MAX_ROUTE_COORDINATES) {
    throw new Error("Routing response did not include a walkable shape.");
  }
  const route: WalkingRoute = {
    id,
    coordinates,
    distanceMetres: Math.round(trip.summary.length * 1000),
    durationSeconds: Math.round(trip.summary.time),
    directions: compactDirections(leg.maneuvers, coordinates.length),
  };
  if (validationContext && !validateWalkingRoute(route, validationContext)) {
    throw new Error("The routing service returned a journey outside the modelled pilot area.");
  }
  return route;
}

function sampleRoute(coordinates: Coordinate[], sampleCount = ROUTE_COMPARISON_SAMPLES) {
  if (coordinates.length < 2) return [];

  const cumulativeDistances = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    cumulativeDistances.push(
      cumulativeDistances[index - 1] + haversineMetres(coordinates[index - 1], coordinates[index]),
    );
  }

  const totalDistance = cumulativeDistances.at(-1) ?? 0;
  if (!Number.isFinite(totalDistance) || totalDistance <= 0) return [];

  const samples: Coordinate[] = [];
  let segmentIndex = 1;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const targetDistance = (totalDistance * sampleIndex) / (sampleCount - 1);
    while (
      segmentIndex < cumulativeDistances.length - 1 &&
      cumulativeDistances[segmentIndex] < targetDistance
    ) {
      segmentIndex += 1;
    }

    const segmentStartDistance = cumulativeDistances[segmentIndex - 1];
    const segmentEndDistance = cumulativeDistances[segmentIndex];
    const segmentLength = segmentEndDistance - segmentStartDistance;
    const fraction = segmentLength > 0 ? (targetDistance - segmentStartDistance) / segmentLength : 0;
    const start = coordinates[segmentIndex - 1];
    const end = coordinates[segmentIndex];
    samples.push([
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ]);
  }

  return samples;
}

/**
 * Treat alternatives as the same route when their paths remain within roughly
 * one London street width throughout. Valhalla can otherwise return the same
 * geometry with different vertex spacing or tiny pavement-level variations.
 */
export function routesAreNearDuplicates(a: WalkingRoute, b: WalkingRoute) {
  const aSamples = sampleRoute(a.coordinates);
  const bSamples = sampleRoute(b.coordinates);
  if (aSamples.length !== ROUTE_COMPARISON_SAMPLES || bSamples.length !== ROUTE_COMPARISON_SAMPLES) {
    return false;
  }

  const directEndpointDistance =
    haversineMetres(aSamples[0], bSamples[0]) +
    haversineMetres(aSamples.at(-1)!, bSamples.at(-1)!);
  const reverseEndpointDistance =
    haversineMetres(aSamples[0], bSamples.at(-1)!) +
    haversineMetres(aSamples.at(-1)!, bSamples[0]);
  const comparisonSamples =
    reverseEndpointDistance < directEndpointDistance ? [...bSamples].reverse() : bSamples;

  if (
    haversineMetres(aSamples[0], comparisonSamples[0]) > DUPLICATE_MAX_SEPARATION_METRES ||
    haversineMetres(aSamples.at(-1)!, comparisonSamples.at(-1)!) >
      DUPLICATE_MAX_SEPARATION_METRES
  ) {
    return false;
  }

  const separations = aSamples.map((point, index) =>
    haversineMetres(point, comparisonSamples[index]),
  );
  const sortedSeparations = [...separations].sort((left, right) => left - right);
  const meanSeparation = separations.reduce((sum, distance) => sum + distance, 0) / separations.length;
  const p90Separation = sortedSeparations[Math.ceil(sortedSeparations.length * 0.9) - 1];
  const maxSeparation = sortedSeparations.at(-1) ?? Number.POSITIVE_INFINITY;

  return (
    meanSeparation <= DUPLICATE_MEAN_SEPARATION_METRES &&
    p90Separation <= DUPLICATE_P90_SEPARATION_METRES &&
    maxSeparation <= DUPLICATE_MAX_SEPARATION_METRES
  );
}

export function deduplicateWalkingRoutes(routes: WalkingRoute[], limit = 3) {
  const distinct: WalkingRoute[] = [];
  for (const route of routes) {
    if (!distinct.some((candidate) => routesAreNearDuplicates(candidate, route))) {
      distinct.push(route);
      if (distinct.length >= limit) break;
    }
  }
  return distinct;
}

export function compactValhallaResponse(
  response: unknown,
  idPrefix = "custom",
  validationContext?: RouteValidationContext,
): WalkingRoute[] {
  if (!response || typeof response !== "object") {
    throw new Error("The routing service returned no usable journeys.");
  }
  const value = response as { trip?: unknown; alternates?: unknown };
  const alternatives = Array.isArray(value.alternates)
    ? value.alternates.slice(0, 7).map((item) =>
        item && typeof item === "object" ? (item as { trip?: unknown }).trip : undefined,
      )
    : [];
  const candidates = [value.trip, ...alternatives];
  const validRoutes: WalkingRoute[] = [];

  for (const candidate of candidates) {
    try {
      validRoutes.push(compactTrip(candidate, "candidate", validationContext));
    } catch {
      // A malformed alternate should not discard other usable walking routes.
    }
  }

  const routes = deduplicateWalkingRoutes(validRoutes, 3).map((route, index) => ({
    ...route,
    id: `${idPrefix}-${index + 1}`,
  }));
  if (routes.length === 0) {
    throw new Error("The routing service returned no usable journeys.");
  }
  return routes;
}

export function pointInsideArea(point: Pick<NamedPoint, "lat" | "lon">, area: PilotArea) {
  const [west, south, east, north] = area.bbox;
  return point.lon >= west && point.lon <= east && point.lat >= south && point.lat <= north;
}

export function haversineMetres(a: Coordinate, b: Coordinate) {
  const earthRadius = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitude1 = toRadians(a[1]);
  const latitude2 = toRadians(b[1]);
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = toRadians(b[0] - a[0]);
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const h =
    sinLatitude * sinLatitude +
    Math.cos(latitude1) * Math.cos(latitude2) * sinLongitude * sinLongitude;
  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}
