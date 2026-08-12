import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("product copy distinguishes model output, privacy and loaded-session behaviour", async () => {
  const source = await readFile(new URL("../components/ShadeRouteApp.tsx", import.meta.url), "utf8");

  assert.match(source, /potential direct sun under clear skies/i);
  assert.match(source, /model sensitivity/i);
  assert.match(source, /sent to the routing provider but are not saved automatically/i);
  assert.match(source, /only if you explicitly save the journey/i);
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
  assert.match(mapSource, /\[area, departureDate, routes\]/);
  assert.match(appSource, /const mapDepartureDate = inspectionDeparture \?\? selectedJourneyDepartureDate/);
  assert.match(appSource, /departureDate=\{mapDepartureDate\}/);
  assert.match(appSource, /scores=\{mapScores\}/);
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

test("the primary planner exposes local place search, London departure time and a pre-map decision", async () => {
  const [appSource, placeSearchSource] = await Promise.all([
    readFile(new URL("../components/ShadeRouteApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/LocalPlaceSearch.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(appSource, /type="datetime-local"/);
  assert.match(appSource, /Leave at · London time/);
  assert.match(appSource, /setDeparture\(londonDateTimeValue\(new Date\(\)\)\)/);
  assert.match(appSource, /<LocalPlaceSearch/);
  assert.match(placeSearchSource, /role="combobox"/);
  assert.match(placeSearchSource, /context-\$\{area\.id\}\.json/);
  assert.doesNotMatch(placeSearchSource, /https?:\/\//);

  const decisionIndex = appSource.indexOf('className="route-decision-strip"');
  const mapIndex = appSource.indexOf('className="map-stage"');
  assert.ok(decisionIndex > 0 && mapIndex > decisionIndex);
});

test("audience changes preserve route preferences and walking guidance is explicitly a preview", async () => {
  const source = await readFile(new URL("../components/ShadeRouteApp.tsx", import.meta.url), "utf8");
  const profileControl = source.match(/<select value=\{profile\}[\s\S]*?<\/select>/)?.[0] ?? "";

  assert.match(profileControl, /setProfile/);
  assert.doesNotMatch(profileControl, /setAvoidSteps|setJourneyCount/);
  assert.match(source, /Try illustrative 4-trip hospital shift/);
  assert.match(source, /Modelled walking pace/);
  assert.match(source, /planning preset, not a measured personal speed/i);
  assert.match(source, /<ShiftExposureTimeline/);
  assert.match(source, /const resetScheduledPreview[\s\S]+clearDirectionInspection\(\)/);
  assert.match(source, /Daylight coverage not applicable/);
  assert.match(source, /Preview walking steps/);
  assert.match(source, /Pre-journey steps for/);
  assert.doesNotMatch(source, />Walk this route</);
});

test("pending exposure never reuses scores from a different planner state", async () => {
  const source = await readFile(new URL("../components/ShadeRouteApp.tsx", import.meta.url), "utf8");

  for (const guard of [
    /scoreState\.areaId === area\?\.id/,
    /scoreState\.routes === routes/,
    /scoreState\.departure === departure/,
    /scoreState\.profile === profile/,
    /scoreState\.journeyCount === effectiveJourneyCount/,
    /scoreState\.repeatEveryMinutes === repeatEveryMinutes/,
    /scoreState\.walkingPace === walkingPace/,
    /scoreState\.avoidSteps === avoidSteps/,
  ]) assert.match(source, guard);
  assert.match(source, /const invalidateScores[\s\S]+setScoreState\(null\);[\s\S]+setLoading\(false\);/);
  assert.match(source, /departureAdviceState\.routes === departureAdviceRoutes/);
  assert.match(source, /routeScoringClient\.cancelDepartureAdvice\(\)/);
  assert.match(source, /const clearRoutesForEditing[\s\S]+invalidateScores\(\);[\s\S]+setRoutes\(\[\]\);/);
  assert.match(source, /setRoutes\(\[\.\.\.area\.routes\]\)/);
  assert.match(source, /Option \{routeIndex \+ 1\}/);
  assert.doesNotMatch(source, /Rank \{rank \+ 1\}/);
});

test("offline preparation and decision evidence are tied to the selected current pilot result", async () => {
  const source = await readFile(new URL("../components/ShadeRouteApp.tsx", import.meta.url), "utf8");

  assert.match(source, /<OfflinePilotPreparation/);
  assert.match(source, /areaId=\{area\.id\}/);
  assert.match(source, /onStatusChange=\{\(status\) => setOfflinePilotStatus\(\{ areaId: area\.id, status \}\)\}/);
  assert.match(source, /selectedOfflinePilotReady/);
  assert.match(source, /Custom routing and current heat information need a connection/);
  assert.match(source, /selectedRoute && selectedScore && fastestRoute && departureDate && !loading/);
  assert.match(source, /<DecisionEvidenceDownload/);
  assert.match(source, /selectedScore,/);
  assert.match(source, /journeyCount: effectiveJourneyCount/);
  assert.match(source, /Field checks<\/dt><dd>0 recorded — calibration pending/);
});
