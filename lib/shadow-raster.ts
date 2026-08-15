import proj4 from "proj4";
import * as SunCalc from "suncalc";

import type { HeightGrid } from "./raster-shade.ts";
import type { Coordinate } from "./routes.ts";

export interface GroundShadowFrame {
  width: number;
  height: number;
  /** One RGBA display channel per cell: certain, possible, unknown or search-limited. */
  pixels: Uint8ClampedArray;
  isDaylight: boolean;
  azimuthDeg: number;
  altitudeDeg: number;
  lowSun: boolean;
  /** Certain plus possible modelled-shadow cells; unresolved cells are excluded. */
  shadowPercent: number;
  certainShadowPercent: number;
  /** Possible but not certain modelled-shadow cells. This is not a probability. */
  possibleShadowPercent: number;
  /** Cells unresolved because height coverage or the model boundary is incomplete. */
  unknownPercent: number;
  /** Cells unresolved specifically because ray searches stop at 250 metres. */
  searchLimitedPercent: number;
  /** Hard cap applied to every daylight occluder search. */
  raySearchLimitMetres: number;
  /** Altitude below which the low-sun warning is raised. */
  lowSunThresholdDegrees: number;
}

export interface GroundShadowRenderOptions {
  /**
   * Benchmark-only reference switch. Production callers should omit it so
   * already-painted targets are rejected before elevation-plane reads.
   */
  skipPaintedTargetFastPath?: boolean;
  /**
   * Benchmark-only reference switch. Production callers should omit it so
   * complete absolute-elevation grids use the search-limited tight loop.
   */
  searchLimitedAbsoluteFastPath?: boolean;
}

const BNG_PROJECTION =
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs";
const OBSERVER_HEIGHT_METRES = 1.5;
const MAXIMUM_CAST_DISTANCE_METRES = 250;
const LOW_SUN_ALTITUDE_DEGREES = 3;
const CLEARANCE_MARGIN_METRES = 2;
export const GROUND_SHADOW_LEGEND = [
  { channel: "certain", label: "Shade under both height bounds", rgba: [55, 70, 82, 104] },
  { channel: "possible", label: "Possible shade, not confirmed", rgba: [106, 93, 145, 92] },
  { channel: "unknown", label: "Unknown height coverage", rgba: [89, 98, 94, 76] },
  { channel: "search-limited", label: "Unresolved at 250 m", rgba: [150, 111, 40, 82] },
] as const;
const SHADOW_RGBA = GROUND_SHADOW_LEGEND[0].rgba;
const POSSIBLE_SHADOW_RGBA = GROUND_SHADOW_LEGEND[1].rgba;
const UNKNOWN_RGBA = GROUND_SHADOW_LEGEND[2].rgba;
const SEARCH_LIMITED_RGBA = GROUND_SHADOW_LEGEND[3].rgba;
const NIGHT_RGBA = [42, 54, 68, 54] as const;

const GROUND_SHADOW_CHANNEL = {
  clear: 0,
  certain: 1,
  possible: 2,
  unknown: 3,
  searchLimited: 4,
} as const;

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

function paintChannels(channels: Uint8Array, width: number) {
  const pixels = new Uint8ClampedArray(channels.length * 4);
  for (let index = 0; index < channels.length; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    const rgba = channels[index] === GROUND_SHADOW_CHANNEL.certain
      ? SHADOW_RGBA
      : channels[index] === GROUND_SHADOW_CHANNEL.possible
        ? POSSIBLE_SHADOW_RGBA
        : channels[index] === GROUND_SHADOW_CHANNEL.unknown
          ? UNKNOWN_RGBA
          : channels[index] === GROUND_SHADOW_CHANNEL.searchLimited
            ? SEARCH_LIMITED_RGBA
            : null;
    if (!rgba) continue;
    const alphaScale = channels[index] === GROUND_SHADOW_CHANNEL.possible
      ? (x + y) % 2 === 0 ? 1 : 0.34
      : channels[index] === GROUND_SHADOW_CHANNEL.unknown
        ? x % 4 === y % 4 || x % 4 + y % 4 === 3 ? 1 : 0.28
        : channels[index] === GROUND_SHADOW_CHANNEL.searchLimited
          ? (x + y) % 4 < 2 ? 1 : 0.3
          : 1;
    const pixelIndex = index * 4;
    pixels[pixelIndex] = rgba[0];
    pixels[pixelIndex + 1] = rgba[1];
    pixels[pixelIndex + 2] = rgba[2];
    pixels[pixelIndex + 3] = Math.round(rgba[3] * alphaScale);
  }
  return pixels;
}

function percent(cellCount: number, total: number) {
  return total === 0 ? 0 : (cellCount / total) * 100;
}

function distanceToGridEdgeMetres(
  x: number,
  y: number,
  width: number,
  height: number,
  sunwardX: number,
  sunwardY: number,
  resolutionMetres: number,
) {
  const xDistanceCells = sunwardX > 0
    ? (width - x - 0.5) / sunwardX
    : sunwardX < 0
      ? (x + 0.5) / -sunwardX
      : Number.POSITIVE_INFINITY;
  const yDistanceCells = sunwardY > 0
    ? (height - y - 0.5) / sunwardY
    : sunwardY < 0
      ? (y + 0.5) / -sunwardY
      : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(xDistanceCells, yDistanceCells) * resolutionMetres);
}

/** Render a north-up translucent ground-shadow mask from an nDSM height grid. */
export function renderGroundShadowFrame(
  grid: HeightGrid,
  date: Date,
  centre: Coordinate,
  options: GroundShadowRenderOptions = {},
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
  const terrainElevations = grid.terrainElevations;
  const minimumSurfaceElevations = grid.minimumSurfaceElevations;
  const maximumSurfaceElevations = grid.maximumSurfaceElevations;
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
      lowSun: false,
      shadowPercent: 100,
      certainShadowPercent: 0,
      possibleShadowPercent: 0,
      unknownPercent: 0,
      searchLimitedPercent: 0,
      raySearchLimitMetres: MAXIMUM_CAST_DISTANCE_METRES,
      lowSunThresholdDegrees: LOW_SUN_ALTITUDE_DEGREES,
    };
  }

  const lowSun = altitudeDeg < LOW_SUN_ALTITUDE_DEGREES;
  const certainMask = new Uint8Array(cellCount);
  const possibleMask = new Uint8Array(cellCount);
  const unknownMask = new Uint8Array(cellCount);
  const validCellMask = new Uint8Array(cellCount);
  const skipPaintedTargetFastPath = options.skipPaintedTargetFastPath ?? true;
  const searchLimitedAbsoluteFastPath =
    options.searchLimitedAbsoluteFastPath ?? true;
  let maximumHeightSteps = 0;
  let maximumAbsoluteSurface = Number.NEGATIVE_INFINITY;
  let minimumAbsoluteTerrain = Number.POSITIVE_INFINITY;
  let allCellsValid = true;
  let certainFootprintCellCount = 0;

  // Treat the min/max surface planes as bounds. A minimum surface clearing the
  // ray by the full margin is certain shade; a maximum surface merely reaching
  // the lower margin is possible shade. This mirrors route-point scoring.
  for (let index = 0; index < cellCount; index += 1) {
    const validityIsComplete = !grid.validity || grid.validity[index] === 255;
    const heightSteps = grid.heights[index];
    const terrain = terrainElevations?.[index];
    const minimumSurface = minimumSurfaceElevations?.[index];
    const maximumSurface = maximumSurfaceElevations?.[index];
    const elevationsAreValid = usesAbsoluteElevations
      ? Number.isFinite(terrain) &&
        Number.isFinite(minimumSurface) &&
        Number.isFinite(maximumSurface) &&
        minimumSurface! <= maximumSurface!
      : Number.isFinite(heightSteps);
    if (!validityIsComplete || !elevationsAreValid) {
      allCellsValid = false;
      unknownMask[index] = 1;
      continue;
    }
    validCellMask[index] = 1;
    if (
      usesAbsoluteElevations &&
      Number.isFinite(terrain) &&
      Number.isFinite(minimumSurface) &&
      Number.isFinite(maximumSurface)
    ) {
      minimumAbsoluteTerrain = Math.min(minimumAbsoluteTerrain, terrain!);
      maximumAbsoluteSurface = Math.max(maximumAbsoluteSurface, maximumSurface!);
    }
    const minimumAboveTerrain = usesAbsoluteElevations
      ? minimumSurface! - terrain!
      : heightSteps * heightStepMetres;
    const maximumAboveTerrain = usesAbsoluteElevations
      ? maximumSurface! - terrain!
      : heightSteps * heightStepMetres;
    if (minimumAboveTerrain >= OBSERVER_HEIGHT_METRES + CLEARANCE_MARGIN_METRES) {
      certainMask[index] = 1;
      possibleMask[index] = 1;
      certainFootprintCellCount += 1;
    } else if (maximumAboveTerrain > OBSERVER_HEIGHT_METRES) {
      possibleMask[index] = 1;
    }
    if (heightSteps > maximumHeightSteps) maximumHeightSteps = heightSteps;
  }

  const altitudeRadians = (altitudeDeg * Math.PI) / 180;
  const tangent = Math.tan(altitudeRadians);
  const maximumHeightMetres = usesAbsoluteElevations &&
      Number.isFinite(maximumAbsoluteSurface) &&
      Number.isFinite(minimumAbsoluteTerrain)
    ? Math.max(0, maximumAbsoluteSurface - minimumAbsoluteTerrain)
    : maximumHeightSteps * heightStepMetres;
  const naturalMaximumDistance =
    maximumHeightMetres > OBSERVER_HEIGHT_METRES
      ? (maximumHeightMetres - OBSERVER_HEIGHT_METRES) / tangent
      : 0;
  const rayWasSearchLimited = naturalMaximumDistance > MAXIMUM_CAST_DISTANCE_METRES;
  const maximumDistanceMetres = Math.min(
    MAXIMUM_CAST_DISTANCE_METRES,
    naturalMaximumDistance,
  );
  // An incomplete cell can conceal an occluder taller than every valid cell.
  // Trace it to the explicit cap instead of using the known-height bound.
  const traceDistanceMetres = allCellsValid
    ? maximumDistanceMetres
    : MAXIMUM_CAST_DISTANCE_METRES;
  const offsets = shadowOffsets(
    (azimuthDeg * Math.PI) / 180,
    resolutionMetres,
    traceDistanceMetres,
  );
  // On sparse packs the extra painted-target branch can cost more than it
  // saves. Enable it only when the initial certain footprint is dense enough
  // for repeated casts to overlap substantially.
  const usePaintedTargetFastPath =
    skipPaintedTargetFastPath && certainFootprintCellCount / Math.max(1, cellCount) >= 0.3;

  if (
    searchLimitedAbsoluteFastPath &&
    usesAbsoluteElevations &&
    allCellsValid &&
    rayWasSearchLimited &&
    minimumSurfaceElevations &&
    terrainElevations
  ) {
    // Production pilot packs normally take this low-sun path. Height planes
    // were validated above, and possible-but-unconfirmed cells will be shown
    // as search-limited, so this tight loop only has to establish certain shade.
    for (const offset of offsets) {
      const requiredElevation =
        OBSERVER_HEIGHT_METRES +
        offset.distanceMetres * tangent +
        CLEARANCE_MARGIN_METRES;
      const sourceXStart = Math.max(0, -offset.x);
      const sourceXEnd = Math.min(width, width - offset.x);
      const sourceYStart = Math.max(0, -offset.y);
      const sourceYEnd = Math.min(height, height - offset.y);

      for (let sourceY = sourceYStart; sourceY < sourceYEnd; sourceY += 1) {
        let sourceIndex = sourceY * width + sourceXStart;
        const sourceIndexEnd = sourceY * width + sourceXEnd;
        let targetIndex = (sourceY + offset.y) * width + sourceXStart + offset.x;
        for (; sourceIndex < sourceIndexEnd; sourceIndex += 1, targetIndex += 1) {
          if (
            minimumSurfaceElevations[sourceIndex] >=
            terrainElevations[targetIndex] + requiredElevation
          ) {
            certainMask[targetIndex] = 1;
          }
        }
      }
    }
  } else {
    for (const offset of offsets) {
      const requiredRelativeHeight = OBSERVER_HEIGHT_METRES + offset.distanceMetres * tangent;
      const sourceXStart = Math.max(0, -offset.x);
      const sourceXEnd = Math.min(width, width - offset.x);
      const sourceYStart = Math.max(0, -offset.y);
      const sourceYEnd = Math.min(height, height - offset.y);

      for (let sourceY = sourceYStart; sourceY < sourceYEnd; sourceY += 1) {
        let sourceIndex = sourceY * width + sourceXStart;
        let targetIndex = (sourceY + offset.y) * width + sourceXStart + offset.x;
        for (let sourceX = sourceXStart; sourceX < sourceXEnd; sourceX += 1) {
          // Certain shade cannot be weakened by a later cast. Possible shade can
          // still be upgraded to certain, so it must continue through this pass.
          if (usePaintedTargetFastPath && certainMask[targetIndex] !== 0) {
            sourceIndex += 1;
            targetIndex += 1;
            continue;
          }

          if (!allCellsValid) {
            const sourceIsValid = validCellMask[sourceIndex] === 1;
            const targetIsValid = validCellMask[targetIndex] === 1;
            if (!targetIsValid) {
              unknownMask[targetIndex] = 1;
              sourceIndex += 1;
              targetIndex += 1;
              continue;
            }
            if (!sourceIsValid) {
              // Missing sunward height data can hide an occluder, so an otherwise
              // unconfirmed target remains unknown rather than becoming clear.
              unknownMask[targetIndex] = 1;
              sourceIndex += 1;
              targetIndex += 1;
              continue;
            }
          }

          const sourceMinimumSurface = minimumSurfaceElevations?.[sourceIndex];
          const targetTerrain = terrainElevations?.[targetIndex];
          // The initial scan and validity mask already establish finite values;
          // avoid repeating Number.isFinite in this frame's hottest loop.
          const certainRayCleared = usesAbsoluteElevations
            ? sourceMinimumSurface! >=
              targetTerrain! + requiredRelativeHeight + CLEARANCE_MARGIN_METRES
            : grid.heights[sourceIndex] * heightStepMetres >=
              requiredRelativeHeight + CLEARANCE_MARGIN_METRES;
          if (certainRayCleared) {
            certainMask[targetIndex] = 1;
            possibleMask[targetIndex] = 1;
          } else if (!rayWasSearchLimited) {
            const sourceSurface = maximumSurfaceElevations?.[sourceIndex];
            const possibleRayCleared = usesAbsoluteElevations
              ? sourceSurface! >=
                targetTerrain! + requiredRelativeHeight - CLEARANCE_MARGIN_METRES
              : grid.heights[sourceIndex] * heightStepMetres >=
                requiredRelativeHeight - CLEARANCE_MARGIN_METRES;
            if (possibleRayCleared) possibleMask[targetIndex] = 1;
          }
          sourceIndex += 1;
          targetIndex += 1;
        }
      }
    }
  }

  // A ray that reaches the height-pack edge before its natural bound is
  // unresolved. This O(cells) pass avoids a second O(cells × offsets) scan.
  if (naturalMaximumDistance > 0) {
    const azimuthRadians = (azimuthDeg * Math.PI) / 180;
    const sunwardX = Math.sin(azimuthRadians);
    const sunwardY = -Math.cos(azimuthRadians);
    const requiredCoveredDistance = Math.min(
      naturalMaximumDistance,
      MAXIMUM_CAST_DISTANCE_METRES,
    );
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (certainMask[index] || !validCellMask[index]) continue;
        if (
          distanceToGridEdgeMetres(
            x,
            y,
            width,
            height,
            sunwardX,
            sunwardY,
            resolutionMetres,
          ) < requiredCoveredDistance
        ) {
          unknownMask[index] = 1;
        }
      }
    }
  }

  const channels = new Uint8Array(cellCount);
  let certainCellCount = 0;
  let possibleCellCount = 0;
  let unknownCellCount = 0;
  let searchLimitedCellCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    if (certainMask[index]) {
      channels[index] = GROUND_SHADOW_CHANNEL.certain;
      certainCellCount += 1;
    } else if (unknownMask[index]) {
      channels[index] = GROUND_SHADOW_CHANNEL.unknown;
      unknownCellCount += 1;
    } else if (rayWasSearchLimited) {
      channels[index] = GROUND_SHADOW_CHANNEL.searchLimited;
      searchLimitedCellCount += 1;
    } else if (possibleMask[index]) {
      channels[index] = GROUND_SHADOW_CHANNEL.possible;
      possibleCellCount += 1;
    }
  }

  return {
    width,
    height,
    pixels: paintChannels(channels, width),
    isDaylight: true,
    azimuthDeg,
    altitudeDeg,
    lowSun,
    shadowPercent: percent(certainCellCount + possibleCellCount, cellCount),
    certainShadowPercent: percent(certainCellCount, cellCount),
    possibleShadowPercent: percent(possibleCellCount, cellCount),
    unknownPercent: percent(unknownCellCount, cellCount),
    searchLimitedPercent: percent(searchLimitedCellCount, cellCount),
    raySearchLimitMetres: MAXIMUM_CAST_DISTANCE_METRES,
    lowSunThresholdDegrees: LOW_SUN_ALTITUDE_DEGREES,
  };
}
