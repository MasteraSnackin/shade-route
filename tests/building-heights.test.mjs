import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  estimateRasterBuildingHeight,
  parseExplicitHeightMetres,
  resolveBuildingHeight,
} from "../scripts/prepare-data.mjs";

const footprint = [
  [0.1, 4.1],
  [11.9, 4.1],
  [11.9, 7.9],
  [0.1, 7.9],
  [0.1, 4.1],
];

function makeGrid(values) {
  return {
    width: 3,
    height: 3,
    bboxBng: [0, 0, 12, 12],
    resolutionMetres: 4,
    heightStepMetres: 0.5,
    values: Uint8Array.from(values),
  };
}

test("OSM height parsing is strict, unit-aware and bounded", () => {
  assert.equal(parseExplicitHeightMetres("155 m"), 155);
  assert.equal(parseExplicitHeightMetres("40 ft"), 12.19);
  assert.equal(parseExplicitHeightMetres("12' 6\""), 3.81);
  assert.equal(parseExplicitHeightMetres("12;14"), null);
  assert.equal(parseExplicitHeightMetres("unknown"), null);
  assert.equal(parseExplicitHeightMetres(0), null);
  assert.equal(parseExplicitHeightMetres("0 ft"), null);
  assert.equal(parseExplicitHeightMetres(1_001), null);
});

test("building heights prefer OSM height, then levels, then a bounded raster median", () => {
  const grid = makeGrid([
    0, 0, 0,
    16, 24, 200,
    0, 0, 0,
  ]);

  assert.deepEqual(resolveBuildingHeight({ height: "18", "building:levels": "9" }, footprint, grid), {
    heightMetres: 18,
    source: "explicit",
  });
  assert.deepEqual(resolveBuildingHeight({ height: "invalid", "building:levels": "4" }, footprint, grid), {
    heightMetres: 12,
    source: "levels",
  });
  assert.deepEqual(resolveBuildingHeight({}, footprint, grid), {
    heightMetres: 12,
    source: "raster",
  });
  assert.equal(estimateRasterBuildingHeight(footprint, makeGrid(new Array(9).fill(255))), 120);
  assert.deepEqual(resolveBuildingHeight({}, footprint, makeGrid(new Array(9).fill(0))), {
    heightMetres: 12,
    source: "fallback",
  });
});

for (const area of ["waterloo", "kings-cross"]) {
  test(`${area} map is compact and every building has a finite numeric height`, async () => {
    const raw = await fs.readFile(new URL(`../public/data/${area}-map.json`, import.meta.url), "utf8");
    const map = JSON.parse(raw);
    assert.equal(raw, JSON.stringify(map));
    const buildings = map.features.filter((feature) => feature.properties.kind === "building");
    assert.ok(buildings.length > 0);
    assert.ok(buildings.every((feature) =>
      typeof feature.properties.heightMetres === "number" &&
      Number.isFinite(feature.properties.heightMetres) &&
      feature.properties.heightMetres > 0,
    ));
  });
}
