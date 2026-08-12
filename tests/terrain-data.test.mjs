import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const areaId of ["waterloo", "kings-cross"]) {
  test(`${areaId} pack retains absolute terrain and a source-resolution surface envelope`, async () => {
    const metadata = JSON.parse(await readFile(
      new URL(`../public/data/${areaId}-heights.json`, import.meta.url),
      "utf8",
    ));
    const [terrain, minimumSurface, maximumSurface, validity] = await Promise.all([
      readFile(new URL(`../public/data/${metadata.terrainFile}`, import.meta.url)),
      readFile(new URL(`../public/data/${metadata.minimumSurfaceFile}`, import.meta.url)),
      readFile(new URL(`../public/data/${metadata.maximumSurfaceFile}`, import.meta.url)),
      readFile(new URL(`../public/data/${metadata.validityFile}`, import.meta.url)),
    ]);

    const cellCount = metadata.width * metadata.height;
    assert.equal(metadata.elevationEncoding, "float32-le");
    assert.match(metadata.elevationAggregation, /DTM range.+minimum and maximum 1m DSM envelope/i);
    assert.equal(terrain.byteLength, cellCount * 4);
    assert.equal(minimumSurface.byteLength, cellCount * 4);
    assert.equal(maximumSurface.byteLength, cellCount * 4);
    assert.equal(validity.byteLength, cellCount);
    assert.ok(metadata.maximumTerrainElevationMetres > metadata.minimumTerrainElevationMetres);
    assert.ok(metadata.maximumSurfaceElevationMetres > 127.5);
    assert.ok(metadata.clippedLegacyHeightCells > 0);

    let checked = 0;
    for (let index = 0; index < cellCount && checked < 100; index += 1) {
      if (validity[index] !== 255) continue;
      const offset = index * 4;
      const ground = terrain.readFloatLE(offset);
      const low = minimumSurface.readFloatLE(offset);
      const high = maximumSurface.readFloatLE(offset);
      assert.ok(Number.isFinite(ground));
      assert.ok(Number.isFinite(low));
      assert.ok(Number.isFinite(high));
      assert.ok(low <= high);
      checked += 1;
    }
    assert.equal(checked, 100);
  });
}
