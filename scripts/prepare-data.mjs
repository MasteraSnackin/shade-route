import { fromFile } from "geotiff";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import proj4 from "proj4";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDirectory = path.join(root, "data");
const publicDirectory = path.join(root, "public", "data");
const DOWNSAMPLE = 4;
const HEIGHT_STEP_METRES = 0.5;
const STOREY_HEIGHT_METRES = 3;
const FALLBACK_BUILDING_HEIGHT_METRES = 12;
const MIN_RASTER_BUILDING_HEIGHT_METRES = 3;
const MAX_RASTER_BUILDING_HEIGHT_METRES = 120;
const MAX_EXPLICIT_BUILDING_HEIGHT_METRES = 1_000;
const MAX_BUILDING_LEVELS = 200;

proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs",
);

const areas = [
  {
    id: "waterloo",
    name: "Waterloo and St Thomas’",
    bbox: [-0.13, 51.4915, -0.0975, 51.5095],
    gridFiles: ["waterloo-dsm.tif", "waterloo-dtm.tif"],
    osmFile: "waterloo-osm.json",
    routeFile: "waterloo-routes-response.json",
    start: { name: "London Waterloo Station", lat: 51.50225, lon: -0.11316 },
    destination: { name: "St Thomas’ Hospital", lat: 51.49906, lon: -0.1187 },
  },
  {
    id: "kings-cross",
    name: "King’s Cross and UCLH",
    bbox: [-0.145, 51.517, -0.109, 51.5365],
    gridFiles: ["kings-dsm.tif", "kings-dtm.tif"],
    osmFile: "kings-cross-osm.json",
    routeFile: "kings-cross-routes-response.json",
    start: { name: "King’s Cross Station", lat: 51.53046, lon: -0.12326 },
    destination: { name: "University College Hospital", lat: 51.5249, lon: -0.13651 },
  },
];

function decodePolyline(encoded, precision = 6) {
  const factor = 10 ** precision;
  const coordinates = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([longitude / factor, latitude / factor]);
  }

  return coordinates;
}

function compactTrip(trip, id) {
  const leg = trip.legs[0];
  return {
    id,
    coordinates: decodePolyline(leg.shape),
    distanceMetres: Math.round(trip.summary.length * 1000),
    durationSeconds: Math.round(trip.summary.time),
    directions: leg.maneuvers.map((maneuver) => ({
      instruction: maneuver.instruction,
      distanceMetres: Math.round(maneuver.length * 1000),
      durationSeconds: Math.round(maneuver.time),
      beginIndex: maneuver.begin_shape_index,
      endIndex: maneuver.end_shape_index,
      maneuverType: Number.isFinite(maneuver.type) ? maneuver.type : undefined,
      bearingAfter: Number.isFinite(maneuver.bearing_after) ? maneuver.bearing_after : undefined,
      succinctInstruction: maneuver.verbal_succinct_transition_instruction,
      roughSurfaceFlag: maneuver.rough === true,
      travelType: maneuver.travel_type,
    })),
  };
}

async function prepareRoutes() {
  const output = [];
  for (const area of areas) {
    const response = JSON.parse(
      await fs.readFile(path.join(dataDirectory, area.routeFile), "utf8"),
    );
    const trips = [response.trip, ...(response.alternates ?? []).map((item) => item.trip)];
    output.push({
      id: area.id,
      name: area.name,
      bbox: area.bbox,
      start: area.start,
      destination: area.destination,
      routes: trips.map((trip, index) => compactTrip(trip, `${area.id}-${index + 1}`)),
    });
  }
  await fs.writeFile(
    path.join(publicDirectory, "pilot-routes.json"),
    JSON.stringify({ generated: "2026-08-12", areas: output }),
  );
}

const greenLandUses = new Set(["forest", "grass", "meadow", "recreation_ground", "village_green"]);

function boundedPositiveNumber(value, maximum) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 && value <= maximum ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

export function parseExplicitHeightMetres(value) {
  if (typeof value === "number") {
    return boundedPositiveNumber(value, MAX_EXPLICIT_BUILDING_HEIGHT_METRES);
  }
  if (typeof value !== "string") return null;

  const metric = value.trim().match(/^(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)?$/i);
  if (metric) {
    return boundedPositiveNumber(metric[1], MAX_EXPLICIT_BUILDING_HEIGHT_METRES);
  }

  const feet = value.trim().match(/^(\d+(?:\.\d+)?)\s*(?:ft|feet|foot)$/i);
  if (feet) {
    const metres = Number(feet[1]) * 0.3048;
    return metres > 0 && metres <= MAX_EXPLICIT_BUILDING_HEIGHT_METRES
      ? Math.round(metres * 100) / 100
      : null;
  }

  const feetAndInches = value.trim().match(/^(\d+)'(?:\s*(\d+(?:\.\d+)?)")?$/);
  if (!feetAndInches) return null;
  const inches = Number(feetAndInches[2] ?? 0);
  if (inches >= 12) return null;
  const metres = Number(feetAndInches[1]) * 0.3048 + inches * 0.0254;
  return metres > 0 && metres <= MAX_EXPLICIT_BUILDING_HEIGHT_METRES
    ? Math.round(metres * 100) / 100
    : null;
}

function pointOnSegment([pointX, pointY], [startX, startY], [endX, endY]) {
  const cross = (pointY - startY) * (endX - startX) - (pointX - startX) * (endY - startY);
  if (Math.abs(cross) > 1e-7) return false;
  const dot = (pointX - startX) * (endX - startX) + (pointY - startY) * (endY - startY);
  if (dot < 0) return false;
  const squaredLength = (endX - startX) ** 2 + (endY - startY) ** 2;
  return dot <= squaredLength;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const start = polygon[previous];
    const end = polygon[index];
    if (pointOnSegment(point, start, end)) return true;
    if (
      (start[1] > point[1]) !== (end[1] > point[1]) &&
      point[0] < ((end[0] - start[0]) * (point[1] - start[1])) / (end[1] - start[1]) + start[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function squaredDistanceToSegment([pointX, pointY], [startX, startY], [endX, endY]) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  if (deltaX === 0 && deltaY === 0) return (pointX - startX) ** 2 + (pointY - startY) ** 2;
  const fraction = Math.max(
    0,
    Math.min(1, ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / (deltaX ** 2 + deltaY ** 2)),
  );
  return (pointX - (startX + fraction * deltaX)) ** 2 + (pointY - (startY + fraction * deltaY)) ** 2;
}

function pointToPolygonDistance(point, polygon) {
  if (pointInPolygon(point, polygon)) return 0;
  let minimumSquaredDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length - 1; index += 1) {
    minimumSquaredDistance = Math.min(
      minimumSquaredDistance,
      squaredDistanceToSegment(point, polygon[index], polygon[index + 1]),
    );
  }
  return Math.sqrt(minimumSquaredDistance);
}

function rasterSamplesNearPolygon(polygonRings, grid, maximumDistanceMetres) {
  const [outerRing, ...innerRings] = polygonRings;
  const eastings = outerRing.map(([easting]) => easting);
  const northings = outerRing.map(([, northing]) => northing);
  const minimumEasting = Math.min(...eastings) - maximumDistanceMetres;
  const maximumEasting = Math.max(...eastings) + maximumDistanceMetres;
  const minimumNorthing = Math.min(...northings) - maximumDistanceMetres;
  const maximumNorthing = Math.max(...northings) + maximumDistanceMetres;
  const [gridMinimumEasting, , , gridMaximumNorthing] = grid.bboxBng;
  const minimumX = Math.max(0, Math.floor((minimumEasting - gridMinimumEasting) / grid.resolutionMetres));
  const maximumX = Math.min(
    grid.width - 1,
    Math.floor((maximumEasting - gridMinimumEasting) / grid.resolutionMetres),
  );
  const minimumY = Math.max(0, Math.floor((gridMaximumNorthing - maximumNorthing) / grid.resolutionMetres));
  const maximumY = Math.min(
    grid.height - 1,
    Math.floor((gridMaximumNorthing - minimumNorthing) / grid.resolutionMetres),
  );
  const samples = [];

  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const centre = [
        gridMinimumEasting + (x + 0.5) * grid.resolutionMetres,
        gridMaximumNorthing - (y + 0.5) * grid.resolutionMetres,
      ];
      const insideFootprint = pointInPolygon(centre, outerRing) &&
        !innerRings.some((innerRing) => pointInPolygon(centre, innerRing));
      const distance = maximumDistanceMetres === 0
        ? (insideFootprint ? 0 : Number.POSITIVE_INFINITY)
        : (insideFootprint
            ? 0
            : Math.min(...polygonRings.map((ring) => pointToPolygonDistance(centre, ring))));
      if (distance > maximumDistanceMetres) continue;
      const index = y * grid.width + x;
      if (grid.validity && grid.validity[index] !== 255) continue;
      const height = grid.values[index] * grid.heightStepMetres;
      if (height > 0) samples.push(height);
    }
  }
  return samples;
}

export function estimateRasterBuildingHeight(projectedPolygon, grid) {
  if (!grid || projectedPolygon.length < 4) return null;
  let samples = rasterSamplesNearPolygon([projectedPolygon], grid, 0);
  if (samples.length === 0) {
    samples = rasterSamplesNearPolygon([projectedPolygon], grid, grid.resolutionMetres);
  }
  return heightFromRasterSamples(samples);
}

function heightFromRasterSamples(samples) {
  if (samples.length === 0) return null;

  samples.sort((left, right) => left - right);
  const middle = Math.floor(samples.length / 2);
  const median = samples.length % 2 === 0
    ? (samples[middle - 1] + samples[middle]) / 2
    : samples[middle];
  const bounded = Math.max(
    MIN_RASTER_BUILDING_HEIGHT_METRES,
    Math.min(MAX_RASTER_BUILDING_HEIGHT_METRES, median),
  );
  return Math.round(bounded / HEIGHT_STEP_METRES) * HEIGHT_STEP_METRES;
}

function estimateRasterBuildingHeightForPolygons(projectedPolygons, grid) {
  if (!grid || projectedPolygons.length === 0) return null;
  let samples = projectedPolygons.flatMap((polygon) =>
    rasterSamplesNearPolygon(polygon, grid, 0),
  );
  if (samples.length === 0) {
    samples = projectedPolygons.flatMap((polygon) =>
      rasterSamplesNearPolygon(polygon, grid, grid.resolutionMetres),
    );
  }
  return heightFromRasterSamples(samples);
}

export function resolveBuildingHeight(tags, projectedPolygon, grid) {
  const explicitHeight = parseExplicitHeightMetres(tags.height);
  if (explicitHeight !== null) return { heightMetres: explicitHeight, source: "explicit" };

  const levels = boundedPositiveNumber(tags["building:levels"], MAX_BUILDING_LEVELS);
  if (levels !== null) {
    return { heightMetres: levels * STOREY_HEIGHT_METRES, source: "levels" };
  }

  const rasterHeight = estimateRasterBuildingHeight(projectedPolygon, grid);
  if (rasterHeight !== null) return { heightMetres: rasterHeight, source: "raster" };
  return { heightMetres: FALLBACK_BUILDING_HEIGHT_METRES, source: "fallback" };
}

function resolveMultipolygonBuildingHeight(tags, projectedPolygons, grid) {
  const explicitHeight = parseExplicitHeightMetres(tags.height);
  if (explicitHeight !== null) return { heightMetres: explicitHeight, source: "explicit" };

  const levels = boundedPositiveNumber(tags["building:levels"], MAX_BUILDING_LEVELS);
  if (levels !== null) {
    return { heightMetres: levels * STOREY_HEIGHT_METRES, source: "levels" };
  }

  const rasterHeight = estimateRasterBuildingHeightForPolygons(projectedPolygons, grid);
  if (rasterHeight !== null) return { heightMetres: rasterHeight, source: "raster" };
  return { heightMetres: FALLBACK_BUILDING_HEIGHT_METRES, source: "fallback" };
}

function compareOsmIds(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "en", { numeric: true });
}

function sameNodeId(left, right) {
  return String(left) === String(right);
}

function compareNodeSequences(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareOsmIds(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function orientedSegmentFromNode(segment, nodeId) {
  if (sameNodeId(segment.nodes[0], nodeId)) return segment.nodes;
  if (sameNodeId(segment.nodes.at(-1), nodeId)) return [...segment.nodes].reverse();
  return null;
}

function findClosedWayChain(segments, used, path, startNode) {
  const currentNode = path.at(-1);
  if (path.length >= 4 && sameNodeId(currentNode, startNode)) {
    return { path, used };
  }

  const candidates = segments
    .filter((segment) => !used.has(segment.id))
    .filter((segment) =>
      sameNodeId(segment.nodes[0], currentNode) || sameNodeId(segment.nodes.at(-1), currentNode),
    );

  for (const segment of candidates) {
    const oriented = orientedSegmentFromNode(segment, currentNode);
    const nextUsed = new Set(used).add(segment.id);
    const result = findClosedWayChain(
      segments,
      nextUsed,
      [...path, ...oriented.slice(1)],
      startNode,
    );
    if (result) return result;
  }
  return null;
}

/**
 * Joins OSM member ways by shared endpoint node IDs. Complete rings are returned
 * even when the source ways are open, reversed or listed out of order.
 */
function assembleWayRingDetails(members, wayLookup) {
  const uniqueWayIds = [...new Set(
    members
      .filter((member) => member.type === "way")
      .map((member) => member.ref),
  )].sort(compareOsmIds);
  const segments = uniqueWayIds
    .map((wayId) => wayLookup.get(wayId))
    .filter((way) => Array.isArray(way?.nodes) && way.nodes.length >= 2)
    .map((way) => ({ id: way.id, nodes: [...way.nodes] }));
  const available = new Set(segments.map((segment) => segment.id));
  const unresolved = new Set(
    uniqueWayIds.filter((wayId) => !segments.some((segment) => sameNodeId(segment.id, wayId))),
  );
  const rings = [];

  while (available.size > 0) {
    const seed = segments.find((segment) => available.has(segment.id));
    available.delete(seed.id);

    if (sameNodeId(seed.nodes[0], seed.nodes.at(-1))) {
      rings.push(seed.nodes);
      continue;
    }

    const forward = seed.nodes;
    const backward = [...seed.nodes].reverse();
    const orientations = [forward, backward].sort(compareNodeSequences);
    let result = null;
    for (const orientation of orientations) {
      result = findClosedWayChain(
        segments.filter((segment) => available.has(segment.id)),
        new Set(),
        orientation,
        orientation[0],
      );
      if (result) break;
    }

    if (!result) {
      unresolved.add(seed.id);
      continue;
    }
    for (const usedId of result.used) available.delete(usedId);
    rings.push(result.path);
  }

  return { rings, unresolved: [...unresolved].sort(compareOsmIds) };
}

export function assembleWayRings(members, wayLookup) {
  return assembleWayRingDetails(members, wayLookup).rings;
}

function signedRingArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}

function compareCoordinates(left, right) {
  return left[0] - right[0] || left[1] - right[1];
}

function compareCoordinateSequences(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareCoordinates(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function rotateRingToCanonicalStart(core) {
  const rotations = core.map((_, startIndex) => [
    ...core.slice(startIndex),
    ...core.slice(0, startIndex),
  ]);
  rotations.sort(compareCoordinateSequences);
  return [...rotations[0], rotations[0][0]];
}

function coordinatesForRing(nodeIds, nodeLookup, counterClockwise) {
  const coordinates = [];
  for (const nodeId of nodeIds) {
    const node = nodeLookup.get(nodeId);
    if (!node || !Number.isFinite(node.lon) || !Number.isFinite(node.lat)) return null;
    const coordinate = [Number(node.lon.toFixed(6)), Number(node.lat.toFixed(6))];
    if (coordinates.length === 0 || compareCoordinates(coordinates.at(-1), coordinate) !== 0) {
      coordinates.push(coordinate);
    }
  }
  if (coordinates.length < 4 || compareCoordinates(coordinates[0], coordinates.at(-1)) !== 0) {
    return null;
  }

  let core = coordinates.slice(0, -1);
  if (new Set(core.map((coordinate) => coordinate.join(","))).size < 3) return null;
  const area = signedRingArea([...core, core[0]]);
  if (area === 0) return null;
  if ((area > 0) !== counterClockwise) core = [...core].reverse();
  return rotateRingToCanonicalStart(core);
}

function ringKey(ring) {
  return ring.map((coordinate) => coordinate.join(",")).join(";");
}

/** Builds deterministic GeoJSON polygon parts from a building multipolygon relation. */
export function assembleBuildingMultipolygon(relation, wayLookup, nodeLookup) {
  const members = relation.members ?? [];
  if (members.some((member) => member.type !== "way")) return [];
  if (members.some((member) => member.role && member.role !== "outer" && member.role !== "inner")) {
    return [];
  }
  const outerDetails = assembleWayRingDetails(
    members.filter((member) => member.role === "outer" || !member.role),
    wayLookup,
  );
  const innerDetails = assembleWayRingDetails(
    members.filter((member) => member.role === "inner"),
    wayLookup,
  );
  if (outerDetails.unresolved.length > 0 || innerDetails.unresolved.length > 0) return [];

  const outerRings = outerDetails.rings
    .map((ring) => coordinatesForRing(ring, nodeLookup, true))
    .filter(Boolean)
    .sort((left, right) => ringKey(left).localeCompare(ringKey(right)));
  const innerRings = innerDetails.rings
    .map((ring) => coordinatesForRing(ring, nodeLookup, false))
    .filter(Boolean)
    .sort((left, right) => ringKey(left).localeCompare(ringKey(right)));
  if (outerRings.length !== outerDetails.rings.length || innerRings.length !== innerDetails.rings.length) {
    return [];
  }
  if (outerRings.length === 0) return [];

  const polygons = outerRings.map((outerRing) => ({
    area: Math.abs(signedRingArea(outerRing)),
    rings: [outerRing],
  }));
  for (const innerRing of innerRings) {
    const containingPolygons = polygons
      .filter((polygon) => pointInPolygon(innerRing[0], polygon.rings[0]))
      .sort((left, right) => left.area - right.area);
    if (containingPolygons.length === 0) return [];
    containingPolygons[0].rings.push(innerRing);
  }
  for (const polygon of polygons) {
    polygon.rings.splice(
      1,
      polygon.rings.length - 1,
      ...polygon.rings.slice(1).sort((left, right) => ringKey(left).localeCompare(ringKey(right))),
    );
  }
  return polygons.map((polygon) => polygon.rings);
}

function mapFeatureForWay(way, nodeLookup, heightGrid, heightCounts) {
  const tags = way.tags ?? {};
  const coordinates = (way.nodes ?? [])
    .map((nodeId) => nodeLookup.get(nodeId))
    .filter(Boolean)
    .map(({ lon, lat }) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]);
  if (coordinates.length < 2) return null;

  let kind = null;
  let geometryType = "LineString";
  if (tags.building) {
    kind = "building";
    geometryType = "Polygon";
  } else if (tags.highway) {
    kind = "road";
  } else if (tags.natural === "water" || tags.waterway === "riverbank") {
    kind = "water";
    geometryType = "Polygon";
  } else if (
    tags.leisure === "park" ||
    tags.leisure === "garden" ||
    greenLandUses.has(tags.landuse)
  ) {
    kind = "green";
    geometryType = "Polygon";
  }
  if (!kind) return null;

  if (geometryType === "Polygon") {
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) return null;
  }

  const properties = {
    kind,
    class: kind === "building"
      ? tags.building
      : tags.highway ?? tags.landuse ?? tags.leisure ?? tags.natural ?? "",
    name: tags.name ?? "",
  };
  if (kind === "building") {
    const projectedPolygon = coordinates.map((coordinate) =>
      proj4("EPSG:4326", "EPSG:27700", coordinate),
    );
    const buildingHeight = resolveBuildingHeight(tags, projectedPolygon, heightGrid);
    properties.heightMetres = buildingHeight.heightMetres;
    heightCounts[buildingHeight.source] += 1;
  }

  return {
    type: "Feature",
    properties,
    geometry: {
      type: geometryType,
      coordinates: geometryType === "Polygon" ? [coordinates] : coordinates,
    },
  };
}

function mapFeatureForBuildingRelation(relation, wayLookup, nodeLookup, heightGrid, heightCounts) {
  const tags = relation.tags ?? {};
  if (tags.type !== "multipolygon" || !tags.building) return null;
  const polygons = assembleBuildingMultipolygon(relation, wayLookup, nodeLookup);
  if (polygons.length === 0) return null;

  const projectedPolygons = polygons.map((polygon) =>
    polygon.map((ring) =>
      ring.map((coordinate) => proj4("EPSG:4326", "EPSG:27700", coordinate)),
    ),
  );
  const buildingHeight = resolveMultipolygonBuildingHeight(tags, projectedPolygons, heightGrid);
  heightCounts[buildingHeight.source] += 1;

  return {
    type: "Feature",
    properties: {
      kind: "building",
      class: tags.building,
      name: tags.name ?? "",
      heightMetres: buildingHeight.heightMetres,
    },
    geometry: polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons },
  };
}

export function buildMapFeatures(osm, heightGrid, heightCounts = {
  explicit: 0,
  levels: 0,
  raster: 0,
  fallback: 0,
}) {
  const nodes = osm.elements
    .filter((element) => element.type === "node" && Number.isFinite(element.lat) && Number.isFinite(element.lon));
  const ways = osm.elements.filter((element) => element.type === "way");
  const relations = osm.elements
    .filter((element) => element.type === "relation")
    .sort((left, right) => compareOsmIds(left.id, right.id));
  const nodeLookup = new Map(nodes.map((node) => [node.id, node]));
  const wayLookup = new Map(ways.map((way) => [way.id, way]));
  const representedBuildingWays = new Set();
  const relationFeatures = [];

  for (const relation of relations) {
    const feature = mapFeatureForBuildingRelation(
      relation,
      wayLookup,
      nodeLookup,
      heightGrid,
      heightCounts,
    );
    if (!feature) continue;
    relationFeatures.push(feature);
    for (const member of relation.members ?? []) {
      if (member.type === "way") representedBuildingWays.add(member.ref);
    }
  }

  const wayFeatures = ways
    .sort((left, right) => compareOsmIds(left.id, right.id))
    .filter((way) => !(representedBuildingWays.has(way.id) && way.tags?.building))
    .map((way) => mapFeatureForWay(way, nodeLookup, heightGrid, heightCounts))
    .filter(Boolean);
  return [...wayFeatures, ...relationFeatures];
}

async function prepareLocalMap(area, heightGrid) {
  const osm = JSON.parse(await fs.readFile(path.join(dataDirectory, area.osmFile), "utf8"));
  const heightCounts = { explicit: 0, levels: 0, raster: 0, fallback: 0 };
  const features = buildMapFeatures(osm, heightGrid, heightCounts);
  await fs.writeFile(
    path.join(publicDirectory, `${area.id}-map.json`),
    JSON.stringify({ type: "FeatureCollection", features }),
  );
  return heightCounts;
}

async function readRaster(fileName) {
  const source = await fromFile(path.join(dataDirectory, fileName));
  const image = await source.getImage();
  const [values] = await image.readRasters();
  return {
    width: image.getWidth(),
    height: image.getHeight(),
    bbox: image.getBoundingBox(),
    noData: Number(image.getGDALNoData()),
    values,
  };
}

function validElevation(value, noData) {
  return Number.isFinite(value) && value > -1000 && value !== noData;
}

async function prepareHeightGrid(area) {
  const [dsm, dtm] = await Promise.all(area.gridFiles.map(readRaster));
  if (
    dsm.width !== dtm.width ||
    dsm.height !== dtm.height ||
    dsm.bbox.some((value, index) => value !== dtm.bbox[index])
  ) {
    throw new Error(`DSM and DTM do not align for ${area.id}`);
  }

  const width = Math.ceil(dsm.width / DOWNSAMPLE);
  const height = Math.ceil(dsm.height / DOWNSAMPLE);
  const quantizedHeights = new Uint8Array(width * height);
  const validity = new Uint8Array(width * height);
  let anyCovered = 0;
  let completelyCovered = 0;

  for (let targetY = 0; targetY < height; targetY += 1) {
    for (let targetX = 0; targetX < width; targetX += 1) {
      let maximumHeight = 0;
      let validPairs = 0;
      let sourcePixels = 0;
      const startY = targetY * DOWNSAMPLE;
      const startX = targetX * DOWNSAMPLE;

      for (let y = startY; y < Math.min(startY + DOWNSAMPLE, dsm.height); y += 1) {
        for (let x = startX; x < Math.min(startX + DOWNSAMPLE, dsm.width); x += 1) {
          sourcePixels += 1;
          const index = y * dsm.width + x;
          const surface = dsm.values[index];
          const terrain = dtm.values[index];
          if (!validElevation(surface, dsm.noData) || !validElevation(terrain, dtm.noData)) {
            continue;
          }
          validPairs += 1;
          maximumHeight = Math.max(maximumHeight, surface - terrain);
        }
      }

      const targetIndex = targetY * width + targetX;
      if (validPairs > 0) anyCovered += 1;
      if (validPairs === sourcePixels) completelyCovered += 1;
      validity[targetIndex] = sourcePixels
        ? Math.round((validPairs / sourcePixels) * 255)
        : 0;
      quantizedHeights[targetIndex] = Math.max(
        0,
        Math.min(255, Math.round(maximumHeight / HEIGHT_STEP_METRES)),
      );
    }
  }

  await fs.writeFile(path.join(publicDirectory, `${area.id}-heights.bin`), quantizedHeights);
  await fs.writeFile(path.join(publicDirectory, `${area.id}-validity.bin`), validity);
  await fs.writeFile(
    path.join(publicDirectory, `${area.id}-heights.json`),
    JSON.stringify({
      id: area.id,
      width,
      height,
      bboxBng: dsm.bbox,
      resolutionMetres: DOWNSAMPLE,
      heightStepMetres: HEIGHT_STEP_METRES,
      coveragePercent: Math.round((completelyCovered / quantizedHeights.length) * 1000) / 10,
      anyCoveragePercent: Math.round((anyCovered / quantizedHeights.length) * 1000) / 10,
      validityFile: `${area.id}-validity.bin`,
      validityEncoding: "fraction-255",
      source: "Environment Agency LIDAR Composite 1m DSM minus DTM",
      sourceDate: "Composite surveys 2000–2022",
      processed: "2026-08-12",
    }),
  );
  return {
    width,
    height,
    bboxBng: dsm.bbox,
    resolutionMetres: DOWNSAMPLE,
    heightStepMetres: HEIGHT_STEP_METRES,
    values: quantizedHeights,
    validity,
  };
}

async function main() {
  await fs.mkdir(publicDirectory, { recursive: true });
  await prepareRoutes();
  for (const area of areas) {
    const heightGrid = await prepareHeightGrid(area);
    const heightCounts = await prepareLocalMap(area, heightGrid);
    console.log(
      `Prepared ${area.id}; building heights: ${Object.entries(heightCounts)
        .map(([source, count]) => `${source}=${count}`)
        .join(", ")}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
