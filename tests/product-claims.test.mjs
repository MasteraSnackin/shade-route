import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("product copy distinguishes model output, privacy and loaded-session behaviour", async () => {
  const source = await readFile(new URL("../components/ShadeRouteApp.tsx", import.meta.url), "utf8");

  assert.match(source, /potential direct sun under clear skies/i);
  assert.match(source, /model sensitivity/i);
  assert.match(source, /sent to the routing provider and are not stored by ShadeRoute/i);
  assert.match(source, /already loaded in this session/i);
  assert.match(source, /field calibration pending/i);
  assert.doesNotMatch(source, /plausible range/i);
  assert.doesNotMatch(source, /Precise journeys stay in this browser session/i);
  assert.doesNotMatch(source, /full local shade coverage/i);
  assert.doesNotMatch(source, /Cached pilot journeys still work/i);
});

test("map renders scored exposure sections with a matching text legend", async () => {
  const [mapSource, appSource] = await Promise.all([
    readFile(new URL("../components/RouteMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ShadeRouteApp.tsx", import.meta.url), "utf8"),
  ]);

  for (const category of ["sun", "shade", "uncertain", "unknown", "night"]) {
    assert.match(mapSource, new RegExp(`category: \\"${category}\\"`));
  }
  assert.match(mapSource, /featureCollectionForExposure\(selectedScore\.sections/);
  assert.match(appSource, /MAP_EXPOSURE_LEGEND/);
  assert.match(appSource, /Selected route exposure key/);
});

test("map presents time-controlled 3D buildings and moving ground shadows", async () => {
  const [mapSource, appSource, explorerSource] = await Promise.all([
    readFile(new URL("../components/RouteMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ShadeRouteApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ShadeTimeExplorer.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(mapSource, /type: "fill-extrusion"/);
  assert.match(mapSource, /renderGroundShadowFrame/);
  assert.match(mapSource, /type: "canvas"/);
  assert.match(mapSource, /map\.setLight/);
  assert.match(appSource, /const mapDepartureDate = inspectionDeparture \?\? departureDate/);
  assert.match(appSource, /departureDate=\{mapDepartureDate\}/);
  assert.match(appSource, /activeDirectionIndex=\{activeDirectionIndex\}/);
  assert.match(explorerSource, /Watch the shade move/);
  assert.match(explorerSource, /type="range"/);
  assert.match(explorerSource, /Drag to move the ground shadows/);
});

test("step inspection, walking mode and private local tools are wired into the decision flow", async () => {
  const [appSource, mapSource] = await Promise.all([
    readFile(new URL("../components/ShadeRouteApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/RouteMap.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(appSource, /<JourneyMode/);
  assert.match(appSource, /<SavedJourneys/);
  assert.match(appSource, /<FieldFeedback/);
  assert.match(appSource, /<RouteContextPanel/);
  assert.match(appSource, /No rough flag; pavement condition not surveyed/);
  assert.match(appSource, /Gradient, kerbs and width not verified/);
  assert.match(mapSource, /routeSegmentIndex/);
  assert.match(mapSource, /route-context-points/);
});

test("cached pilot routes expose known vertical-access barriers", async () => {
  const routeData = JSON.parse(
    await readFile(new URL("../public/data/pilot-routes.json", import.meta.url), "utf8"),
  );
  const waterloo = routeData.areas.find((area) => area.id === "waterloo");
  assert.ok(waterloo);

  const instructions = waterloo.routes.map((route) =>
    route.directions.map((direction) => direction.instruction).join(" ").toLowerCase(),
  );
  assert.ok(instructions.some((text) => text.includes("stairs")));
  assert.ok(instructions.some((text) => text.includes("escalator")));
  assert.ok(instructions.some((text) => /level\s*-\d/.test(text)));
});

test("reversed routes preserve source access evidence when walking steps are hidden", async () => {
  const source = await readFile(
    new URL("../components/ShadeRouteApp.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /accessReference:\s*route\.directions\.map/);
  assert.match(source, /hasAccessEvidence\s*&&\s*!hasStairs\s*&&\s*!hasEscalator/);
  assert.match(source, /Access details unavailable; step-free not verified/);
});
