import proj4 from "proj4";
import * as SunCalc from "suncalc";

import type { HeightGrid } from "./raster-shade.ts";
import type { Coordinate } from "./routes.ts";

export interface GroundShadowFrame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  isDaylight: boolean;
  azimuthDeg: number;
  altitudeDeg: number;
  shadowPercent: number;
}

const BNG_PROJECTION =
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs";
const OBSERVER_HEIGHT_METRES = 1.5;
const MAXIMUM_CAST_DISTANCE_METRES = 250;
const SHADOW_RGBA = [55, 70, 82, 104] as const;
const NIGHT_RGBA = [42, 54, 68, 54] as const;

interface ShadowOffset {
  x: number;
  y: number;
  distanceMetres: number;
}

function bngToLongitudeLatitude(easting: number, northing: number): Coordinate {
  return proj4(BNG_PROJECTION, "EPSG:4326", [easting, northing]) as Coordinate;
}

/**
 * Return the image corners expected by MapLibre's canvas/image sources.
 * Height-grid rows run from the BNG north edge down towards the south edge.
 */
export function heightGridCanvasCoordinates(
  grid: HeightGrid,
): [Coordinate, Coordinate, Coordinate, Coordinate] {
  const [west, south, east, north] = grid.metadata.bboxBng;
  return [
    bngToLongitudeLatitude(west, north),
    bngToLongitudeLatitude(east, north),
    bngToLongitudeLatitude(east, south),
    bngToLongitudeLatitude(west, south),
  ];
}

function makePixels(width: number, height: number, rgba: readonly number[]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = rgba[0];
    pixels[index + 1] = rgba[1];
    pixels[index + 2] = rgba[2];
    pixels[index + 3] = rgba[3];
  }
  return pixels;
}

/**
 * Rasterise one-cell-wide shadow paths. Sampling by the dominant axis produces
 * a connected path at every bearing without duplicate offsets.
 */
function shadowOffsets(
  azimuthRadians: number,
  resolutionMetres: number,
  maximumDistanceMetres: number,
): ShadowOffset[] {
  // Sun azimuth is clockwise from north. Raster x grows east and raster y grows
  // south, so these components point away from the sun in grid coordinates.
  const east = -Math.sin(azimuthRadians);
  const south = Math.cos(azimuthRadians);
  const dominant = Math.max(Math.abs(east), Math.abs(south));
  const maximumAxisCells = Math.floor(
    (maximumDistanceMetres * dominant) / resolutionMetres,
  );
  const offsets: ShadowOffset[] = [];
  let previousX = 0;
  let previousY = 0;

  for (let axisCells = 1; axisCells <= maximumAxisCells; axisCells += 1) {
    const x = Math.round((east * axisCells) / dominant);
    const y = Math.round((south * axisCells) / dominant);
    if (x === previousX && y === previousY) continue;

    const distanceMetres = Math.hypot(x, y) * resolutionMetres;
    if (distanceMetres > maximumDistanceMetres) continue;
    offsets.push({ x, y, distanceMetres });
    previousX = x;
    previousY = y;
  }

  return offsets;
}

function paintMask(mask: Uint8Array, rgba: readonly number[]) {
  const pixels = new Uint8ClampedArray(mask.length * 4);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) continue;
    const pixelIndex = index * 4;
    pixels[pixelIndex] = rgba[0];
    pixels[pixelIndex + 1] = rgba[1];
    pixels[pixelIndex + 2] = rgba[2];
    pixels[pixelIndex + 3] = rgba[3];
  }
  return pixels;
}

/** Render a north-up translucent ground-shadow mask from an nDSM height grid. */
export function renderGroundShadowFrame(
  grid: HeightGrid,
  date: Date,
  centre: Coordinate,
): GroundShadowFrame {
  const { width, height, resolutionMetres, heightStepMetres } = grid.metadata;
  const cellCount = width * height;
  if (grid.heights.length !== cellCount) {
    throw new Error("Height coverage is incomplete.");
  }
  if (grid.validity && grid.validity.length !== cellCount) {
    throw new Error("Height validity coverage is incomplete.");
  }
  const usesAbsoluteElevations = Boolean(
    grid.terrainElevations &&
    grid.minimumSurfaceElevations &&
    grid.maximumSurfaceElevations,
  );
  if (
    usesAbsoluteElevations &&
    (grid.terrainElevations!.length !== cellCount ||
      grid.minimumSurfaceElevations!.length !== cellCount ||
      grid.maximumSurfaceElevations!.length !== cellCount)
  ) {
    throw new Error("Absolute elevation coverage is incomplete.");
  }

  const position = SunCalc.getPosition(date, centre[1], centre[0]);
  const azimuthDeg = position.azimuth;
  const altitudeDeg = position.altitude;
  if (!Number.isFinite(azimuthDeg) || !Number.isFinite(altitudeDeg)) {
    throw new Error("Solar position is unavailable.");
  }

  if (altitudeDeg <= 0) {
    return {
      width,
      height,
      pixels: makePixels(width, height, NIGHT_RGBA),
      isDaylight: false,
      azimuthDeg,
      altitudeDeg,
      shadowPercent: 100,
    };
  }

  const mask = new Uint8Array(cellCount);
  let maximumHeightSteps = 0;
  let maximumAbsoluteSurface = Number.NEGATIVE_INFINITY;
  let minimumAbsoluteTerrain = Number.POSITIVE_INFINITY;
  let shadowCellCount = 0;

  // Elevated cells themselves are not exposed ground, and including their
  // footprint also closes the otherwise artificial gap at the start of a cast.
  for (let index = 0; index < cellCount; index += 1) {
    if (grid.validity && grid.validity[index] !== 255) continue;
    const heightSteps = grid.heights[index];
    const terrain = grid.terrainElevations?.[index];
    const maximumSurface = grid.maximumSurfaceElevations?.[index];
    if (
      usesAbsoluteElevations &&
      Number.isFinite(terrain) &&
      Number.isFinite(maximumSurface)
    ) {
      minimumAbsoluteTerrain = Math.min(minimumAbsoluteTerrain, terrain!);
      maximumAbsoluteSurface = Math.max(maximumAbsoluteSurface, maximumSurface!);
    }
    const aboveTerrain = usesAbsoluteElevations && Number.isFinite(terrain) && Number.isFinite(maximumSurface)
      ? maximumSurface! - terrain!
      : heightSteps * heightStepMetres;
    if (aboveTerrain <= OBSERVER_HEIGHT_METRES) continue;
    mask[index] = 1;
    shadowCellCount += 1;
    if (heightSteps > maximumHeightSteps) maximumHeightSteps = heightSteps;
  }

  const altitudeRadians = (altitudeDeg * Math.PI) / 180;
  const tangent = Math.tan(altitudeRadians);
  const maximumHeightMetres = usesAbsoluteElevations
    ? maximumAbsoluteSurface - minimumAbsoluteTerrain
    : maximumHeightSteps * heightStepMetres;
  const naturalMaximumDistance =
    maximumHeightMetres > OBSERVER_HEIGHT_METRES
      ? (maximumHeightMetres - OBSERVER_HEIGHT_METRES) / tangent
      : 0;
  const maximumDistanceMetres = Math.min(
    MAXIMUM_CAST_DISTANCE_METRES,
    naturalMaximumDistance,
  );
  const offsets = shadowOffsets(
    (azimuthDeg * Math.PI) / 180,
    resolutionMetres,
    maximumDistanceMetres,
  );

  for (const offset of offsets) {
    const requiredRelativeHeight = OBSERVER_HEIGHT_METRES + offset.distanceMetres * tangent;
    const requiredHeightSteps = requiredRelativeHeight / heightStepMetres;
    const sourceXStart = Math.max(0, -offset.x);
    const sourceXEnd = Math.min(width, width - offset.x);
    const sourceYStart = Math.max(0, -offset.y);
    const sourceYEnd = Math.min(height, height - offset.y);

    for (let sourceY = sourceYStart; sourceY < sourceYEnd; sourceY += 1) {
      let sourceIndex = sourceY * width + sourceXStart;
      let targetIndex = (sourceY + offset.y) * width + sourceXStart + offset.x;
      for (let sourceX = sourceXStart; sourceX < sourceXEnd; sourceX += 1) {
        // A cell already painted by a footprint or a shorter cast cannot
        // change again. Check it before reading and validating the elevation
        // planes; later offsets commonly overlap most of the existing mask.
        if (mask[targetIndex] === 0) {
          const sourceIsValid = !grid.validity || grid.validity[sourceIndex] === 255;
          const targetIsValid = !grid.validity || grid.validity[targetIndex] === 255;
          const sourceSurface = grid.maximumSurfaceElevations?.[sourceIndex];
          const targetTerrain = grid.terrainElevations?.[targetIndex];
          const absoluteRayCleared =
            usesAbsoluteElevations &&
            Number.isFinite(sourceSurface) &&
            Number.isFinite(targetTerrain)
              ? sourceSurface! > targetTerrain! + requiredRelativeHeight
              : grid.heights[sourceIndex] > requiredHeightSteps;
          if (sourceIsValid && targetIsValid && absoluteRayCleared) {
            mask[targetIndex] = 1;
            shadowCellCount += 1;
          }
        }
        sourceIndex += 1;
        targetIndex += 1;
      }
    }
  }

  return {
    width,
    height,
    pixels: paintMask(mask, SHADOW_RGBA),
    isDaylight: true,
    azimuthDeg,
    altitudeDeg,
    shadowPercent: cellCount === 0 ? 0 : (shadowCellCount / cellCount) * 100,
  };
}
