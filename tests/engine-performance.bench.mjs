import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  prepareRouteGeometry,
  scoreRouteSchedule,
} from "../lib/raster-shade.ts";
import { createScoringGridInitialisation } from "../lib/scoring-worker-protocol.ts";
import { renderGroundShadowFrame } from "../lib/shadow-raster.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const areaId = process.env.BENCH_AREA ?? "kings-cross";
const iterations = Math.max(1, Number.parseInt(process.env.BENCH_ITERATIONS ?? "25", 10));
const warmups = Math.max(0, Number.parseInt(process.env.BENCH_WARMUPS ?? "5", 10));

function readArrayBuffer(file) {
  const buffer = fs.readFileSync(file);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function loadGrid(id) {
  const metadata = JSON.parse(
    fs.readFileSync(path.join(root, "public", "data", `${id}-heights.json`), "utf8"),
  );
  const resolveDataFile = (name) => path.join(root, "public", "data", name);
  return {
    metadata,
    heights: new Uint8Array(readArrayBuffer(resolveDataFile(`${id}-heights.bin`))),
    validity: metadata.validityFile
      ? new Uint8Array(readArrayBuffer(resolveDataFile(metadata.validityFile)))
      : undefined,
    terrainElevations: metadata.terrainFile
      ? new Float32Array(readArrayBuffer(resolveDataFile(metadata.terrainFile)))
      : undefined,
    minimumSurfaceElevations: metadata.minimumSurfaceFile
      ? new Float32Array(readArrayBuffer(resolveDataFile(metadata.minimumSurfaceFile)))
      : undefined,
    maximumSurfaceElevations: metadata.maximumSurfaceFile
      ? new Float32Array(readArrayBuffer(resolveDataFile(metadata.maximumSurfaceFile)))
      : undefined,
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function measure(name, run) {
  let checksum = 0;
  for (let index = 0; index < warmups; index += 1) checksum += run();

  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    checksum += run();
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  return {
    name,
    iterations,
    medianMs: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    minMs: Number(durations[0].toFixed(3)),
    maxMs: Number(durations.at(-1).toFixed(3)),
    checksum: Number(checksum.toFixed(3)),
  };
}

const grid = loadGrid(areaId);
const pilots = JSON.parse(
  fs.readFileSync(path.join(root, "public", "data", "pilot-routes.json"), "utf8"),
);
const area = pilots.areas.find((candidate) => candidate.id === areaId);
if (!area) throw new Error(`Pilot routes are unavailable for ${areaId}.`);
const routes = area.routes;
const preparedRoutes = routes.map((route) => prepareRouteGeometry(route));
const centre = /** @type {[number, number]} */ ([
  (area.start.lon + area.destination.lon) / 2,
  (area.start.lat + area.destination.lat) / 2,
]);
const shadowDate = new Date("2026-06-21T05:00:00.000Z");
const scoringStart = new Date("2026-06-21T07:00:00.000Z");
const scheduledJourneys = 8;
const repeatEveryMinutes = 15;

const referenceShadow = measure("reference-ground-shadow-frame", () => {
  const frame = renderGroundShadowFrame(grid, shadowDate, centre, {
    skipPaintedTargetFastPath: false,
    searchLimitedAbsoluteFastPath: false,
  });
  return frame.shadowPercent + frame.pixels.byteLength;
});
const optimisedShadow = measure("optimised-ground-shadow-frame", () => {
    const frame = renderGroundShadowFrame(grid, shadowDate, centre);
    return frame.shadowPercent + frame.pixels.byteLength;
});
const results = [
  referenceShadow,
  optimisedShadow,
  measure("nine-time-three-route-eight-journey-score-sweep", () => {
    let checksum = 0;
    for (let slot = 0; slot < 9; slot += 1) {
      const departure = new Date(scoringStart.getTime() + slot * 15 * 60_000);
      for (const route of routes) {
        const score = scoreRouteSchedule(
          route,
          grid,
          departure,
          scheduledJourneys,
          repeatEveryMinutes,
        );
        checksum += score.estimatedDirectSunSeconds + score.coveragePercent;
      }
    }
    return checksum;
  }),
  measure("scoring-grid-transfer-copy", () => {
    const initialisation = createScoringGridInitialisation(1, areaId, grid);
    return initialisation.transfer.reduce((bytes, buffer) => bytes + buffer.byteLength, 0);
  }),
];
const verificationFrame = renderGroundShadowFrame(grid, shadowDate, centre);

console.log(
  JSON.stringify(
    {
      node: process.version,
      areaId,
      gridCells: grid.metadata.width * grid.metadata.height,
      gridPlanes: 2 + Number(Boolean(grid.terrainElevations)) * 3,
      routes: routes.length,
      routeSamples: preparedRoutes.map((route) => route.samples.length),
      shadowDate: shadowDate.toISOString(),
      scoringSlots: 9,
      scheduledJourneys,
      repeatEveryMinutes,
      shadowVerification: {
        shadowPercent: verificationFrame.shadowPercent,
        pixelHash: fnv1a(verificationFrame.pixels),
      },
      optimisation: {
        medianReductionPercent: Number(
          (((referenceShadow.medianMs - optimisedShadow.medianMs) /
            referenceShadow.medianMs) *
            100).toFixed(1),
        ),
      },
      results,
    },
    null,
    2,
  ),
);
