import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keyboard users can bypass the introduction and focus the journey planner", async () => {
  const source = await readFile(
    new URL("../components/ShadeRouteApp.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /className="skip-link"[\s\S]*?href="#route-planner"/);
  assert.match(source, /getElementById\("route-planner"\)\?\.focus\(\)/);
  assert.match(source, /id="route-planner"[\s\S]*?tabIndex=\{-1\}/);
  assert.match(source, /aria-pressed=\{candidate\.id === areaId\}/);
  assert.match(source, /aria-pressed=\{route\.id === selectedRouteId\}/);
});

test("keyboard users can confirm the map centre while choosing a custom point", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../components/RouteMap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /const centre = mapRef\.current\?\.getCenter\(\)/);
  assert.match(source, /pickCallbackRef\.current\(\[centre\.lng, centre\.lat\]\)/);
  assert.match(source, /Use map centre for \{pickingLabel\}/);
  assert.match(source, /use its arrow keys[\s\S]*?centre marker/);
  assert.match(source, /className="map-pick-centre" aria-hidden="true"/);
  assert.match(css, /\.map-status\.is-picking button\s*\{[\s\S]*?min-height: 44px;/);
});

test("local place failures retain pilot landmarks and expose a bounded retry", async () => {
  const source = await readFile(
    new URL("../components/LocalPlaceSearch.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /const controller = new AbortController\(\)/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /\.\.\.pilotOptions\(area\),[\s\S]*?\.\.\.currentContextState\.options/);
  assert.match(source, /Local amenity places could not be loaded\. The two pilot landmarks are still available\./);
  assert.match(source, /Retry local places/);
});

test("dense controls retain accessible targets and user display preferences", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.local-place-search input\[type="search"\]\s*\{[\s\S]*?min-height: 44px;/);
  assert.match(css, /\.shade-explorer__time-field input\[type="range"\]\s*\{[\s\S]*?min-height: 44px;/);
  assert.match(css, /\.shade-explorer__quick-times button\s*\{[\s\S]*?min-width: 44px;/);
  assert.match(css, /\.planner-map-column\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.maplibregl-ctrl-group button\s*\{\s*width: 44px;\s*height: 44px;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
});

test("site footer rules do not leak into the shade playback footer", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.site-shell > footer\s*\{/);
  assert.doesNotMatch(css, /(?:^|\n)\s*footer\s*\{/);
});

test("decision evidence has a scoped responsive information layout", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../components/DecisionEvidenceDownload.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /className="model-status-panel decision-evidence"/);
  assert.match(source, /className="decision-evidence__privacy"/);
  assert.match(source, /className="primary-button decision-evidence__action"/);
  assert.match(css, /\.decision-evidence\s*\{[\s\S]*?grid-template-areas:/);
  assert.match(css, /"heading privacy action"/);
});

test("initial data loading has a non-blocking skeleton and preserves error announcements", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../components/ShadeRouteApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /<p role=\{error \? "alert" : "status"\}>/);
  assert.match(source, /\{!error && \(\s*<div className="boot-skeleton" aria-hidden="true">/);
  assert.match(css, /@keyframes boot-skeleton-shimmer/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.boot-skeleton span::after\s*\{[\s\S]*?animation: none;/);
});

test("regional heat context uses a section-level heading", async () => {
  const source = await readFile(new URL("../components/HeatContext.tsx", import.meta.url), "utf8");

  assert.match(source, /<h2 id="heat-context-title">London heat-health context<\/h2>/);
  assert.doesNotMatch(source, /<h3 id="heat-context-title">/);
});
