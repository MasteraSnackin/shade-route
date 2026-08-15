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

function channelAt(frame, x, y) {
  const index = (y * frame.width + x) * 4;
  const red = frame.pixels[index];
  if (red === 55) return "certain";
  if (red === 106) return "possible";
  if (red === 89) return "unknown";
  if (red === 150) return "search-limited";
  return red === 42 ? "night" : "clear";
}

function isModelledShadow(frame, x, y) {
  return ["certain", "possible"].includes(channelAt(frame, x, y));
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
  assert.equal(isModelledShadow(morning, centre - 1, centre), true, "morning shadow should extend west");
  assert.equal(isModelledShadow(morning, centre + 1, centre), false);
  assert.ok(evening.azimuthDeg > 225 && evening.azimuthDeg < 315);
  assert.equal(isModelledShadow(evening, centre + 1, centre), true, "evening shadow should extend east");
  assert.equal(isModelledShadow(evening, centre - 1, centre), false);
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
  const reference = renderGroundShadowFrame(combinedGrid, SUMMER_NOON, LONDON, {
    skipPaintedTargetFastPath: false,
  });
  let unionCellCount = 0;

  assert.deepEqual(combined.pixels, reference.pixels);
  assert.equal(combined.shadowPercent, reference.shadowPercent);

  for (let y = 0; y < combined.height; y += 1) {
    for (let x = 0; x < combined.width; x += 1) {
      const expectedShadow = isModelledShadow(first, x, y) || isModelledShadow(second, x, y);
      assert.equal(isModelledShadow(combined, x, y), expectedShadow);
      if (expectedShadow) unionCellCount += 1;
    }
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
  assert.equal(frame.lowSun, true);
  assert.equal(frame.lowSunThresholdDegrees, 3);
  assert.equal(frame.raySearchLimitMetres, 250);

  let furthestDistance = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      if (!isModelledShadow(frame, x, y)) continue;
      furthestDistance = Math.max(
        furthestDistance,
        Math.hypot(x - centre, y - centre) * resolutionMetres,
      );
    }
  }
  assert.ok(furthestDistance > 225, `expected a long low-sun cast, received ${furthestDistance}m`);
  assert.ok(furthestDistance <= 250, `cast exceeded 250m: ${furthestDistance}m`);
  assert.ok(frame.searchLimitedPercent > 0);
});

test("search-limited absolute fast path matches the generic reference path", () => {
  const resolutionMetres = 5;
  const grid = makeGrid(121, 121, resolutionMetres);
  const cellCount = grid.heights.length;
  const centre = 60;
  const sourceIndex = centre * grid.metadata.width + centre;
  grid.validity = new Uint8Array(cellCount).fill(255);
  grid.terrainElevations = new Float32Array(cellCount);
  grid.minimumSurfaceElevations = new Float32Array(cellCount);
  grid.maximumSurfaceElevations = new Float32Array(cellCount);
  grid.heights[sourceIndex] = 255;
  grid.minimumSurfaceElevations[sourceIndex] = 255;
  grid.maximumSurfaceElevations[sourceIndex] = 255;
  const date = new Date("2026-06-21T04:00:00.000Z");

  const production = renderGroundShadowFrame(grid, date, LONDON);
  const reference = renderGroundShadowFrame(grid, date, LONDON, {
    skipPaintedTargetFastPath: false,
    searchLimitedAbsoluteFastPath: false,
  });

  assert.ok(production.searchLimitedPercent > 0);
  assert.deepEqual(production.pixels, reference.pixels);
  assert.equal(production.shadowPercent, reference.shadowPercent);
  assert.equal(production.certainShadowPercent, reference.certainShadowPercent);
  assert.equal(production.possibleShadowPercent, reference.possibleShadowPercent);
  assert.equal(production.unknownPercent, reference.unknownPercent);
  assert.equal(production.searchLimitedPercent, reference.searchLimitedPercent);
});

test("absolute min/max surfaces separate certain from possible shadow", () => {
  const grid = makeGrid(41, 41, 2);
  const cellCount = grid.heights.length;
  grid.validity = new Uint8Array(cellCount).fill(255);
  grid.terrainElevations = new Float32Array(cellCount);
  grid.minimumSurfaceElevations = new Float32Array(cellCount);
  grid.maximumSurfaceElevations = new Float32Array(cellCount);
  const centre = 20;
  const sourceIndex = centre * grid.metadata.width + centre;
  grid.heights[sourceIndex] = 10;
  grid.minimumSurfaceElevations[sourceIndex] = 5;
  grid.maximumSurfaceElevations[sourceIndex] = 10;

  const envelopeFrame = renderGroundShadowFrame(grid, SUMMER_NOON, LONDON);
  assert.equal(channelAt(envelopeFrame, centre, centre - 1), "possible");
  assert.ok(envelopeFrame.possibleShadowPercent > 0);
  const possibleAlphas = new Set();
  for (let index = 0; index < envelopeFrame.pixels.length; index += 4) {
    if (envelopeFrame.pixels[index] === 106) {
      possibleAlphas.add(envelopeFrame.pixels[index + 3]);
    }
  }
  assert.ok(possibleAlphas.size > 1, "possible shade should use a non-colour-only texture");

  grid.minimumSurfaceElevations[sourceIndex] = 10;
  const certainFrame = renderGroundShadowFrame(grid, SUMMER_NOON, LONDON);
  assert.equal(channelAt(certainFrame, centre, centre - 1), "certain");
  assert.ok(certainFrame.certainShadowPercent > envelopeFrame.certainShadowPercent);
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

test("invalid height cells use the unknown channel rather than modelled shadow", () => {
  const grid = makeGrid(61, 61, 5);
  grid.validity = new Uint8Array(grid.heights.length).fill(255);
  const invalidIndex = Math.floor(grid.heights.length / 2);
  grid.validity[invalidIndex] = 254;
  const frame = renderGroundShadowFrame(grid, SUMMER_NOON, LONDON);
  const invalidX = invalidIndex % grid.metadata.width;
  const invalidY = Math.floor(invalidIndex / grid.metadata.width);
  assert.equal(channelAt(frame, invalidX, invalidY), "unknown");
  assert.equal(
    channelAt(frame, invalidX, invalidY - 5),
    "unknown",
    "an incomplete sunward height cell must make the down-sun target unknown",
  );
  assert.ok(frame.unknownPercent > 0);
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
