import assert from "node:assert/strict";
import test from "node:test";
import * as SunCalc from "suncalc";

import {
  assessPointExposure,
  longitudeLatitudeToBng,
} from "../lib/raster-shade.ts";

const LONDON = /** @type {[number, number]} */ ([-0.12, 51.505]);
const SUMMER_NOON = new Date("2026-06-21T12:00:00.000Z");

function makeGrid() {
  const resolutionMetres = 2;
  const width = 201;
  const [centreEasting, centreNorthing] = longitudeLatitudeToBng(LONDON);
  const halfSize = (width * resolutionMetres) / 2;
  const cellCount = width * width;
  return {
    metadata: {
      id: "absolute-elevation-test",
      width,
      height: width,
      bboxBng: [
        centreEasting - halfSize,
        centreNorthing - halfSize,
        centreEasting + halfSize,
        centreNorthing + halfSize,
      ],
      resolutionMetres,
      heightStepMetres: 1,
      coveragePercent: 100,
      maximumSurfaceElevationMetres: 100,
      source: "synthetic",
      sourceDate: "test",
      processed: "test",
    },
    heights: new Uint8Array(cellCount),
    validity: new Uint8Array(cellCount).fill(255),
    terrainElevations: new Float32Array(cellCount).fill(100),
    minimumSurfaceElevations: new Float32Array(cellCount).fill(100),
    maximumSurfaceElevations: new Float32Array(cellCount).fill(100),
  };
}

function indexAt(grid, easting, northing) {
  const [west, , , north] = grid.metadata.bboxBng;
  const x = Math.floor((easting - west) / grid.metadata.resolutionMetres);
  const y = Math.floor((north - northing) / grid.metadata.resolutionMetres);
  return y * grid.metadata.width + x;
}

function sunwardPoint(distanceMetres) {
  const position = SunCalc.getPosition(SUMMER_NOON, LONDON[1], LONDON[0]);
  const azimuth = (position.azimuth * Math.PI) / 180;
  const [easting, northing] = longitudeLatitudeToBng(LONDON);
  return [
    easting + Math.sin(azimuth) * distanceMetres,
    northing + Math.cos(azimuth) * distanceMetres,
  ];
}

test("absolute elevations stop a lower obstacle being treated as shade on higher ground", () => {
  const grid = makeGrid();
  const obstacleIndex = indexAt(grid, ...sunwardPoint(10));
  grid.heights[obstacleIndex] = 80;

  const absolute = assessPointExposure(LONDON, SUMMER_NOON, grid);
  assert.equal(absolute.exposure, "sun");

  const legacy = {
    metadata: { ...grid.metadata, maximumSurfaceElevationMetres: undefined },
    heights: grid.heights,
    validity: grid.validity,
  };
  assert.equal(assessPointExposure(LONDON, SUMMER_NOON, legacy).exposure, "shade");
});
test("a mixed 1m surface envelope remains uncertain after 4m aggregation", () => {
  const grid = makeGrid();
  const obstacleIndex = indexAt(grid, ...sunwardPoint(10));
  grid.maximumSurfaceElevations[obstacleIndex] = 180;
  grid.metadata.maximumSurfaceElevationMetres = 180;

  const assessment = assessPointExposure(LONDON, SUMMER_NOON, grid);
  assert.equal(assessment.exposure, "uncertain");
  assert.equal(assessment.guaranteedShade, false);
  assert.equal(assessment.possibleShade, true);
  assert.ok(assessment.confidenceReasons.includes("subcell-surface-variation"));
});
