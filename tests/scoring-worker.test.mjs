import assert from "node:assert/strict";
import test from "node:test";

import { RouteScoringClient, RouteScoringCancelledError } from "../lib/route-scoring-client.ts";
import {
  createLatestScoringRequestQueue,
  createScheduleScoreRequest,
  createScoringGridInitialisation,
  heightGridFromInitialisation,
  SCORING_CANCEL_REQUEST,
  SCORING_GRID_INITIALISE,
  SCHEDULE_SCORE_REQUEST,
  SCHEDULE_SCORE_SUCCESS,
} from "../lib/scoring-worker-protocol.ts";

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
    terrainElevations: new Float32Array([4.5, 5.5, 6.5, 7.5]),
    minimumSurfaceElevations: new Float32Array([4.5, 8, 7, 9]),
    maximumSurfaceElevations: new Float32Array([5, 9, 8, 10]),
  };
}

function baseInput(grid = makeGrid()) {
  return {
    areaId: "test-area",
    grid,
    routes: [],
    departure: new Date("2026-06-21T12:00:00.000Z"),
    profile: "vulnerable",
    journeyCount: 1,
    repeatEveryMinutes: 120,
  };
}

test("grid initialisation transfers one copy of every raster without detaching the cache", () => {
  const grid = makeGrid();
  const { message, transfer } = createScoringGridInitialisation(4, "test-area", grid);
  const received = structuredClone(message, { transfer });

  assert.equal(message.type, SCORING_GRID_INITIALISE);
  assert.equal(transfer.length, 5);
  assert.equal(message.grid.heights.byteLength, 0);
  assert.equal(message.grid.terrainElevations.byteLength, 0);
  assert.deepEqual([...grid.heights], [1, 2, 3, 4]);
  assert.deepEqual([...grid.terrainElevations], [4.5, 5.5, 6.5, 7.5]);

  const reconstructed = heightGridFromInitialisation(received);
  assert.deepEqual([...reconstructed.heights], [1, 2, 3, 4]);
  assert.deepEqual([...reconstructed.terrainElevations], [4.5, 5.5, 6.5, 7.5]);
  assert.deepEqual([...reconstructed.maximumSurfaceElevations], [5, 9, 8, 10]);
});

test("calculation requests contain no raster buffers", () => {
  const request = createScheduleScoreRequest(8, 4, {
    routes: [],
    departureEpochMs: Date.parse("2026-06-21T12:00:00.000Z"),
    profile: "worker",
    journeyCount: 5,
    repeatEveryMinutes: 30,
    walkingPace: "slow",
  });
  assert.equal(request.type, SCHEDULE_SCORE_REQUEST);
  assert.equal(request.generation, 8);
  assert.equal(request.walkingPace, "slow");
  assert.equal("grid" in request, false);
});

test("the worker queue retains the latest request per result stream", () => {
  const scheduled = [];
  const run = [];
  const queue = createLatestScoringRequestQueue(
    (request) => run.push(`${request.task}:${request.generation}`),
    (flush) => scheduled.push(flush),
  );
  const score = (generation) => createScheduleScoreRequest(generation, 1, {
    routes: [],
    departureEpochMs: 0,
    profile: "vulnerable",
    journeyCount: 1,
    repeatEveryMinutes: 0,
  });
  const advice = {
    ...score(2),
    type: "build-departure-advice",
    task: "advice",
  };

  queue.enqueue(score(1));
  queue.enqueue(advice);
  queue.enqueue(score(3));
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.deepEqual(run, ["advice:2"]);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.deepEqual(run, ["advice:2", "scores:3"]);
});

test("the client falls back safely when Worker construction is unavailable", async () => {
  const client = new RouteScoringClient(() => {
    throw new Error("Worker unavailable");
  });
  await assert.doesNotReject(async () => {
    assert.deepEqual(await client.scoreRoutes(baseInput()), []);
    const advice = await client.buildDepartureAdvice(baseInput());
    assert.equal(advice.withheldReason, "no-routes");
  });
  client.dispose();
});

test("a newer client request cancels an older unresolved request", async () => {
  const messages = [];
  const listeners = new Map();
  const fakeWorker = {
    postMessage(message) {
      messages.push(message);
    },
    terminate() {},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const client = new RouteScoringClient(() => fakeWorker);
  const input = baseInput();
  const first = client.scoreRoutes(input).catch((error) => error);
  const firstRequest = messages.find((message) => message.type === SCHEDULE_SCORE_REQUEST);
  const second = client.scoreRoutes(input);
  const cancelled = await first;
  assert.ok(cancelled instanceof RouteScoringCancelledError);
  assert.equal(messages.filter((message) => message.type === SCORING_GRID_INITIALISE).length, 1);
  assert.equal(messages.some((message) => message.type === SCORING_CANCEL_REQUEST), true);

  const latestRequest = messages.filter((message) => message.type === SCHEDULE_SCORE_REQUEST).at(-1);
  let latestSettled = false;
  void second.then(() => {
    latestSettled = true;
  });
  listeners.get("message")({
    data: {
      type: SCHEDULE_SCORE_SUCCESS,
      task: "scores",
      generation: firstRequest.generation,
      scores: [{ stale: true }],
    },
  });
  await Promise.resolve();
  assert.equal(latestSettled, false, "a stale response cannot settle the latest request");
  listeners.get("message")({
    data: {
      type: SCHEDULE_SCORE_SUCCESS,
      task: "scores",
      generation: latestRequest.generation,
      scores: [],
    },
  });
  assert.deepEqual(await second, []);
  client.dispose();
});
