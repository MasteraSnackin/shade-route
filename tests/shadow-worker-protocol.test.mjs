import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createLatestShadowRenderQueue,
  createShadowGridInitialisation,
  createShadowRenderRequest,
  createShadowRenderSuccess,
  groundShadowFrameFromResponse,
  isShadowRenderResponse,
  isShadowRenderResponseForGeneration,
  SHADOW_RENDER_SUCCESS,
} from "../lib/shadow-worker-protocol.ts";

function makeGrid() {
  return {
    metadata: {
      id: "worker-test",
      width: 2,
      height: 2,
      bboxBng: [530000, 178000, 530002, 178002],
      resolutionMetres: 1,
      heightStepMetres: 1,
      coveragePercent: 100,
      source: "synthetic",
      sourceDate: "test",
      processed: "test",
    },
    heights: new Uint8Array([1, 2, 3, 4]),
    validity: new Uint8Array([255, 255, 254, 255]),
  };
}

test("grid initialisation transfer leaves the cached height grid attached", () => {
  const grid = makeGrid();
  const { message, transfer } = createShadowGridInitialisation(7, grid);

  assert.notEqual(message.grid.heights, grid.heights.buffer);
  assert.notEqual(message.grid.validity, grid.validity.buffer);
  const received = structuredClone(message, { transfer });

  assert.equal(message.grid.heights.byteLength, 0, "the copied request buffer was transferred");
  assert.equal(message.grid.validity.byteLength, 0, "the copied validity buffer was transferred");
  assert.deepEqual([...grid.heights], [1, 2, 3, 4], "the shared cache remains usable");
  assert.deepEqual([...grid.validity], [255, 255, 254, 255]);
  assert.deepEqual([...new Uint8Array(received.grid.heights)], [1, 2, 3, 4]);
  assert.deepEqual([...new Uint8Array(received.grid.validity)], [255, 255, 254, 255]);
  assert.equal(received.gridVersion, 7);
});

test("per-frame render requests contain no grid buffers or transfer list", () => {
  const request = createShadowRenderRequest(
    12,
    7,
    new Date("2026-06-21T12:00:00.000Z"),
    [-0.12, 51.505],
  );

  assert.equal(request.generation, 12);
  assert.equal(request.gridVersion, 7);
  assert.equal("grid" in request, false);
  assert.equal("transfer" in request, false);
});

test("rapid render requests coalesce to the latest generation", () => {
  const scheduled = [];
  const rendered = [];
  const queue = createLatestShadowRenderQueue(
    (request) => rendered.push(request.generation),
    (flush) => scheduled.push(flush),
  );
  const makeRequest = (generation) => createShadowRenderRequest(
    generation,
    3,
    new Date("2026-06-21T12:00:00.000Z"),
    [-0.12, 51.505],
  );

  queue.enqueue(makeRequest(1));
  queue.enqueue(makeRequest(2));
  queue.enqueue(makeRequest(3));

  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.deepEqual(rendered, [3]);
});

test("a grid update clears a queued render without scheduling duplicate work", () => {
  const scheduled = [];
  const rendered = [];
  const queue = createLatestShadowRenderQueue(
    (request) => rendered.push(request.generation),
    (flush) => scheduled.push(flush),
  );
  const first = createShadowRenderRequest(1, 1, new Date(0), [-0.12, 51.505]);
  const updated = createShadowRenderRequest(2, 2, new Date(1), [-0.12, 51.505]);

  queue.enqueue(first);
  queue.clear();
  queue.enqueue(updated);

  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.deepEqual(rendered, [2]);
});

test("response pixels can be transferred and reconstructed without copying", () => {
  const frame = {
    width: 2,
    height: 1,
    pixels: new Uint8ClampedArray([55, 70, 82, 104, 0, 0, 0, 0]),
    isDaylight: true,
    azimuthDeg: 180,
    altitudeDeg: 61.5,
    lowSun: false,
    shadowPercent: 50,
    certainShadowPercent: 50,
    possibleShadowPercent: 0,
    unknownPercent: 0,
    searchLimitedPercent: 0,
    raySearchLimitMetres: 250,
    lowSunThresholdDegrees: 3,
  };
  const { message, transfer } = createShadowRenderSuccess(11, frame);
  const received = structuredClone(message, { transfer });

  assert.equal(message.frame.pixels.byteLength, 0);
  assert.equal(isShadowRenderResponse(received), true);
  assert.equal(isShadowRenderResponseForGeneration(received, 11), true);
  assert.equal(isShadowRenderResponseForGeneration(received, 10), false);
  assert.equal(received.type, SHADOW_RENDER_SUCCESS);
  const reconstructed = groundShadowFrameFromResponse(received);
  assert.deepEqual([...reconstructed.pixels], [55, 70, 82, 104, 0, 0, 0, 0]);
  assert.equal(reconstructed.altitudeDeg, 61.5);
  assert.equal(reconstructed.certainShadowPercent, 50);
  assert.equal(reconstructed.raySearchLimitMetres, 250);
});

test("response validation rejects malformed or stale-looking payloads", () => {
  assert.equal(isShadowRenderResponse(null), false);
  assert.equal(isShadowRenderResponse({ type: SHADOW_RENDER_SUCCESS, generation: 1 }), false);
  assert.equal(isShadowRenderResponse({ type: SHADOW_RENDER_SUCCESS, generation: 1.5 }), false);
});

test("the map conceals stale frames and keeps a generation-bound fallback", async () => {
  const source = await readFile(
    new URL("../components/RouteMap.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /shadow-worker\.ts\?worker&url/);
  assert.match(source, /new Worker\(shadowWorkerUrl/);
  assert.match(source, /maplibre-gl-worker\.mjs\?worker&url/);
  assert.match(source, /maplibregl\.setWorkerUrl\(mapLibreWorkerUrl\)/);
  assert.match(source, /type: "module"/);
  assert.match(source, /createShadowGridInitialisation\(version, grid\)/);
  assert.match(source, /workerInstance\.postMessage\(initialisation\.message, initialisation\.transfer\)/);
  assert.match(source, /workerInstance\.postMessage\(message\)/);
  assert.match(source, /renderGroundShadowFrame\(grid, departureDate, centre\)/);
  assert.match(source, /applyShadowFrame\(grid, frame, "fallback"\)/);
  assert.match(source, /if \(typeof Worker === "undefined"\) \{\s*renderFallback\(\)/);
  assert.match(source, /\(\) => failWorker\("worker-timeout"\)/);
  assert.match(source, /useLayoutEffect/);
  assert.match(source, /concealGroundShadowOverlay\(map\)/);
  assert.match(source, /phase: "loading"/);
  assert.match(source, /markUnavailable\("height-data"\)/);
  assert.match(source, /markUnavailable\("render"\)/);
  assert.match(source, /renderMode: "worker" \| "fallback"/);
  assert.match(source, /rendered on this device without the background worker/);
  assert.match(source, /aria-busy/);
  assert.match(source, /!mapFailure &&\s*departureDate/);
  assert.match(source, /The previous overlay is hidden/);
  assert.match(source, /SHADOW_WORKER_TIMEOUT_MS/);
  assert.match(source, /The local 3D map did not finish loading/);
  assert.match(source, /shadowGenerationRef\.current !== generation/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /role="region"/);
  assert.doesNotMatch(source, /role="application"/);
  assert.match(source, /Sun \$\{sunDirection/);
  assert.match(source, /Model warning:/);
  assert.match(source, /rays stop at \$\{status\.raySearchLimitMetres\} m/);
  assert.match(source, /ground-shadow-key/);
  assert.match(source, /GROUND_SHADOW_LEGEND\.map/);
});
