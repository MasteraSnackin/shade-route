import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GET } from "../app/api/current-context/route.ts";
import {
  clearCurrentContextCacheForTests,
  fetchTflCurrentContext,
  fetchMetOfficeCurrentContext,
  getCurrentJourneyContext,
} from "../lib/current-context-server.ts";
import {
  parseCurrentJourneyContextData,
  parseMetOfficeCurrentContext,
  parseStreetManagerCurrentContext,
  parseTflCurrentContext,
} from "../lib/current-context.ts";

const NOW = new Date("2026-08-15T11:30:00.000Z");
const STREET_MANAGER_WINDOW_END = "2026-08-22T11:30:00.000Z";

function streetManagerFeature(reference, startsAt, endsAt, updatedAt = "2026-08-15T09:00:00Z") {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [530_000, 180_000] },
    properties: {
      work_reference_number: reference,
      street: `${reference} Street`,
      work_category_string: "Standard works",
      traffic_management_type_string: "Some carriageway incursion",
      permit_status_string: "Granted",
      start_date: startsAt,
      end_date: endsAt,
      current_traffic_management_update_date: updatedAt,
    },
  };
}

test("TfL parser keeps only the fixed pilot station and makes no step-free claim", () => {
  const context = parseTflCurrentContext(
    "waterloo",
    [
      {
        naptanCode: "940GZZLUWLO",
        message: "Waterloo: lift service is disrupted between the ticket hall and Jubilee line.",
      },
      { naptanCode: "940GZZLUKSX", message: "Another station report" },
    ],
    [
      {
        atcoCode: "940GZZLUWLO",
        stationAtcoCode: "940GZZLUWLO",
        description: "Waterloo: station access information.",
        fromDate: "2026-08-15T09:00:00Z",
        toDate: "2026-08-15T18:00:00Z",
      },
      { atcoCode: "940GZZLUKSX", description: "Unrelated record" },
    ],
    NOW.toISOString(),
  );

  assert.equal(context?.status, "available");
  assert.equal(context?.station.naptanId, "940GZZLUWLO");
  assert.deepEqual(context?.issues.map(({ kind }) => kind), ["lift", "station-disruption"]);
  assert.match(context?.message ?? "", /returned 2 relevant/i);

  const noIssues = parseTflCurrentContext("waterloo", [], [], NOW.toISOString());
  assert.match(noIssues?.message ?? "", /does not confirm step-free access/i);
});

test("Met Office parser selects the next hourly forecast and reports cloud only as a weather-code signal", () => {
  const context = parseMetOfficeCurrentContext(
    {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [-0.12, 51.5, 20] },
        properties: {
          modelRunDate: "2026-08-15T10:00Z",
          timeSeries: [
            {
              time: "2026-08-15T11:00Z",
              screenTemperature: 26.14,
              feelsLikeTemperature: 27.01,
              uvIndex: 5,
              significantWeatherCode: 1,
            },
            {
              time: "2026-08-15T12:00Z",
              screenTemperature: 27.26,
              feelsLikeTemperature: 28.19,
              uvIndex: 6,
              significantWeatherCode: 3,
            },
          ],
        },
      }],
      parameters: [],
    },
    NOW.toISOString(),
    NOW,
  );

  assert.equal(context?.forecast?.forecastAt, "2026-08-15T12:00:00.000Z");
  assert.equal(context?.forecast?.temperatureC, 27.3);
  assert.equal(context?.forecast?.uvIndex, 6);
  assert.deepEqual(context?.forecast?.cloudContext, {
    signal: "partly-cloudy",
    label: "Partly cloudy weather-code signal",
    amountPercent: null,
  });
  assert.equal(context?.sourceUpdatedAt, "2026-08-15T10:00:00.000Z");
});

test("Street Manager parser returns bounded reports without inferring footway state", () => {
  const context = parseStreetManagerCurrentContext({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [530_000, 180_000] },
      properties: {
        work_reference_number: "WORK-1",
        street: "York Road",
        work_category_string: "Standard works",
        traffic_management_type_string: "Some carriageway incursion",
        permit_status_string: "Granted",
        start_date: "2026-08-15T07:00:00Z",
        end_date: "2026-08-17T17:00:00Z",
        current_traffic_management_update_date: "2026-08-15T09:00:00Z",
      },
    }],
  }, NOW.toISOString(), NOW);

  assert.equal(context?.works.length, 1);
  assert.equal(context?.works[0].street, "York Road");
  assert.match(context?.message ?? "", /does not establish that a pavement is closed/i);
  assert.deepEqual(context?.window, {
    startsAt: NOW.toISOString(),
    endsAt: STREET_MANAGER_WINDOW_END,
    durationDays: 7,
  });
  assert.equal(context?.sourceUpdatedAt, "2026-08-15T09:00:00.000Z");
});

test("Street Manager parser keeps inclusive window overlaps and excludes historical or distant records", () => {
  const context = parseStreetManagerCurrentContext({
    type: "FeatureCollection",
    features: [
      streetManagerFeature("ENDS-AT-START", "2026-08-14T08:00:00Z", NOW.toISOString()),
      streetManagerFeature("INSIDE", "2026-08-18T08:00:00Z", "2026-08-18T12:00:00Z"),
      streetManagerFeature("STARTS-AT-END", STREET_MANAGER_WINDOW_END, "2026-08-23T08:00:00Z"),
      streetManagerFeature("HISTORICAL", "2026-08-14T08:00:00Z", "2026-08-15T11:29:59.999Z"),
      streetManagerFeature("DISTANT", "2026-08-22T11:30:00.001Z", "2026-08-23T08:00:00Z"),
      streetManagerFeature("REVERSED", "2026-08-18T12:00:00Z", "2026-08-18T08:00:00Z"),
    ],
  }, NOW.toISOString(), NOW);

  assert.deepEqual(
    context?.works.map(({ reference }) => reference),
    ["ENDS-AT-START", "INSIDE", "STARTS-AT-END"],
  );
  assert.equal(context?.recordsReturned, 3);
  assert.match(context?.message ?? "", /next 7 days/i);
  assert.match(context?.message ?? "", /2026-08-15T11:30:00\.000Z/);
  assert.match(context?.message ?? "", /2026-08-22T11:30:00\.000Z/);
  assert.match(context?.message ?? "", /does not establish that a pavement is closed/i);
});

test("Street Manager empty-window message does not infer that the pavement is open", () => {
  const context = parseStreetManagerCurrentContext({
    type: "FeatureCollection",
    features: [streetManagerFeature("HISTORICAL", "2026-08-14T08:00:00Z", "2026-08-15T11:29:59.999Z")],
  }, NOW.toISOString(), NOW);

  assert.equal(context?.recordsReturned, 0);
  assert.match(context?.message ?? "", /does not confirm that the pavement is open/i);
});

test("all providers fail neutrally without server-side configuration", async () => {
  clearCurrentContextCacheForTests();
  let calls = 0;
  const context = await getCurrentJourneyContext(
    "kings-cross",
    {},
    {
      now: NOW,
      fetchImplementation: async () => {
        calls += 1;
        throw new Error("fetch should not run");
      },
    },
  );

  assert.equal(calls, 0);
  assert.equal(context.areaId, "kings-cross");
  assert.deepEqual(
    Object.values(context.providers).map(({ status }) => status),
    ["disabled", "disabled", "disabled"],
  );
  assert.match(context.limitations.join(" "), /never changes ShadeRoute's shade ranking/i);
  assert.match(context.limitations.join(" "), /do not confirm that a footway is open or closed/i);
});

test("TfL can use explicitly enabled lower-volume anonymous access", async () => {
  const requestedUrls = [];
  const context = await fetchTflCurrentContext(
    "waterloo",
    { TFL_ALLOW_ANONYMOUS: "true" },
    {
      now: NOW,
      fetchImplementation: async (input) => {
        const url = new URL(input);
        requestedUrls.push(url);
        return Response.json([]);
      },
    },
  );

  assert.equal(context.status, "available");
  assert.equal(requestedUrls.length, 2);
  assert.ok(requestedUrls.every((url) => !url.searchParams.has("app_key")));
});

test("combined endpoint accepts only existing pilot-area IDs", async () => {
  clearCurrentContextCacheForTests();
  const invalid = await GET(new Request("http://localhost/api/current-context?area=soho"));
  assert.equal(invalid.status, 400);
  assert.deepEqual((await invalid.json()).allowedAreaIds, ["waterloo", "kings-cross"]);

  const valid = await GET(new Request("http://localhost/api/current-context?area=waterloo"));
  const body = await valid.json();
  assert.equal(valid.status, 200);
  assert.equal(body.contractVersion, 1);
  assert.equal(body.areaId, "waterloo");
  assert.equal(valid.headers.get("x-content-type-options"), "nosniff");
});

test("browser contract parser accepts the complete server response", async () => {
  clearCurrentContextCacheForTests();
  const context = await getCurrentJourneyContext("waterloo", {}, { now: NOW });
  assert.deepEqual(parseCurrentJourneyContextData(context, "waterloo"), context);

  const tfl = parseTflCurrentContext("waterloo", [], [], NOW.toISOString());
  const weather = parseMetOfficeCurrentContext({
    type: "FeatureCollection",
    features: [{
      properties: {
        modelRunDate: "2026-08-15T10:00:00Z",
        timeSeries: [{
          time: "2026-08-15T12:00:00Z",
          screenTemperature: 26,
          feelsLikeTemperature: 27,
          uvIndex: 6,
          significantWeatherCode: 3,
        }],
      },
    }],
  }, NOW.toISOString(), NOW);
  const roadworks = parseStreetManagerCurrentContext({
    type: "FeatureCollection",
    features: [streetManagerFeature("LIVE-1", NOW.toISOString(), STREET_MANAGER_WINDOW_END)],
  }, NOW.toISOString(), NOW);
  assert.ok(tfl && weather && roadworks);
  const availableContext = {
    ...context,
    providers: { tfl, weather, roadworks },
  };
  assert.deepEqual(parseCurrentJourneyContextData(availableContext, "waterloo"), availableContext);
});

test("browser contract parser rejects hostile nested provider payloads without throwing", async () => {
  clearCurrentContextCacheForTests();
  const baseline = await getCurrentJourneyContext("waterloo", {}, { now: NOW });
  const cases = [];

  const missingIssues = structuredClone(baseline);
  delete missingIssues.providers.tfl.issues;
  cases.push(missingIssues);

  const missingWorks = structuredClone(baseline);
  delete missingWorks.providers.roadworks.works;
  cases.push(missingWorks);

  const missingSource = structuredClone(baseline);
  delete missingSource.providers.weather.source;
  cases.push(missingSource);

  const malformedForecast = structuredClone(baseline);
  malformedForecast.providers.weather = {
    ...malformedForecast.providers.weather,
    status: "available",
    retrievedAt: NOW.toISOString(),
    sourceUpdatedAt: NOW.toISOString(),
    forecast: {
      forecastAt: "not-an-ISO-timestamp",
      modelRunAt: NOW.toISOString(),
      temperatureC: 25,
      feelsLikeC: 25,
      uvIndex: 999,
      weatherCode: 3,
      condition: "Partly cloudy day",
      cloudContext: {
        signal: "partly-cloudy",
        label: "Partly cloudy weather-code signal",
        amountPercent: null,
      },
    },
  };
  cases.push(malformedForecast);

  const unsafeSource = structuredClone(baseline);
  unsafeSource.providers.tfl.source.url = "javascript:alert(1)";
  cases.push(unsafeSource);

  const oversizedIssues = structuredClone(baseline);
  oversizedIssues.providers.tfl.status = "available";
  oversizedIssues.providers.tfl.retrievedAt = NOW.toISOString();
  oversizedIssues.providers.tfl.issues = Array.from({ length: 13 }, () => ({
    kind: "lift",
    summary: "A bounded lift report",
    validFrom: null,
    validTo: null,
  }));
  cases.push(oversizedIssues);

  for (const payload of cases) {
    assert.equal(parseCurrentJourneyContextData(payload, "waterloo"), null);
  }

  const throwingPayload = new Proxy({}, {
    get() {
      throw new Error("hostile getter");
    },
  });
  assert.doesNotThrow(() => parseCurrentJourneyContextData(throwingPayload, "waterloo"));
  assert.equal(parseCurrentJourneyContextData(throwingPayload, "waterloo"), null);
});

test("authenticated Street Manager settings cannot enable a public runtime provider", async () => {
  clearCurrentContextCacheForTests();
  let calls = 0;
  const context = await getCurrentJourneyContext(
    "waterloo",
    {
      STREET_MANAGER_ID_TOKEN: "header.payload.signature",
      STREET_MANAGER_WORKS_URL: "https://api.example.gov.uk/latest/geojson/works",
    },
    {
      now: NOW,
      fetchImplementation: async () => {
        calls += 1;
        return Response.json({ type: "FeatureCollection", features: [] });
      },
    },
  );

  assert.equal(calls, 0);
  assert.equal(context.providers.roadworks.status, "disabled");
  assert.match(context.providers.roadworks.message, /registered Open Data notification feed/i);
});

test("provider deadline settles even when fetch ignores AbortSignal", { timeout: 500 }, async () => {
  await assert.rejects(
    fetchMetOfficeCurrentContext(
      "waterloo",
      { MET_OFFICE_API_KEY: "server-only-test-key" },
      {
        now: NOW,
        timeoutMs: 15,
        fetchImplementation: () => new Promise(() => undefined),
      },
    ),
    (error) => error instanceof DOMException && error.name === "TimeoutError",
  );
});

test("browser component receives a stable combined contract without provider secrets", async () => {
  const [component, server, handler, exampleEnvironment] = await Promise.all([
    readFile(new URL("../components/CurrentJourneyContext.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/current-context-server.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/current-context/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.match(component, /\/api\/current-context\?area=/);
  assert.match(component, /parseCurrentJourneyContextData\(payload, areaId\)/);
  assert.doesNotMatch(component, /function validProviderState/);
  assert.match(component, /never changes ShadeRoute's shade ranking|limitations/);
  assert.match(component, /does not provide a cloud percentage/);
  assert.doesNotMatch(component, /TFL_API_KEY|MET_OFFICE_API_KEY|STREET_MANAGER_(?:API_KEY|ID_TOKEN)/);
  assert.match(server, /MAX_TFL_RESPONSE_BYTES\s*=\s*512_000/);
  assert.match(server, /MAX_WEATHER_RESPONSE_BYTES\s*=\s*512_000/);
  assert.doesNotMatch(server, /STREET_MANAGER_(?:API_KEY|ID_TOKEN|WORKS_URL)/);
  assert.doesNotMatch(exampleEnvironment, /^STREET_MANAGER_[A-Z_]+=/m);
  assert.match(server, /const roadworks = disabledStreetManagerContext\(\)/);
  assert.match(server, /readBoundedJson/);
  assert.match(server, /raceWithAbort/);
  assert.match(handler, /isCurrentContextAreaId/);
});
