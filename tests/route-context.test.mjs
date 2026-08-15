import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildRouteContextSummary,
  estimateRouteContextProximity,
  GLA_COOL_SPACES_2025_DATASET_URL,
  GLA_COOL_SPACES_2025_SOURCE,
  GLA_COOL_SPACES_CURRENT_MAP_URL,
  GLA_PUBLIC_REALM_TREES_DATASET_URL,
  GLA_PUBLIC_REALM_TREES_RESOURCE_URL,
  loadRouteContext,
  parseRouteContextData,
  ROUTE_CONTEXT_CATEGORIES,
} from "../lib/route-context.ts";

async function contextFixture(areaId) {
  return JSON.parse(await readFile(
    new URL(`../public/data/context-${areaId}.json`, import.meta.url),
    "utf8",
  ));
}

function feature(overrides = {}) {
  return {
    id: "osm-node-1",
    category: "drinking-water",
    subtype: "drinking-fountain",
    name: "Test fountain",
    coordinate: [-0.001, 51.5],
    sourceRef: {
      osmType: "node",
      osmId: 1,
      url: "https://www.openstreetmap.org/node/1",
    },
    ...overrides,
  };
}

test("both pilot snapshots validate with explicit provenance and per-category completeness", async () => {
  for (const areaId of ["waterloo", "kings-cross"]) {
    const parsed = parseRouteContextData(await contextFixture(areaId));
    assert.ok(parsed);
    assert.equal(parsed.areaId, areaId);
    assert.equal(parsed.source.label, "OpenStreetMap contributors");
    assert.equal(parsed.source.licence, "ODbL");
    assert.equal(parsed.additionalSources.length, 2);
    assert.deepEqual(parsed.additionalSources[0], GLA_COOL_SPACES_2025_SOURCE);
    assert.equal(parsed.additionalSources[1].url, GLA_PUBLIC_REALM_TREES_DATASET_URL);
    assert.equal(parsed.additionalSources[1].resourceUrl, GLA_PUBLIC_REALM_TREES_RESOURCE_URL);
    assert.equal(parsed.additionalSources[1].licence, "Open Government Licence v3");
    assert.match(parsed.additionalSources[1].sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(parsed.completeness), [...ROUTE_CONTEXT_CATEGORIES]);
    assert.equal(parsed.completeness["cool-space"].status, "partial");
    const coolSpaces = parsed.features.filter((item) => item.category === "cool-space");
    assert.ok(coolSpaces.length > 0);
    assert.ok(coolSpaces.every((item) => (
      item.subtype === "official-cool-space" &&
      "dataset" in item.sourceRef &&
      item.sourceRef.dataset === "gla-cool-spaces-2025" &&
      item.sourceRef.url === GLA_COOL_SPACES_2025_DATASET_URL &&
      item.id === `gla-cool-space-${item.sourceRef.recordId}` &&
      item.details?.coolSpaceRegisterYear === 2025 &&
      (item.details.coolSpaceTier === 1 || item.details.coolSpaceTier === 2)
    )));
    const publicTrees = parsed.features.filter((item) => (
      "dataset" in item.sourceRef && item.sourceRef.dataset === "gla-public-realm-trees-2025"
    ));
    assert.ok(publicTrees.length > 0);
    assert.ok(publicTrees.every((item) => (
      item.category === "tree" &&
      item.subtype === "public-realm-street-tree" &&
      item.sourceRef.url === GLA_PUBLIC_REALM_TREES_DATASET_URL &&
      item.id === `gla-public-tree-${item.sourceRef.recordId}` &&
      item.details?.treeInventoryLocation === "Highways"
    )));
    assert.ok(parsed.features.filter((item) => "osmId" in item.sourceRef).every((item) => (
      "osmId" in item.sourceRef && item.id === `osm-node-${item.sourceRef.osmId}`
    )));
  }
});

test("strict parser binds GLA provenance, official subtype, record identity and completeness", async () => {
  const fixture = await contextFixture("waterloo");
  const coolSpace = fixture.features.find((item) => item.category === "cool-space");
  const toilet = fixture.features.find((item) => item.category === "toilet");
  assert.equal(parseRouteContextData({
    ...fixture,
    features: [{ ...coolSpace, category: "tree" }],
  }), null);
  assert.equal(parseRouteContextData({
    ...fixture,
    features: [coolSpace, { ...coolSpace, id: "another-id" }],
  }), null);
  assert.equal(parseRouteContextData({
    ...fixture,
    completeness: {
      ...fixture.completeness,
      "cool-space": { status: "not-collected", note: "Not collected." },
    },
  }), null);
  assert.equal(parseRouteContextData({ ...fixture, additionalSources: undefined }), null);
  assert.equal(parseRouteContextData({
    ...fixture,
    additionalSources: [{ ...fixture.additionalSources[0], snapshotAt: "2026-08-12T00:00:00Z" }],
  }), null);
  assert.equal(parseRouteContextData({
    ...fixture,
    features: [{ ...coolSpace, id: "gla-cool-space-999" }],
  }), null);
  assert.equal(parseRouteContextData({
    ...fixture,
    features: [{
      ...toilet,
      category: "cool-space",
      subtype: "official-cool-space",
      details: { coolSpaceRegisterYear: 2025, coolSpaceTier: 1 },
    }],
  }), null);
  assert.equal(parseRouteContextData({
    ...fixture,
    features: [{
      ...coolSpace,
      id: "gla-cool-space-36",
      category: "toilet",
      subtype: "toilet",
    }],
  }), null);
  assert.equal(parseRouteContextData({
    ...fixture,
    features: fixture.features.filter((item) => item.category !== "cool-space"),
  }), null);
});

test("proximity projects onto route geometry and exposes only a rounded-up detour lower bound", () => {
  const route = {
    coordinates: [[-0.002, 51.5], [0.002, 51.5]],
  };
  const result = estimateRouteContextProximity(route, feature());
  assert.ok(result);
  assert.ok(result.rawDistanceFromRouteMetres < 0.01);
  assert.equal(result.distanceFromRouteMetres, 0);
  assert.equal(result.minimumReturnDetourMetres, 0);
  assert.ok(result.routeProgressPercent > 20 && result.routeProgressPercent < 30);

  const offRoute = estimateRouteContextProximity(route, feature({ coordinate: [0, 51.501] }));
  assert.ok(offRoute.rawDistanceFromRouteMetres > 110);
  assert.ok(offRoute.distanceFromRouteMetres >= offRoute.rawDistanceFromRouteMetres);
  assert.ok(offRoute.minimumReturnDetourMetres >= offRoute.rawDistanceFromRouteMetres * 2);
});

test("summary separates categories, filters by raw radius and reports omitted matches", async () => {
  const parsed = parseRouteContextData(await contextFixture("kings-cross"));
  assert.ok(parsed);
  const route = {
    id: "test-route",
    coordinates: [[-0.1246, 51.5302], [-0.1361, 51.52545]],
  };
  const summary = buildRouteContextSummary(route, parsed, {
    radiusMetres: 300,
    limitPerCategory: 1,
  });
  assert.deepEqual(summary.categories.map((item) => item.category), [...ROUTE_CONTEXT_CATEGORIES]);
  const coolSpaces = summary.categories.find((item) => item.category === "cool-space");
  assert.equal(coolSpaces.matches.length, 1);
  assert.ok("dataset" in coolSpaces.matches[0].feature.sourceRef);
  assert.ok(coolSpaces.additionalMatchCount > 0);
  assert.ok(summary.categories.find((item) => item.category === "drinking-water").matches.length > 0);
  assert.ok(summary.categories.every((item) => item.matches.length <= 1));
  assert.ok(summary.categories.flatMap((item) => item.matches).every(
    (item) => item.rawDistanceFromRouteMetres <= summary.radiusMetres,
  ));
});

test("loader requests the area-specific static snapshot and rejects the wrong area", async () => {
  const waterloo = await contextFixture("waterloo");
  let requestedUrl;
  const loaded = await loadRouteContext("waterloo", {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify(waterloo));
    },
  });
  assert.equal(requestedUrl, "/data/context-waterloo.json");
  assert.equal(loaded.areaId, "waterloo");

  await assert.rejects(
    loadRouteContext("kings-cross", {
      fetchImpl: async () => new Response(JSON.stringify(waterloo)),
    }),
    /invalid/i,
  );
});

test("panel uses cautious distance, availability, cool-space and tree language", async () => {
  const component = await readFile(
    new URL("../components/RouteContextPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /straight-line/);
  assert.match(component, /at least/);
  assert.match(component, /availability is not live/i);
  assert.match(component, /not the GLA(?:&apos;|')s live Summer\s*2026 map/i);
  assert.match(component, /does not imply GLA endorsement, affiliation, support or approval/i);
  assert.match(component, /do not establish canopy or usable shade/i);
  assert.match(component, /GLA_COOL_SPACES_CURRENT_MAP_URL/);
  assert.equal(GLA_COOL_SPACES_CURRENT_MAP_URL, "https://apps.london.gov.uk/cool-spaces/");
  assert.doesNotMatch(component, /guaranteed|verified cool|safe route/i);
});
