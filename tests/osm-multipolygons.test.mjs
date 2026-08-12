import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleBuildingMultipolygon,
  assembleWayRings,
  buildMapFeatures,
} from "../scripts/prepare-data.mjs";

function node(id, x, y) {
  return {
    type: "node",
    id,
    lon: -0.14 + x * 0.001,
    lat: 51.5 + y * 0.001,
  };
}

function fixtureElements() {
  return [
    node(1, 0, 0),
    node(2, 4, 0),
    node(3, 4, 4),
    node(4, 0, 4),
    node(5, 1, 1),
    node(6, 2, 1),
    node(7, 2, 2),
    node(8, 1, 2),
    node(9, 6, 0),
    node(10, 8, 0),
    node(11, 8, 2),
    node(12, 6, 2),
    node(13, 10, 0),
    node(14, 11, 0),
    node(15, 11, 1),
    node(16, 10, 1),
    node(17, 12, 0),
    node(18, 13, 0),
    { type: "way", id: 100, nodes: [1, 2, 3] },
    { type: "way", id: 101, nodes: [1, 4, 3] },
    { type: "way", id: 102, nodes: [5, 6, 7] },
    { type: "way", id: 103, nodes: [5, 8, 7] },
    {
      type: "way",
      id: 104,
      nodes: [9, 10, 11, 12, 9],
      tags: { building: "yes" },
    },
    {
      type: "way",
      id: 200,
      nodes: [13, 14, 15, 16, 13],
      tags: { building: "commercial", highway: "pedestrian", height: "9 m" },
    },
    {
      type: "way",
      id: 201,
      nodes: [17, 18],
      tags: { highway: "footway" },
    },
    {
      type: "relation",
      id: 500,
      members: [
        { type: "way", ref: 103, role: "inner" },
        { type: "way", ref: 104, role: "outer" },
        { type: "way", ref: 101, role: "outer" },
        { type: "way", ref: 102, role: "inner" },
        { type: "way", ref: 100, role: "outer" },
      ],
      tags: {
        type: "multipolygon",
        building: "hospital",
        height: "21 m",
        name: "Relation building",
      },
    },
  ];
}

test("open and reversed member ways are joined into a closed ring", () => {
  const elements = fixtureElements();
  const wayLookup = new Map(
    elements.filter((element) => element.type === "way").map((way) => [way.id, way]),
  );
  const rings = assembleWayRings([
    { type: "way", ref: 101, role: "outer" },
    { type: "way", ref: 100, role: "outer" },
  ], wayLookup);

  assert.equal(rings.length, 1);
  assert.equal(rings[0][0], rings[0].at(-1));
  assert.deepEqual(new Set(rings[0].slice(0, -1)), new Set([1, 2, 3, 4]));
});

test("building relations retain holes and multiple outers without member duplication", () => {
  const features = buildMapFeatures({ elements: fixtureElements() }, null);
  const relationBuilding = features.find((feature) =>
    feature.properties.name === "Relation building",
  );
  const buildings = features.filter((feature) => feature.properties.kind === "building");
  const roads = features.filter((feature) => feature.properties.kind === "road");

  assert.equal(buildings.length, 2, "the tagged outer member must not become a duplicate building");
  assert.equal(relationBuilding.properties.class, "hospital");
  assert.equal(relationBuilding.properties.heightMetres, 21);
  assert.equal(relationBuilding.geometry.type, "MultiPolygon");
  assert.deepEqual(relationBuilding.geometry.coordinates.map((polygon) => polygon.length), [2, 1]);

  const dualTaggedWay = buildings.find((feature) => feature.properties.class === "commercial");
  assert.ok(dualTaggedWay, "a building+highway way must remain a building polygon");
  assert.equal(dualTaggedWay.geometry.type, "Polygon");
  assert.equal(roads.length, 1);
  assert.equal(roads[0].properties.class, "footway");
});

test("multipolygon output is deterministic across source and member ordering", () => {
  const elements = fixtureElements();
  const shuffledElements = [...elements].reverse().map((element) =>
    element.type === "relation"
      ? { ...element, members: [...element.members].reverse() }
      : element,
  );

  assert.equal(
    JSON.stringify(buildMapFeatures({ elements })),
    JSON.stringify(buildMapFeatures({ elements: shuffledElements })),
  );
});

test("incomplete relations are rejected instead of emitting partial buildings", () => {
  const elements = fixtureElements();
  const nodeLookup = new Map(
    elements.filter((element) => element.type === "node").map((entry) => [entry.id, entry]),
  );
  const wayLookup = new Map(
    elements.filter((element) => element.type === "way").map((way) => [way.id, way]),
  );
  const incomplete = {
    type: "relation",
    id: 999,
    members: [
      { type: "way", ref: 100, role: "outer" },
      { type: "way", ref: 404, role: "outer" },
    ],
    tags: { type: "multipolygon", building: "yes" },
  };

  assert.deepEqual(assembleBuildingMultipolygon(incomplete, wayLookup, nodeLookup), []);
});
