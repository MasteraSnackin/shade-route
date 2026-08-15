import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fetchHeatContext } from "../app/api/heat-context/route.ts";
import {
  noActiveHeatContext,
  parseUkhsaHeatContext,
  staleHeatContext,
  unavailableHeatContext,
  UKHSA_HEAT_METRIC,
  UKHSA_HEAT_METRIC_URL,
} from "../lib/heat-context.ts";

function record(overrides = {}) {
  return {
    theme: "climate_and_environment",
    sub_theme: "seasonal_environmental",
    topic: "Heat-alert",
    geography_type: "Government Office Region",
    geography: "London",
    geography_code: "E12000007",
    metric: UKHSA_HEAT_METRIC,
    date: "2026-08-11",
    metric_value: 9,
    ...overrides,
  };
}

test("parses the latest valid London score from the documented paginated response", () => {
  const parsed = parseUkhsaHeatContext({
    count: 4,
    next: null,
    previous: null,
    results: [
      record({ date: "2026-08-09", metric_value: 7 }),
      record({ geography: "South East", geography_code: "E12000008", metric_value: 16 }),
      record({ date: "2026-08-12", metric_value: 12 }),
      record({ date: "not-a-date", metric_value: 15 }),
    ],
  });

  assert.equal(parsed?.riskScore, 12);
  assert.equal(parsed?.asOf, "2026-08-12");
  assert.equal(parsed?.region, "London");
  assert.equal(parsed?.stale, false);
});

test("narrowly supports a camel-case beta response without relaxing field validation", () => {
  const parsed = parseUkhsaHeatContext({
    data: {
      results: [{
        metricName: UKHSA_HEAT_METRIC,
        geographyName: "London",
        geographyCode: "E12000007",
        geographyType: "Government_Office_Region",
        metricValue: 4,
        date: "2026-06-01",
      }],
    },
  });

  assert.equal(parsed?.riskScore, 4);
  assert.equal(parsed?.regionType, "Government Office Region");
});

test("treats the documented empty UKHSA page as no active alert", () => {
  const parsed = parseUkhsaHeatContext({
    count: 0,
    next: null,
    previous: null,
    results: [],
  });

  assert.deepEqual(parsed, {
    status: "no_active_alert",
    region: "London",
    regionType: "Government Office Region",
    metric: UKHSA_HEAT_METRIC,
    message: "UKHSA returned no active London heat-health alert.",
    stale: false,
    source: {
      label: "UKHSA data dashboard",
      url: "https://ukhsa-dashboard.data.gov.uk/weather-health-alerts/heat/london",
    },
  });
});

test("does not mistake an incomplete or contradictory empty wrapper for no active alert", () => {
  for (const value of [
    { results: [] },
    { count: 0, next: null, results: [] },
    { count: 1, next: null, previous: null, results: [] },
    { count: 0, next: "page-2", previous: null, results: [] },
    { count: 0, next: null, previous: null, results: [record({ metric_value: "bad" })] },
  ]) {
    assert.equal(parseUkhsaHeatContext(value), null);
  }
});

test("a cached no-alert result can be marked stale without becoming unavailable", () => {
  assert.deepEqual(staleHeatContext(noActiveHeatContext()), {
    ...noActiveHeatContext(),
    stale: true,
  });
});

test("rejects malformed, out-of-range and non-London upstream records", () => {
  for (const value of [
    null,
    { results: [] },
    { results: [record({ metric_value: 0 })] },
    { results: [record({ metric_value: 17 })] },
    { results: [record({ metric_value: "10" })] },
    { results: [record({ metric: "another_metric" })] },
    { results: [record({ geography_type: "Nation" })] },
    { results: [record({ geography_code: "E12000008" })] },
  ]) {
    assert.equal(parseUkhsaHeatContext(value), null);
  }
});

test("fallback is neutral, regional and contains no user or route details", () => {
  assert.deepEqual(unavailableHeatContext(), {
    status: "unavailable",
    region: "London",
    regionType: "Government Office Region",
    message: "UKHSA London heat-health context is temporarily unavailable.",
    source: {
      label: "UKHSA data dashboard",
      url: "https://ukhsa-dashboard.data.gov.uk/weather-health-alerts/heat/london",
    },
  });
});

test("heat-context deadline settles when fetch ignores AbortSignal", { timeout: 500 }, async () => {
  const started = performance.now();
  await assert.rejects(
    fetchHeatContext({
      timeoutMs: 15,
      fetchImplementation: () => new Promise(() => undefined),
    }),
    (error) => error instanceof DOMException && error.name === "TimeoutError",
  );
  assert.ok(performance.now() - started < 250);
});

test("fetch accepts the official empty page as a valid no-alert response", async () => {
  const context = await fetchHeatContext({
    fetchImplementation: async () => Response.json({
      count: 0,
      next: null,
      previous: null,
      results: [],
    }),
  });

  assert.equal(context.status, "no_active_alert");
  assert.equal(context.stale, false);
});

test("heat-context deadline also covers stalled response-body parsing", { timeout: 500 }, async () => {
  await assert.rejects(
    fetchHeatContext({
      timeoutMs: 15,
      fetchImplementation: async () => new Response(
        new ReadableStream({ start() {} }),
        { headers: { "Content-Type": "application/json" } },
      ),
    }),
    (error) => error instanceof DOMException && error.name === "TimeoutError",
  );
});

test("handler declares a fixed official endpoint, bounded timeout and public caching", async () => {
  const [handler, component] = await Promise.all([
    readFile(new URL("../app/api/heat-context/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/HeatContext.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(handler, /export async function GET\(\)/);
  assert.match(handler, /UPSTREAM_TIMEOUT_MS\s*=\s*4_000/);
  assert.match(handler, /MAX_UPSTREAM_RESPONSE_BYTES\s*=\s*256_000/);
  assert.match(handler, /readBoundedJson\(response, MAX_UPSTREAM_RESPONSE_BYTES\)/);
  assert.match(handler, /new AbortController\(\)/);
  assert.match(handler, /signal:\s*controller\.signal/);
  assert.match(handler, /raceWithAbort/);
  assert.match(handler, /public, max-age=120, s-maxage=600/);
  assert.match(handler, /status:\s*503/);
  assert.doesNotMatch(handler, /latitude|longitude|coordinates/i);
  assert.equal(
    UKHSA_HEAT_METRIC_URL,
    "https://api.ukhsa-dashboard.data.gov.uk/themes/climate_and_environment/sub_themes/seasonal_environmental/topics/Heat-alert/geography_types/Government%20Office%20Region/geographies/London/metrics/heat-alert_headline_matrixNumber?page_size=31",
  );

  assert.match(component, /fetch\("\/api\/heat-context"/);
  assert.match(component, /regional context, not a ShadeRoute route safety score/i);
  assert.match(component, /state\.kind === "loading"/);
  assert.match(component, /state\.kind === "error"/);
  assert.match(component, /state\.kind === "ready"/);
  assert.match(component, /status === "available"/);
  assert.match(component, /status === "no_active_alert"/);
  assert.match(component, /does not mean that an individual journey is safe/i);
});
