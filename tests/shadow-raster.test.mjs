import assert from "node:assert/strict";
import test from "node:test";

import { longitudeLatitudeToBng } from "../lib/raster-shade.ts";
import {
  heightGridCanvasCoordinates,
  renderGroundShadowFrame,
} from "../lib/shadow-raster.ts";

const LONDON = /** @type {[number, number]} */ ([-0.12, 51.505]);
const SUMMER_NOON = new Date("2026-06-21T12:00:00.000Z");

function makeGrid(width = 41, height = width, resolutionMetres = 10) {
  const [centreEasting, centreNorthing] = longitudeLatitudeToBng(LONDON);
  const halfWidth = (width * resolutionMetres) / 2;
  const halfHeight = (height * resolutionMetres) / 2;
  return {
    metadata: {
      id: "shadow-test",
      width,
      height,
      bboxBng: [
        centreEasting - halfWidth,
        centreNorthing - halfHeight,
        centreEasting + halfWidth,
        centreNorthing + halfHeight,
      ],
      resolutionMetres,
      heightStepMetres: 1,
      coveragePercent: 100,
      source: "synthetic",
      sourceDate: "test",
      processed: "test",
    },
    heights: new Uint8Array(width * height),
  };
}

function alphaAt(frame, x, y) {
  return frame.pixels[(y * frame.width + x) * 4 + 3];
}

function setHeight(grid, x, y, metres) {
  grid.heights[y * grid.metadata.width + x] = metres;
}

test("a southern noon sun casts the shadow north on a south-increasing grid", () => {
  const grid = makeGrid();
  const centre = Math.floor(grid.metadata.width / 2);
  setHeight(grid, centre, centre, 80);

  const frame = renderGroundShadowFrame(grid, SUMMER_NOON, LONDON);

  assert.equal(frame.isDaylight, true);
  assert.ok(frame.azimuthDeg > 170 && frame.azimuthDeg < 190);
  assert.ok(alphaAt(frame, centre, centre - 1) > 0);
  assert.equal(alphaAt(frame, centre, centre + 1), 0);
  assert.ok(frame.shadowPercent > 0 && frame.shadowPercent < 5);
});

test("morning and evening shadows fall west and east respectively", () => {
  const centre = 30;
  const morningGrid = makeGrid(61, 61, 5);
  setHeight(morningGrid, centre, centre, 80);
  const morning = renderGroundShadowFrame(
    morningGrid,
    new Date("2026-06-21T07:00:00.000Z"),
    LONDON,
  );

  const eveningGrid = makeGrid(61, 61, 5);
  setHeight(eveningGrid, centre, centre, 80);
  const evening = renderGroundShadowFrame(
    eveningGrid,
    new Date("2026-06-21T17:00:00.000Z"),
    LONDON,
  );

  assert.ok(morning.azimuthDeg > 45 && morning.azimuthDeg < 135);
  assert.ok(alphaAt(morning, centre - 1, centre) > 0, "morning shadow should extend west");
  assert.equal(alphaAt(morning, centre + 1, centre), 0);
  assert.ok(evening.azimuthDeg > 225 && evening.azimuthDeg < 315);
  assert.ok(alphaAt(evening, centre + 1, centre) > 0, "evening shadow should extend east");
  assert.equal(alphaAt(evening, centre - 1, centre), 0);
});

test("overlapping casts are the exact union of their individual masks", () => {
  const firstGrid = makeGrid(61, 61, 5);
  const secondGrid = makeGrid(61, 61, 5);
  const combinedGrid = makeGrid(61, 61, 5);
  setHeight(firstGrid, 30, 30, 80);
  setHeight(secondGrid, 30, 33, 80);
  setHeight(combinedGrid, 30, 30, 80);
  setHeight(combinedGrid, 30, 33, 80);

  const first = renderGroundShadowFrame(firstGrid, SUMMER_NOON, LONDON);
  const second = renderGroundShadowFrame(secondGrid, SUMMER_NOON, LONDON);
  const combined = renderGroundShadowFrame(combinedGrid, SUMMER_NOON, LONDON);
  let unionCellCount = 0;

  for (let index = 3; index < combined.pixels.length; index += 4) {
    const expectedAlpha = Math.max(first.pixels[index], second.pixels[index]);
    assert.equal(combined.pixels[index], expectedAlpha);
    if (expectedAlpha > 0) unionCellCount += 1;
  }
  assert.equal(
    combined.shadowPercent,
    (unionCellCount / combinedGrid.heights.length) * 100,
  );
});

test("night returns a subtle, uniform full-area tint", () => {
  const frame = renderGroundShadowFrame(
    makeGrid(7),
    new Date("2026-06-21T00:00:00.000Z"),
    LONDON,
  );

  assert.equal(frame.isDaylight, false);
  assert.ok(frame.altitudeDeg < 0);
  assert.equal(frame.shadowPercent, 100);
  assert.ok(frame.pixels[3] > 0 && frame.pixels[3] < 100);
  for (let index = 4; index < frame.pixels.length; index += 4) {
    assert.deepEqual(frame.pixels.slice(index, index + 4), frame.pixels.slice(0, 4));
  }
});

test("very low sun never casts farther than 250 metres", () => {
  const resolutionMetres = 5;
  const grid = makeGrid(121, 121, resolutionMetres);
  const centre = 60;
  setHeight(grid, centre, centre, 255);
  const frame = renderGroundShadowFrame(
    grid,
    new Date("2026-06-21T04:00:00.000Z"),
    LONDON,
  );
  assert.equal(frame.isDaylight, true);
  assert.ok(frame.altitudeDeg > 0 && frame.altitudeDeg < 10);

  let furthestDistance = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      if (alphaAt(frame, x, y) === 0) continue;
      furthestDistance = Math.max(
        furthestDistance,
        Math.hypot(x - centre, y - centre) * resolutionMetres,
      );
    }
  }
  assert.ok(furthestDistance > 225, `expected a long low-sun cast, received ${furthestDistance}m`);
  assert.ok(furthestDistance <= 250, `cast exceeded 250m: ${furthestDistance}m`);
});

test("an elevated obstacle can cast onto lower ground beyond its local-height bound", () => {
  const resolutionMetres = 2;
  const grid = makeGrid(41, 41, resolutionMetres);
  const cellCount = grid.heights.length;
  grid.validity = new Uint8Array(cellCount).fill(255);
  grid.terrainElevations = new Float32Array(cellCount);
  grid.minimumSurfaceElevations = new Float32Array(cellCount);
  grid.maximumSurfaceElevations = new Float32Array(cellCount);

  const centre = 20;
  const sourceIndex = centre * grid.metadata.width + centre;
  grid.heights[sourceIndex] = 10;
  grid.terrainElevations[sourceIndex] = 90;
  grid.minimumSurfaceElevations[sourceIndex] = 100;
  grid.maximumSurfaceElevations[sourceIndex] = 100;

  const frame = renderGroundShadowFrame(grid, SUMMER_NOON, LONDON);
  const targetY = centre - 10;

  assert.ok(
    alphaAt(frame, centre, targetY) > 0,
    "absolute surface elevation should cast twenty metres onto lower ground",
  );
});

test("invalid height cells are not painted as certain building or ground shadow", () => {
  const grid = makeGrid();
  grid.validity = new Uint8Array(grid.heights.length).fill(255);
  const invalidIndex = Math.floor(grid.heights.length / 2);
  grid.heights[invalidIndex] = 80;
  grid.validity[invalidIndex] = 254;
  const frame = renderGroundShadowFrame(grid, SUMMER_NOON, LONDON);
  assert.equal(frame.pixels[invalidIndex * 4 + 3], 0);
});

test("canvas coordinates are top-left, top-right, bottom-right, bottom-left", () => {
  const grid = makeGrid(17, 11, 4);
  const [topLeft, topRight, bottomRight, bottomLeft] = heightGridCanvasCoordinates(grid);
  const projected = [topLeft, topRight, bottomRight, bottomLeft].map((coordinate) =>
    longitudeLatitudeToBng(coordinate),
  );
  const [west, south, east, north] = grid.metadata.bboxBng;
  const expected = [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];

  projected.forEach((coordinate, index) => {
    assert.ok(Math.abs(coordinate[0] - expected[index][0]) < 0.05);
    assert.ok(Math.abs(coordinate[1] - expected[index][1]) < 0.05);
  });
});
