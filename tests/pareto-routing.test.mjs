import assert from "node:assert/strict";
import test from "node:test";

import { findParetoPaths } from "../lib/pareto-routing.ts";

test("returns deterministic non-dominated time and conservative-exposure paths", () => {
  const graph = {
    edges: [
      { id: "fast-a", from: "start", to: "fast", durationSeconds: 60, directSunSeconds: 50, unknownSeconds: 0 },
      { id: "fast-b", from: "fast", to: "end", durationSeconds: 60, directSunSeconds: 50, unknownSeconds: 0 },
      { id: "balanced-a", from: "start", to: "balanced", durationSeconds: 75, directSunSeconds: 15, unknownSeconds: 0 },
      { id: "balanced-b", from: "balanced", to: "end", durationSeconds: 75, directSunSeconds: 15, unknownSeconds: 0 },
      { id: "cool-a", from: "start", to: "cool", durationSeconds: 100, directSunSeconds: 0, unknownSeconds: 0 },
      { id: "cool-b", from: "cool", to: "end", durationSeconds: 100, directSunSeconds: 0, unknownSeconds: 0 },
      { id: "dominated-a", from: "start", to: "dominated", durationSeconds: 90, directSunSeconds: 30, unknownSeconds: 0 },
      { id: "dominated-b", from: "dominated", to: "end", durationSeconds: 90, directSunSeconds: 30, unknownSeconds: 0 },
    ],
  };

  const paths = findParetoPaths(graph, "start", "end");
  assert.deepEqual(paths.map((path) => path.edgeIds), [
    ["fast-a", "fast-b"],
    ["balanced-a", "balanced-b"],
    ["cool-a", "cool-b"],
  ]);
  assert.deepEqual(paths.map((path) => path.potentialDirectSunSeconds), [100, 30, 0]);
});

test("counts unknown daylight as potential direct sun instead of rewarding missing data", () => {
  const graph = {
    edges: [
      { id: "known", from: "start", to: "end", durationSeconds: 100, directSunSeconds: 20, unknownSeconds: 0 },
      { id: "unknown-a", from: "start", to: "middle", durationSeconds: 50, directSunSeconds: 0, unknownSeconds: 40 },
      { id: "unknown-b", from: "middle", to: "end", durationSeconds: 50, directSunSeconds: 0, unknownSeconds: 40 },
    ],
  };

  const paths = findParetoPaths(graph, "start", "end");
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].edgeIds, ["known"]);
});

test("prevents cycles and handles an origin already at the destination", () => {
  const graph = {
    edges: [
      { id: "there", from: "a", to: "b", durationSeconds: 10, directSunSeconds: 2, unknownSeconds: 0 },
      { id: "back", from: "b", to: "a", durationSeconds: 10, directSunSeconds: 2, unknownSeconds: 0 },
      { id: "finish", from: "b", to: "c", durationSeconds: 10, directSunSeconds: 2, unknownSeconds: 0 },
    ],
  };
  assert.deepEqual(findParetoPaths(graph, "a", "c")[0].nodeIds, ["a", "b", "c"]);
  assert.deepEqual(findParetoPaths(graph, "a", "a"), [{
    edgeIds: [],
    nodeIds: ["a"],
    durationSeconds: 0,
    estimatedDirectSunSeconds: 0,
    unknownSeconds: 0,
    potentialDirectSunSeconds: 0,
  }]);
});

test("fails closed on malformed costs and resource bounds", () => {
  assert.throws(
    () => findParetoPaths({ edges: [
      { id: "bad", from: "a", to: "b", durationSeconds: 5, directSunSeconds: 6, unknownSeconds: 0 },
    ] }, "a", "b"),
    /incoherent exposure costs/,
  );

  const graph = { edges: [
    { id: "one", from: "a", to: "b", durationSeconds: 1, directSunSeconds: 0, unknownSeconds: 0 },
    { id: "two", from: "b", to: "c", durationSeconds: 1, directSunSeconds: 0, unknownSeconds: 0 },
  ] };
  assert.throws(
    () => findParetoPaths(graph, "a", "c", { maximumExpandedLabels: 1 }),
    /label-expansion bound/,
  );
});
