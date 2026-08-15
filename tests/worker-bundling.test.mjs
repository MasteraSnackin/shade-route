import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const clientRoot = fileURLToPath(new URL("../dist/client/", import.meta.url));
const chunksRoot = join(clientRoot, "_next/static/chunks");

test("production emits same-origin MapLibre, shadow and scoring workers", async () => {
  const appChunkName = (await readdir(chunksRoot)).find(
    (name) => name.startsWith("ShadeRouteApp-") && name.endsWith(".js"),
  );
  assert.ok(appChunkName, "the production client must contain the ShadeRoute application chunk");

  const appChunk = await readFile(join(chunksRoot, appChunkName), "utf8");
  assert.doesNotMatch(appChunk, /file:\/\/\/ROOT/);

  const workerPaths = [...appChunk.matchAll(/\/_next\/static\/[A-Za-z0-9._-]*worker[A-Za-z0-9._-]*\.js/g)]
    .map(([path]) => path);
  for (const expected of ["maplibre-gl-worker", "shadow-worker", "scoring-worker"]) {
    const workerPath = workerPaths.find((path) => path.includes(expected));
    assert.ok(workerPath, `the app chunk must reference the emitted ${expected}`);
    const workerFile = join(clientRoot, workerPath.replace(/^\//, ""));
    assert.ok((await stat(workerFile)).size > 1_000, `${expected} must be a non-empty build asset`);
  }

  const mapLibrePath = workerPaths.find((path) => path.includes("maplibre-gl-worker"));
  const mapLibreWorker = await readFile(
    join(clientRoot, mapLibrePath.replace(/^\//, "")),
    "utf8",
  );
  assert.match(mapLibreWorker, /MapLibre GL JS/);
});
