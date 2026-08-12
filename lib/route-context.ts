import type { Coordinate, PilotArea, WalkingRoute } from "./routes";

export const ROUTE_CONTEXT_CATEGORIES = [
  "cool-space",
  "drinking-water",
  "toilet",
  "rest",
  "tree",
] as const;

export type RouteContextCategory = typeof ROUTE_CONTEXT_CATEGORIES[number];
export type RouteContextAreaId = PilotArea["id"];
export type RouteContextCompletenessStatus =
  | "complete"
  | "partial"
  | "not-collected"
  | "unknown";

export type RouteContextSubtype =
  | "official-cool-space"
  | "drinking-fountain"
  | "toilet"
  | "bench"
  | "shelter"
  | "individual-tree";

export const OPENSTREETMAP_SOURCE_URL = "https://www.openstreetmap.org/copyright";
export const GLA_COOL_SPACES_2025_DATASET_URL =
  "https://data.london.gov.uk/dataset/cool-space-data-2025-2z19p";
export const GLA_COOL_SPACES_CURRENT_MAP_URL = "https://apps.london.gov.uk/cool-spaces/";
export const LONDON_DATASTORE_TERMS_URL =
  "https://data.london.gov.uk/about/terms-and-conditions/";
export const GLA_COOL_SPACES_2025_SOURCE = {
  label: "Greater London Authority Cool Space Data 2025",
  url: GLA_COOL_SPACES_2025_DATASET_URL,
  licence: "London Datastore terms; no dataset-specific licence stated",
  snapshotAt: "2025-12-11T12:13:45Z",
  method: "GLA-listed point records from the local Cool Space Data 2025 extract, captured 11 December 2025 and clipped to the pilot bounding box. This historical extract is not the GLA's live Summer 2026 map and does not confirm current listing, opening, access or amenities.",
} as const satisfies RouteContextSource;

export interface RouteContextSource {
  label: string;
  url: string;
  licence: string;
  snapshotAt: string;
  method: string;
}

export interface RouteContextCompleteness {
  status: RouteContextCompletenessStatus;
  note: string;
}

export interface RouteContextFeatureDetails {
  access?: "yes" | "customers" | "private" | "unknown";
  fee?: "yes" | "no" | "unknown";
  wheelchair?: "yes" | "limited" | "no" | "unknown";
  indoor?: "yes" | "no" | "unknown";
  backrest?: "yes" | "no" | "unknown";
  openingHours?: string;
  level?: string;
  checkDate?: string;
  coolSpaceRegisterYear?: 2025;
  coolSpaceTier?: 1 | 2;
  notes?: string[];
}

export interface RouteContextFeature {
  id: string;
  category: RouteContextCategory;
  subtype: RouteContextSubtype;
  name: string;
  coordinate: Coordinate;
  sourceRef:
    | {
        osmType: "node";
        osmId: number;
        url: string;
      }
    | {
        dataset: "gla-cool-spaces-2025";
        recordId: number;
        url: string;
      };
  details?: RouteContextFeatureDetails;
}

export interface RouteContextData {
  schemaVersion: 1;
  areaId: RouteContextAreaId;
  bbox: [west: number, south: number, east: number, north: number];
  source: RouteContextSource;
  additionalSources?: RouteContextSource[];
  completeness: Record<RouteContextCategory, RouteContextCompleteness>;
  features: RouteContextFeature[];
}

export interface RouteContextProximity {
  feature: RouteContextFeature;
  /** Unrounded straight-line distance to the closest point on the route geometry. */
  rawDistanceFromRouteMetres: number;
  /** Straight-line distance rounded up to avoid displaying false precision. */
  distanceFromRouteMetres: number;
  /**
   * Lower bound for leaving the route and returning to the same point, rounded up.
   * It is not a walking-network route and must always be presented as "at least".
   */
  minimumReturnDetourMetres: number;
  routeProgressMetres: number;
  routeProgressPercent: number;
  nearestRouteCoordinate: Coordinate;
}

export interface RouteContextCategorySummary {
  category: RouteContextCategory;
  completeness: RouteContextCompleteness;
  matches: RouteContextProximity[];
  additionalMatchCount: number;
}

export interface RouteContextSummary {
  areaId: RouteContextAreaId;
  routeId: string;
  radiusMetres: number;
  categories: RouteContextCategorySummary[];
}

export interface RouteContextSummaryOptions {
  radiusMetres?: number;
  limitPerCategory?: number;
}

export interface LoadRouteContextOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_ROUTE_CONTEXT_RADIUS_METRES = 250;
export const DEFAULT_ROUTE_CONTEXT_LIMIT_PER_CATEGORY = 3;

const AREA_IDS: readonly RouteContextAreaId[] = ["waterloo", "kings-cross"];
const COMPLETENESS_STATUSES: readonly RouteContextCompletenessStatus[] = [
  "complete",
  "partial",
  "not-collected",
  "unknown",
];
const SUBTYPES: readonly RouteContextSubtype[] = [
  "official-cool-space",
  "drinking-fountain",
  "toilet",
  "bench",
  "shelter",
  "individual-tree",
];
const DETAIL_ENUMS = {
  access: ["yes", "customers", "private", "unknown"],
  fee: ["yes", "no", "unknown"],
  wheelchair: ["yes", "limited", "no", "unknown"],
  indoor: ["yes", "no", "unknown"],
  backrest: ["yes", "no", "unknown"],
} as const;
const SUBTYPE_CATEGORY: Record<RouteContextSubtype, RouteContextCategory> = {
  "official-cool-space": "cool-space",
  "drinking-fountain": "drinking-water",
  toilet: "toilet",
  bench: "rest",
  shelter: "rest",
  "individual-tree": "tree",
};
const EARTH_RADIUS_METRES = 6_371_000;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown, maximumLength = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function safeHttpUrl(value: unknown): value is string {
  if (!nonEmptyString(value, 2_000)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
}

function coordinateValue(value: unknown): Coordinate | null {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number" ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    Math.abs(value[0]) > 180 ||
    Math.abs(value[1]) > 90
  ) {
    return null;
  }
  return [value[0], value[1]];
}

function bboxValue(value: unknown): RouteContextData["bbox"] | null {
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => (
    typeof item !== "number" || !Number.isFinite(item)
  ))) {
    return null;
  }
  const [west, south, east, north] = value;
  if (west >= east || south >= north || west < -180 || east > 180 || south < -90 || north > 90) {
    return null;
  }
  return [west, south, east, north];
}

function sourceValue(value: unknown): RouteContextSource | null {
  const source = objectValue(value);
  if (
    !source ||
    !nonEmptyString(source.label, 160) ||
    !safeHttpUrl(source.url) ||
    !nonEmptyString(source.licence, 80) ||
    !isIsoDateTime(source.snapshotAt) ||
    !nonEmptyString(source.method, 1_000)
  ) {
    return null;
  }
  return {
    label: source.label,
    url: source.url,
    licence: source.licence,
    snapshotAt: source.snapshotAt,
    method: source.method,
  };
}

function isOpenStreetMapSource(source: RouteContextSource) {
  return source.label === "OpenStreetMap contributors" &&
    source.url === OPENSTREETMAP_SOURCE_URL &&
    source.licence === "ODbL";
}

function isGlaCoolSpaces2025Source(source: RouteContextSource) {
  return source.label === GLA_COOL_SPACES_2025_SOURCE.label &&
    source.url === GLA_COOL_SPACES_2025_SOURCE.url &&
    source.licence === GLA_COOL_SPACES_2025_SOURCE.licence &&
    source.snapshotAt === GLA_COOL_SPACES_2025_SOURCE.snapshotAt &&
    source.method === GLA_COOL_SPACES_2025_SOURCE.method;
}

function completenessValue(value: unknown): RouteContextCompleteness | null {
  const completeness = objectValue(value);
  if (
    !completeness ||
    typeof completeness.status !== "string" ||
    !COMPLETENESS_STATUSES.includes(completeness.status as RouteContextCompletenessStatus) ||
    !nonEmptyString(completeness.note, 1_000)
  ) {
    return null;
  }
  return {
    status: completeness.status as RouteContextCompletenessStatus,
    note: completeness.note,
  };
}

function optionalEnum<K extends keyof typeof DETAIL_ENUMS>(
  details: Record<string, unknown>,
  key: K,
): (typeof DETAIL_ENUMS)[K][number] | undefined | null {
  const value = details[key];
  if (value === undefined) return undefined;
  return typeof value === "string" && (DETAIL_ENUMS[key] as readonly string[]).includes(value)
    ? value as (typeof DETAIL_ENUMS)[K][number]
    : null;
}

function detailsValue(value: unknown): RouteContextFeatureDetails | null | undefined {
  if (value === undefined) return undefined;
  const details = objectValue(value);
  if (!details) return null;
  const access = optionalEnum(details, "access");
  const fee = optionalEnum(details, "fee");
  const wheelchair = optionalEnum(details, "wheelchair");
  const indoor = optionalEnum(details, "indoor");
  const backrest = optionalEnum(details, "backrest");
  if (
    access === null ||
    fee === null ||
    wheelchair === null ||
    indoor === null ||
    backrest === null
  ) return null;
  if (details.openingHours !== undefined && !nonEmptyString(details.openingHours, 250)) return null;
  if (details.level !== undefined && !nonEmptyString(details.level, 80)) return null;
  if (details.checkDate !== undefined && !isIsoDate(details.checkDate)) return null;
  if (details.coolSpaceRegisterYear !== undefined && details.coolSpaceRegisterYear !== 2025) return null;
  if (
    details.coolSpaceTier !== undefined &&
    details.coolSpaceTier !== 1 &&
    details.coolSpaceTier !== 2
  ) return null;
  if (
    details.notes !== undefined &&
    (!Array.isArray(details.notes) || details.notes.some((note) => !nonEmptyString(note, 500)))
  ) {
    return null;
  }
  return {
    ...(access === undefined ? {} : { access }),
    ...(fee === undefined ? {} : { fee }),
    ...(wheelchair === undefined ? {} : { wheelchair }),
    ...(indoor === undefined ? {} : { indoor }),
    ...(backrest === undefined ? {} : { backrest }),
    ...(details.openingHours === undefined ? {} : { openingHours: details.openingHours as string }),
    ...(details.level === undefined ? {} : { level: details.level as string }),
    ...(details.checkDate === undefined ? {} : { checkDate: details.checkDate as string }),
    ...(details.coolSpaceRegisterYear === undefined
      ? {}
      : { coolSpaceRegisterYear: details.coolSpaceRegisterYear as 2025 }),
    ...(details.coolSpaceTier === undefined
      ? {}
      : { coolSpaceTier: details.coolSpaceTier as 1 | 2 }),
    ...(details.notes === undefined ? {} : { notes: [...details.notes as string[]] }),
  };
}

function featureValue(
  value: unknown,
  bbox: RouteContextData["bbox"],
): RouteContextFeature | null {
  const feature = objectValue(value);
  if (!feature || !nonEmptyString(feature.id, 160) || !nonEmptyString(feature.name, 240)) return null;
  if (
    typeof feature.category !== "string" ||
    !ROUTE_CONTEXT_CATEGORIES.includes(feature.category as RouteContextCategory) ||
    typeof feature.subtype !== "string" ||
    !SUBTYPES.includes(feature.subtype as RouteContextSubtype)
  ) {
    return null;
  }
  const category = feature.category as RouteContextCategory;
  const subtype = feature.subtype as RouteContextSubtype;
  if (SUBTYPE_CATEGORY[subtype] !== category) return null;

  const coordinate = coordinateValue(feature.coordinate);
  if (!coordinate) return null;
  const [west, south, east, north] = bbox;
  if (coordinate[0] < west || coordinate[0] > east || coordinate[1] < south || coordinate[1] > north) {
    return null;
  }

  const sourceRef = objectValue(feature.sourceRef);
  if (!sourceRef || !safeHttpUrl(sourceRef.url)) return null;
  let parsedSourceRef: RouteContextFeature["sourceRef"];
  if (sourceRef.osmType === "node") {
    if (
      typeof sourceRef.osmId !== "number" ||
      !Number.isSafeInteger(sourceRef.osmId) ||
      sourceRef.osmId <= 0 ||
      sourceRef.url !== `https://www.openstreetmap.org/node/${sourceRef.osmId}`
    ) return null;
    parsedSourceRef = { osmType: "node", osmId: sourceRef.osmId, url: sourceRef.url };
  } else if (sourceRef.dataset === "gla-cool-spaces-2025") {
    if (
      typeof sourceRef.recordId !== "number" ||
      !Number.isSafeInteger(sourceRef.recordId) ||
      sourceRef.recordId <= 0 ||
      sourceRef.url !== GLA_COOL_SPACES_2025_DATASET_URL
    ) return null;
    parsedSourceRef = {
      dataset: "gla-cool-spaces-2025",
      recordId: sourceRef.recordId,
      url: sourceRef.url,
    };
  } else {
    return null;
  }

  const details = detailsValue(feature.details);
  if (details === null) return null;
  if ("dataset" in parsedSourceRef) {
    if (
      subtype !== "official-cool-space" ||
      feature.id !== `gla-cool-space-${parsedSourceRef.recordId}` ||
      details?.coolSpaceRegisterYear !== 2025 ||
      (details.coolSpaceTier !== 1 && details.coolSpaceTier !== 2)
    ) return null;
  } else if (
    subtype === "official-cool-space" ||
    feature.id !== `osm-node-${parsedSourceRef.osmId}` ||
    details?.coolSpaceRegisterYear !== undefined ||
    details?.coolSpaceTier !== undefined
  ) {
    return null;
  }
  return {
    id: feature.id,
    category,
    subtype,
    name: feature.name,
    coordinate,
    sourceRef: parsedSourceRef,
    ...(details === undefined ? {} : { details }),
  };
}

/** Strictly validates fetched context so malformed or overclaimed data is not displayed. */
export function parseRouteContextData(value: unknown): RouteContextData | null {
  const root = objectValue(value);
  if (
    !root ||
    root.schemaVersion !== 1 ||
    typeof root.areaId !== "string" ||
    !AREA_IDS.includes(root.areaId as RouteContextAreaId)
  ) {
    return null;
  }
  const bbox = bboxValue(root.bbox);
  const source = sourceValue(root.source);
  const additionalSources = root.additionalSources === undefined
    ? []
    : Array.isArray(root.additionalSources)
      ? root.additionalSources.map(sourceValue)
      : [null];
  const completenessRoot = objectValue(root.completeness);
  if (
    !bbox ||
    !source ||
    additionalSources.some((item) => !item) ||
    !completenessRoot ||
    !Array.isArray(root.features)
  ) return null;
  const validAdditionalSources = additionalSources as RouteContextSource[];
  const sourceUrls = [source, ...validAdditionalSources].map((item) => item.url);
  if (
    new Set(sourceUrls).size !== sourceUrls.length ||
    !isOpenStreetMapSource(source) ||
    validAdditionalSources.length > 1 ||
    validAdditionalSources.some((item) => !isGlaCoolSpaces2025Source(item))
  ) return null;

  const completenessEntries = ROUTE_CONTEXT_CATEGORIES.map((category) => (
    [category, completenessValue(completenessRoot[category])] as const
  ));
  if (completenessEntries.some(([, entry]) => !entry)) return null;
  const completeness = Object.fromEntries(completenessEntries) as Record<
    RouteContextCategory,
    RouteContextCompleteness
  >;
  const features = root.features.map((feature) => featureValue(feature, bbox));
  if (features.some((feature) => !feature)) return null;
  const validFeatures = features as RouteContextFeature[];
  const ids = new Set<string>();
  const sourceIds = new Set<string>();
  for (const feature of validFeatures) {
    const sourceId = "osmId" in feature.sourceRef
      ? `osm:${feature.sourceRef.osmId}`
      : `gla:${feature.sourceRef.recordId}`;
    if (ids.has(feature.id) || sourceIds.has(sourceId)) return null;
    if (completeness[feature.category].status === "not-collected") return null;
    ids.add(feature.id);
    sourceIds.add(sourceId);
  }
  const hasGlaSource = validAdditionalSources.some(isGlaCoolSpaces2025Source);
  const hasGlaFeatures = validFeatures.some((feature) => "dataset" in feature.sourceRef);
  if (hasGlaSource !== hasGlaFeatures) return null;
  if (
    hasGlaFeatures
      ? completeness["cool-space"].status !== "partial"
      : completeness["cool-space"].status !== "not-collected"
  ) return null;

  return {
    schemaVersion: 1,
    areaId: root.areaId as RouteContextAreaId,
    bbox,
    source,
    ...(validAdditionalSources.length ? { additionalSources: validAdditionalSources } : {}),
    completeness,
    features: validFeatures,
  };
}

export function routeContextDataUrl(areaId: RouteContextAreaId) {
  return `/data/context-${areaId}.json`;
}

export async function loadRouteContext(
  areaId: RouteContextAreaId,
  options: LoadRouteContextOptions = {},
): Promise<RouteContextData> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(routeContextDataUrl(areaId), {
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) throw new Error("Route context is unavailable.");
  const parsed = parseRouteContextData(await response.json());
  if (!parsed || parsed.areaId !== areaId) throw new Error("Route context is invalid.");
  return parsed;
}

function radians(degrees: number) {
  return degrees * Math.PI / 180;
}

function haversineMetres(a: Coordinate, b: Coordinate) {
  const latitude1 = radians(a[1]);
  const latitude2 = radians(b[1]);
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = radians(b[0] - a[0]);
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const h = sinLatitude * sinLatitude +
    Math.cos(latitude1) * Math.cos(latitude2) * sinLongitude * sinLongitude;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface SegmentProjection {
  coordinate: Coordinate;
  distanceMetres: number;
  fraction: number;
}

function projectPointToSegment(point: Coordinate, start: Coordinate, end: Coordinate): SegmentProjection {
  const referenceLatitude = radians((point[1] + start[1] + end[1]) / 3);
  const longitudeScale = EARTH_RADIUS_METRES * Math.cos(referenceLatitude) * Math.PI / 180;
  const latitudeScale = EARTH_RADIUS_METRES * Math.PI / 180;
  const startX = (start[0] - point[0]) * longitudeScale;
  const startY = (start[1] - point[1]) * latitudeScale;
  const endX = (end[0] - point[0]) * longitudeScale;
  const endY = (end[1] - point[1]) * latitudeScale;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  const fraction = squaredLength === 0
    ? 0
    : Math.max(0, Math.min(1, -(startX * deltaX + startY * deltaY) / squaredLength));
  const coordinate: Coordinate = [
    start[0] + (end[0] - start[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
  ];
  return { coordinate, distanceMetres: haversineMetres(point, coordinate), fraction };
}

function roundUpDistance(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / 10) * 10;
}

/**
 * Finds the closest point on the displayed route geometry. The returned detour
 * is deliberately only a straight-line lower bound; it does not assert that a
 * crossing, entrance or walkable connection exists.
 */
export function estimateRouteContextProximity(
  route: Pick<WalkingRoute, "coordinates">,
  feature: RouteContextFeature,
): RouteContextProximity | null {
  if (!route.coordinates.length) return null;
  if (route.coordinates.length === 1) {
    const rawDistanceFromRouteMetres = haversineMetres(
      feature.coordinate,
      route.coordinates[0],
    );
    return {
      feature,
      rawDistanceFromRouteMetres,
      distanceFromRouteMetres: roundUpDistance(rawDistanceFromRouteMetres),
      minimumReturnDetourMetres: roundUpDistance(rawDistanceFromRouteMetres * 2),
      routeProgressMetres: 0,
      routeProgressPercent: 0,
      nearestRouteCoordinate: [...route.coordinates[0]],
    };
  }

  let travelledMetres = 0;
  let totalRouteMetres = 0;
  let best: (SegmentProjection & { routeProgressMetres: number }) | null = null;
  const segmentLengths: number[] = [];
  for (let index = 1; index < route.coordinates.length; index += 1) {
    const segmentLength = haversineMetres(route.coordinates[index - 1], route.coordinates[index]);
    segmentLengths.push(segmentLength);
    totalRouteMetres += segmentLength;
  }
  for (let index = 1; index < route.coordinates.length; index += 1) {
    const projected = projectPointToSegment(
      feature.coordinate,
      route.coordinates[index - 1],
      route.coordinates[index],
    );
    const routeProgressMetres = travelledMetres + segmentLengths[index - 1] * projected.fraction;
    if (!best || projected.distanceMetres < best.distanceMetres) {
      best = { ...projected, routeProgressMetres };
    }
    travelledMetres += segmentLengths[index - 1];
  }
  if (!best) return null;

  return {
    feature,
    rawDistanceFromRouteMetres: best.distanceMetres,
    distanceFromRouteMetres: roundUpDistance(best.distanceMetres),
    minimumReturnDetourMetres: roundUpDistance(best.distanceMetres * 2),
    routeProgressMetres: roundUpDistance(best.routeProgressMetres),
    routeProgressPercent: totalRouteMetres > 0
      ? Math.max(0, Math.min(100, (best.routeProgressMetres / totalRouteMetres) * 100))
      : 0,
    nearestRouteCoordinate: best.coordinate,
  };
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export function buildRouteContextSummary(
  route: Pick<WalkingRoute, "id" | "coordinates">,
  data: RouteContextData,
  options: RouteContextSummaryOptions = {},
): RouteContextSummary {
  const radiusMetres = boundedOption(
    options.radiusMetres,
    DEFAULT_ROUTE_CONTEXT_RADIUS_METRES,
    10,
    2_000,
  );
  const limitPerCategory = boundedOption(
    options.limitPerCategory,
    DEFAULT_ROUTE_CONTEXT_LIMIT_PER_CATEGORY,
    1,
    20,
  );
  const matches = data.features
    .map((feature) => estimateRouteContextProximity(route, feature))
    .filter((match): match is RouteContextProximity => (
      match !== null && match.rawDistanceFromRouteMetres <= radiusMetres
    ));

  return {
    areaId: data.areaId,
    routeId: route.id,
    radiusMetres,
    categories: ROUTE_CONTEXT_CATEGORIES.map((category) => {
      const categoryMatches = matches
        .filter((match) => match.feature.category === category)
        .sort((left, right) => (
          left.rawDistanceFromRouteMetres - right.rawDistanceFromRouteMetres ||
          left.feature.name.localeCompare(right.feature.name, "en-GB")
        ));
      return {
        category,
        completeness: data.completeness[category],
        matches: categoryMatches.slice(0, limitPerCategory),
        additionalMatchCount: Math.max(0, categoryMatches.length - limitPerCategory),
      };
    }),
  };
}
