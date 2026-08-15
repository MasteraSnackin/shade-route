import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCORING_REQUEST_TIMEOUT_MS,
  RouteScoringClient,
  RouteScoringCancelledError,
  RouteScoringUnavailableError,
} from "../lib/route-scoring-client.ts";
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

function makeTestWorker({
  respondToScores = false,
  delayedScoreResponseMs = null,
  respondDuringCleanup = false,
} = {}) {
  const listeners = new Map();
  const worker = {
    messages: [],
    terminated: false,
    delayedResponseSent: false,
    cleanupResponseSent: false,
    postMessage(message) {
      worker.messages.push(message);
      if (respondToScores && message.type === SCHEDULE_SCORE_REQUEST) {
        listeners.get("message")?.({
          data: {
            type: SCHEDULE_SCORE_SUCCESS,
            task: "scores",
            generation: message.generation,
            scores: [],
          },
        });
      }
      if (delayedScoreResponseMs !== null && message.type === SCHEDULE_SCORE_REQUEST) {
        const listener = listeners.get("message");
        globalThis.setTimeout(() => {
          worker.delayedResponseSent = true;
          listener?.({
            data: {
              type: SCHEDULE_SCORE_SUCCESS,
              task: "scores",
              generation: message.generation,
              scores: [{ stale: true }],
            },
          });
        }, delayedScoreResponseMs);
      }
    },
    terminate() {
      worker.terminated = true;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (respondDuringCleanup && type === "message" && !worker.cleanupResponseSent) {
        const request = worker.messages.findLast((message) => message.type === SCHEDULE_SCORE_REQUEST);
        if (request) {
          worker.cleanupResponseSent = true;
          listener({
            data: {
              type: SCHEDULE_SCORE_SUCCESS,
              task: "scores",
              generation: request.generation,
              scores: [{ stale: true }],
            },
          });
        }
      }
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    listenerCount() {
      return listeners.size;
    },
  };
  return worker;
}

function installTrackedTimers(context) {
  let nextId = 0;
  const active = new Map();
  context.mock.method(globalThis, "setTimeout", (callback, delay = 0, ...args) => {
    nextId += 1;
    active.set(nextId, {
      delay,
      run: () => callback(...args),
    });
    return nextId;
  });
  context.mock.method(globalThis, "clearTimeout", (id) => {
    active.delete(id);
  });
  return {
    active,
    run(id) {
      const timer = active.get(id);
      assert.ok(timer, `timer ${id} is not active`);
      active.delete(id);
      timer.run();
    },
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

test("scoring watchdog options have a bounded production default", () => {
  assert.equal(DEFAULT_SCORING_REQUEST_TIMEOUT_MS, 15_000);
  assert.throws(
    () => new RouteScoringClient(() => makeTestWorker(), { requestTimeoutMs: 0 }),
    /between 1 and 60,000 milliseconds/,
  );
  assert.throws(
    () => new RouteScoringClient(() => makeTestWorker(), { requestTimeoutMs: 60_001 }),
    /between 1 and 60,000 milliseconds/,
  );
});

test("a silent scoring worker times out, falls back, and is replaced safely", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const workers = [];
  const client = new RouteScoringClient(() => {
    const worker = makeTestWorker({ respondToScores: workers.length > 0 });
    workers.push(worker);
    return worker;
  }, { requestTimeoutMs: 25 });

  const timedOutScore = client.scoreRoutes(baseInput());
  assert.equal(workers.length, 1);
  assert.equal(workers[0].listenerCount(), 3);
  context.mock.timers.tick(25);

  assert.deepEqual(await timedOutScore, []);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].listenerCount(), 0);

  assert.deepEqual(await client.scoreRoutes(baseInput()), []);
  assert.equal(workers.length, 2, "the next request gets a fresh worker");
  context.mock.timers.runAll();
  assert.equal(workers[1].terminated, false, "a settled request leaves no stale watchdog");

  client.dispose();
  assert.equal(workers[1].terminated, true);
  assert.equal(workers[1].listenerCount(), 0);
});

test("a silent departure-advice worker settles through the synchronous fallback", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = makeTestWorker();
  const client = new RouteScoringClient(() => worker, { requestTimeoutMs: 40 });

  const advicePromise = client.buildDepartureAdvice(baseInput());
  context.mock.timers.tick(40);
  const advice = await advicePromise;

  assert.equal(advice.withheldReason, "no-routes");
  assert.equal(worker.terminated, true);
  assert.equal(worker.listenerCount(), 0);
  context.mock.timers.runAll();
  client.dispose();
});

test("a response already queued by a timed-out worker cannot replace fallback output", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = makeTestWorker({ delayedScoreResponseMs: 25 });
  const client = new RouteScoringClient(() => worker, { requestTimeoutMs: 25 });

  const scorePromise = client.scoreRoutes(baseInput());
  context.mock.timers.tick(25);

  assert.equal(worker.delayedResponseSent, true, "the retired worker attempted a late response");
  assert.deepEqual(await scorePromise, [], "only the synchronous fallback may settle the request");
  assert.equal(worker.terminated, true);
  context.mock.timers.runAll();
  client.dispose();
});

test("worker cleanup cannot re-entrantly settle a timed-out request", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = makeTestWorker({ respondDuringCleanup: true });
  const client = new RouteScoringClient(() => worker, { requestTimeoutMs: 25 });

  const scorePromise = client.scoreRoutes(baseInput());
  context.mock.timers.tick(25);

  assert.equal(worker.cleanupResponseSent, true, "cleanup attempted a re-entrant response");
  assert.deepEqual(await scorePromise, [], "the request remains owned by its fallback");
  assert.equal(worker.terminated, true);
  context.mock.timers.runAll();
  client.dispose();
});

test("a failed synchronous fallback rejects with the fixed unavailable error", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = makeTestWorker();
  const client = new RouteScoringClient(() => worker, { requestTimeoutMs: 25 });
  const invalidInput = {
    ...baseInput(),
    windowMinutes: -1,
  };

  const advicePromise = client.buildDepartureAdvice(invalidInput);
  context.mock.timers.tick(25);

  await assert.rejects(advicePromise, (error) => {
    assert.ok(error instanceof RouteScoringUnavailableError);
    assert.equal(error.name, "RouteScoringUnavailableError");
    assert.equal(error.message, "Route exposure calculation is unavailable.");
    return true;
  });
  assert.equal(worker.terminated, true);
  assert.equal(worker.listenerCount(), 0);
  context.mock.timers.runAll();
  client.dispose();
});

test("watchdog and fallback timers are cleared on every settlement path", async (context) => {
  const timers = installTrackedTimers(context);

  const responsiveWorker = makeTestWorker({ respondToScores: true });
  const responsiveClient = new RouteScoringClient(() => responsiveWorker, {
    requestTimeoutMs: 25,
  });
  assert.deepEqual(await responsiveClient.scoreRoutes(baseInput()), []);
  assert.equal(timers.active.size, 0, "a normal response clears its watchdog");
  responsiveClient.dispose();

  const cancelledWorker = makeTestWorker();
  const cancelledClient = new RouteScoringClient(() => cancelledWorker, {
    requestTimeoutMs: 25,
  });
  const cancelledPromise = cancelledClient.scoreRoutes(baseInput()).catch((error) => error);
  assert.equal(timers.active.size, 1);
  cancelledClient.cancelScores();
  assert.ok(await cancelledPromise instanceof RouteScoringCancelledError);
  assert.equal(timers.active.size, 0, "cancellation clears its watchdog");
  cancelledClient.dispose();

  const timedOutWorker = makeTestWorker();
  const timedOutClient = new RouteScoringClient(() => timedOutWorker, {
    requestTimeoutMs: 25,
  });
  const sharedInput = baseInput();
  const scorePromise = timedOutClient.scoreRoutes(sharedInput);
  const advicePromise = timedOutClient.buildDepartureAdvice(sharedInput);
  assert.equal(timers.active.size, 2, "each pending result stream owns one watchdog");

  const watchdogId = [...timers.active].find(([, timer]) => timer.delay === 25)?.[0];
  assert.ok(watchdogId);
  timers.run(watchdogId);
  assert.equal(timers.active.size, 2, "the watchdogs are replaced by two fallback turns");
  for (const [id, timer] of [...timers.active]) {
    assert.equal(timer.delay, 0);
    timers.run(id);
  }

  assert.deepEqual(await scorePromise, []);
  assert.equal((await advicePromise).withheldReason, "no-routes");
  assert.equal(timers.active.size, 0, "settled fallbacks leave no timers behind");
  timedOutClient.dispose();
  assert.equal(timedOutWorker.listenerCount(), 0);
});

test("a failed cancellation cannot dispatch through a detached worker reference", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = makeTestWorker();
  const originalPostMessage = worker.postMessage;
  worker.postMessage = (message) => {
    if (message.type === SCORING_CANCEL_REQUEST) throw new Error("cancel transport failed");
    originalPostMessage(message);
  };
  const client = new RouteScoringClient(() => worker, { requestTimeoutMs: 25 });

  const first = client.scoreRoutes(baseInput()).catch((error) => error);
  const second = client.scoreRoutes(baseInput());

  assert.ok(await first instanceof RouteScoringCancelledError);
  assert.equal(
    worker.messages.filter((message) => message.type === SCHEDULE_SCORE_REQUEST).length,
    1,
    "the replacement is not posted to the worker detached during cancellation",
  );
  context.mock.timers.tick(0);
  assert.deepEqual(await second, []);
  assert.equal(worker.terminated, true);
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
