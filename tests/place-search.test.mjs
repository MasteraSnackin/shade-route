import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  POST,
  resetPlaceSearchRouteStateForTests,
} from "../app/api/place-search/route.ts";
import {
  PLACE_SEARCH_AREAS,
  normalisePlaceSearchQuery,
  placeSearchArea,
  pointInsidePlaceSearchArea,
} from "../lib/place-search-contract.ts";
import {
  fetchGeoapifyResults,
  fetchOsNamesResults,
  parseGeoapifyResults,
  parseOsNamesResults,
  searchOnlinePlaces,
} from "../lib/place-search.ts";
import { parseOnlinePlaceSearchResponse } from "../lib/place-search-client.ts";

const waterloo = PLACE_SEARCH_AREAS.waterloo;
const waterlooArea = {
  ...waterloo,
  name: "Waterloo Station to St Thomas’ Hospital",
  start: { name: "Waterloo", lat: 51.50225, lon: -0.11316 },
  destination: { name: "St Thomas’", lat: 51.49906, lon: -0.1187 },
  routes: [],
};

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function placeRequest(body, headers = {}) {
  return new Request("http://localhost/api/place-search", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("place queries and areas are bounded before any provider is called", () => {
  assert.equal(normalisePlaceSearchQuery("  St   Thomas’  "), "St Thomas’");
  assert.equal(normalisePlaceSearchQuery("ab"), null);
  assert.equal(normalisePlaceSearchQuery("x".repeat(81)), null);
  assert.equal(placeSearchArea("waterloo"), PLACE_SEARCH_AREAS.waterloo);
  assert.equal(placeSearchArea("london"), null);
  assert.equal(pointInsidePlaceSearchArea(-0.11316, 51.50225, waterloo), true);
  assert.equal(pointInsidePlaceSearchArea(-0.15, 51.50225, waterloo), false);
});

test("OS Names records are converted from BNG and then filtered to the exact pilot box", () => {
  const results = parseOsNamesResults({
    results: [
      {
        GAZETTEER_ENTRY: {
          ID: "inside",
          NAME1: "Waterloo Road",
          LOCAL_TYPE: "Named_Road",
          GEOMETRY_X: 530000,
          GEOMETRY_Y: 180000,
        },
      },
      {
        GAZETTEER_ENTRY: {
          ID: "outside",
          NAME1: "Far away",
          LOCAL_TYPE: "Named_Road",
          GEOMETRY_X: 520000,
          GEOMETRY_Y: 180000,
        },
      },
    ],
  }, waterloo);

  assert.equal(results.length, 1);
  assert.equal(results[0].name, "Waterloo Road");
  assert.equal(results[0].kind, "OS Names · Named Road");
  assert.match(results[0].id, /^os-[a-z0-9]+$/);
  assert.equal(pointInsidePlaceSearchArea(results[0].lon, results[0].lat, waterloo), true);
});

test("Geoapify records require GB coordinates inside the exact selected pilot box", () => {
  const results = parseGeoapifyResults({
    results: [
      {
        place_id: "inside",
        formatted: "1 Westminster Bridge Road, London SE1",
        result_type: "building",
        country_code: "gb",
        lon: -0.116,
        lat: 51.5,
      },
      {
        place_id: "outside",
        formatted: "Outside the pilot",
        result_type: "building",
        country_code: "gb",
        lon: -0.15,
        lat: 51.5,
      },
      {
        place_id: "wrong-country",
        formatted: "Mislabelled record",
        result_type: "building",
        country_code: "fr",
        lon: -0.116,
        lat: 51.5,
      },
    ],
  }, waterloo);

  assert.deepEqual(results.map(({ name, kind }) => ({ name, kind })), [{
    name: "1 Westminster Bridge Road, London SE1",
    kind: "Geoapify · Building",
  }]);
});

test("provider adapters constrain requests and never put the OS key in its URL", async () => {
  const requests = [];
  const fetchImplementation = async (input, init) => {
    requests.push({ url: new URL(input), headers: new Headers(init?.headers) });
    if (String(input).includes("api.os.uk")) return jsonResponse({ results: [] });
    return jsonResponse({ results: [] });
  };

  await fetchOsNamesResults("Waterloo", waterloo, "os-secret", { fetchImplementation });
  await fetchGeoapifyResults("Waterloo", waterloo, "geo-secret", { fetchImplementation });

  assert.equal(requests[0].url.origin, "https://api.os.uk");
  assert.equal(requests[0].url.searchParams.has("key"), false);
  assert.equal(requests[0].headers.get("key"), "os-secret");
  assert.match(requests[0].url.searchParams.get("bounds"), /^\d+,\d+,\d+,\d+$/);
  assert.equal(requests[1].url.origin, "https://api.geoapify.com");
  assert.equal(requests[1].url.searchParams.get("filter"), `rect:${waterloo.bbox.join(",")}|countrycode:gb`);
  assert.equal(requests[1].url.searchParams.get("limit"), "16");
});

test("one valid provider keeps online search available without exposing another failure", async () => {
  const outcome = await searchOnlinePlaces("Waterloo", waterloo, {
    keys: { osNamesKey: "os-key", geoapifyKey: "geo-key" },
    fetchImplementation: async (input) => {
      if (String(input).includes("api.os.uk")) throw new Error("private provider detail");
      return jsonResponse({
        results: [{
          place_id: "one",
          formatted: "Waterloo Station, London",
          result_type: "amenity",
          country_code: "gb",
          lon: -0.11316,
          lat: 51.50225,
        }],
      });
    },
  });

  assert.equal(outcome.status, "available");
  assert.equal(outcome.results.length, 1);
  assert.doesNotMatch(JSON.stringify(outcome), /private provider detail/);
});

test("provider deadlines settle even when fetch ignores AbortSignal", { timeout: 500 }, async () => {
  const started = performance.now();
  await assert.rejects(
    fetchGeoapifyResults("Waterloo", waterloo, "key", {
      timeoutMs: 15,
      fetchImplementation: () => new Promise(() => undefined),
    }),
    (error) => error instanceof DOMException && error.name === "TimeoutError",
  );
  assert.ok(performance.now() - started < 250);
});

test("the client rejects excessive or out-of-area same-origin results", () => {
  assert.throws(() => parseOnlinePlaceSearchResponse({
    status: "available",
    results: [{
      id: "outside",
      name: "Outside",
      kind: "Online address",
      lon: -0.2,
      lat: 51.5,
    }],
  }, waterlooArea));

  assert.throws(() => parseOnlinePlaceSearchResponse({
    status: "available",
    results: Array.from({ length: 9 }, (_, index) => ({
      id: `result-${index}`,
      name: `Result ${index}`,
      kind: "Online address",
      lon: -0.116,
      lat: 51.5,
    })),
  }, waterlooArea));
});

test("the API returns stable validation and unavailable responses without provider details", async () => {
  const originalOsKey = process.env.OS_NAMES_API_KEY;
  const originalDataHubKey = process.env.OS_DATA_HUB_API_KEY;
  const originalGeoKey = process.env.GEOAPIFY_API_KEY;
  delete process.env.OS_NAMES_API_KEY;
  delete process.env.OS_DATA_HUB_API_KEY;
  delete process.env.GEOAPIFY_API_KEY;
  resetPlaceSearchRouteStateForTests();
  try {
    const shortResponse = await POST(placeRequest({ areaId: "waterloo", query: "ab" }));
    assert.equal(shortResponse.status, 400);
    assert.deepEqual(await shortResponse.json(), {
      error: "Type between 3 and 80 characters to search.",
      code: "INVALID_QUERY",
    });

    const areaResponse = await POST(placeRequest({ areaId: "london", query: "Waterloo" }));
    assert.equal(areaResponse.status, 400);
    assert.equal((await areaResponse.json()).code, "INVALID_AREA");

    const unavailableResponse = await POST(placeRequest({ areaId: "waterloo", query: "Waterloo" }));
    assert.equal(unavailableResponse.status, 200);
    assert.deepEqual(await unavailableResponse.json(), { status: "unavailable", results: [] });
  } finally {
    if (originalOsKey === undefined) delete process.env.OS_NAMES_API_KEY;
    else process.env.OS_NAMES_API_KEY = originalOsKey;
    if (originalDataHubKey === undefined) delete process.env.OS_DATA_HUB_API_KEY;
    else process.env.OS_DATA_HUB_API_KEY = originalDataHubKey;
    if (originalGeoKey === undefined) delete process.env.GEOAPIFY_API_KEY;
    else process.env.GEOAPIFY_API_KEY = originalGeoKey;
    resetPlaceSearchRouteStateForTests();
  }
});

test("the API enforces a per-client request rate", async () => {
  const originalOsKey = process.env.OS_NAMES_API_KEY;
  const originalDataHubKey = process.env.OS_DATA_HUB_API_KEY;
  const originalGeoKey = process.env.GEOAPIFY_API_KEY;
  delete process.env.OS_NAMES_API_KEY;
  delete process.env.OS_DATA_HUB_API_KEY;
  delete process.env.GEOAPIFY_API_KEY;
  resetPlaceSearchRouteStateForTests();
  try {
    let response;
    for (let index = 0; index < 31; index += 1) {
      response = await POST(placeRequest(
        { areaId: "waterloo", query: "Waterloo" },
        { "cf-connecting-ip": "192.0.2.44" },
      ));
    }
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal((await response.json()).code, "RATE_LIMITED");
  } finally {
    if (originalOsKey === undefined) delete process.env.OS_NAMES_API_KEY;
    else process.env.OS_NAMES_API_KEY = originalOsKey;
    if (originalDataHubKey === undefined) delete process.env.OS_DATA_HUB_API_KEY;
    else process.env.OS_DATA_HUB_API_KEY = originalDataHubKey;
    if (originalGeoKey === undefined) delete process.env.GEOAPIFY_API_KEY;
    else process.env.GEOAPIFY_API_KEY = originalGeoKey;
    resetPlaceSearchRouteStateForTests();
  }
});

test("the UI debounces typed queries, retains bundled results and attributes online providers", async () => {
  const [component, route, app] = await Promise.all([
    readFile(new URL("../components/LocalPlaceSearch.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/place-search/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/ShadeRouteApp.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(component, /editingQuery === null \? null : normalisePlaceSearchQuery\(editingQuery\)/);
  assert.match(component, /setTimeout\(\(\) => \{[\s\S]*?fetchOnlinePlaceSearch\(area, typedQuery/);
  assert.match(component, /\}, 350\)/);
  assert.match(component, /Online place search is unavailable\. Bundled pilot places remain available\./);
  assert.match(component, /role="combobox"/);
  assert.match(component, /\{endpointLabel\} location/);
  assert.match(component, /Enter an address, place or postcode in this pilot area, then choose a match\./);
  assert.match(component, /placeholder=\{`Enter \$\{endpointLabel\.toLocaleLowerCase\("en-GB"\)\} place or postcode`\}/);
  assert.match(component, /onEditingChange\?\.\(true\)/);
  assert.match(component, /Choose a matching result or use Map to set this location\./);
  assert.match(component, /onBlur=\{\(event\) => \{[\s\S]*?setOpen\(false\);\s*\}\s*\}\}/);
  assert.match(component, /aria-activedescendant/);
  assert.match(component, /ArrowDown/);
  assert.match(component, /Escape/);
  assert.doesNotMatch(component, /nominatim|openstreetmap\.org/i);

  assert.match(route, /MAX_REQUEST_BYTES\s*=\s*1_024/);
  assert.match(route, /CACHE_CAPACITY\s*=\s*128/);
  assert.match(route, /RATE_LIMIT_PER_CLIENT\s*=\s*30/);
  assert.match(route, /process\.env\.OS_NAMES_API_KEY/);
  assert.match(route, /process\.env\.GEOAPIFY_API_KEY/);
  assert.doesNotMatch(route, /NOMINATIM/i);
  assert.match(app, /Contains OS data © Crown copyright and database rights 2026/);
  assert.match(app, /Powered by Geoapify/);
  assert.match(app, /Location selected\. Compare routes when both endpoints are ready\./);
  assert.match(app, /Choose a matching start and destination result, or set the point on the map/);
  assert.match(app, /Change locations/);
  assert.match(app, /onEditingChange=\{handleOriginEditingChange\}/);
  assert.match(app, /onEditingChange=\{handleDestinationEditingChange\}/);
});
