import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  assessOfflinePilotStorage,
  buildOfflinePilotAssetList,
  buildOfflinePilotIntegrityManifest,
  createOfflineWorkerRemovalRequest,
  createOfflineWorkerPreparationRequest,
  createOfflineWorkerVerificationRequest,
  OFFLINE_PILOT_DATA_ASSETS,
  OFFLINE_PILOT_DATA_BYTES,
  OFFLINE_PILOT_PACK_VERSION,
  OFFLINE_PILOT_STATIC_ASSET_INTEGRITY,
  OFFLINE_PILOT_STORAGE_KEY,
  offlinePilotIntegrityManifestId,
  offlinePilotManifestId,
  offlineWorkerResponseMatchesRequest,
  readVerifiedOfflinePilot,
  removeVerifiedOfflinePilot,
  writeVerifiedOfflinePilot,
} from "../lib/offline-pilot.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function serviceWorkerHarness(source, options = {}) {
  const {
    failingPath = null,
    responseBody = (path) => `asset:${path}`,
  } = options;
  const origin = "https://shade.example";
  const handlers = {};
  const stores = new Map();
  const cacheKey = (value) => {
    const input = typeof value === "string" ? value : value.url;
    const url = new URL(input, origin);
    return `${url.pathname}${url.search}`;
  };
  class LocalRequest {
    constructor(input, init = {}) {
      this.url = new URL(typeof input === "string" ? input : input.url, origin).href;
      this.method = init.method ?? input.method ?? "GET";
      this.cache = init.cache;
      this.credentials = init.credentials;
    }
  }
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async put(request, response) {
          entries.set(cacheKey(request), response.clone());
        },
        async match(request) {
          return entries.get(cacheKey(request))?.clone();
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  const self = {
    location: { origin },
    clients: { async claim() {} },
    async skipWaiting() {},
    addEventListener(type, handler) {
      handlers[type] = handler;
    },
  };
  runInNewContext(source, {
    self,
    caches,
    Request: LocalRequest,
    Response,
    URL,
    Date,
    Error,
    Promise,
    TextEncoder,
    crypto: webcrypto,
    fetch: async (request) => {
      const path = cacheKey(request);
      return path === failingPath
        ? new Response("Unavailable", { status: 503 })
        : new Response(responseBody(path), { status: 200 });
    },
  });
  return { caches, handlers, stores, LocalRequest };
}

async function dispatchWorkerMessage(harness, data) {
  let response;
  let pending = Promise.resolve();
  harness.handlers.message({
    data,
    ports: [{ postMessage(value) { response = value; } }],
    waitUntil(value) { pending = value; },
  });
  await pending;
  return response;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function syntheticIntegrityManifest(
  areaId,
  paths,
  responseBody = (path) => `asset:${path}`,
) {
  const assets = [...paths].sort().map((path) => {
    const body = responseBody(path);
    return {
      path,
      byteLength: Buffer.byteLength(body),
      sha256: sha256(body),
    };
  });
  return {
    areaId,
    packVersion: OFFLINE_PILOT_PACK_VERSION,
    manifestId: await offlinePilotIntegrityManifestId(areaId, assets),
    assets,
  };
}

test("each offline manifest contains only the selected pilot data plus shared runtime assets", () => {
  const runtime = [
    "https://shade.example/_next/static/app-123.js",
    "/_next/static/app-456.css",
    "/_next/static/scoring-worker-abc.js",
    "/api/route?origin=private",
    "https://third-party.example/tracker.js",
  ];
  const waterloo = buildOfflinePilotAssetList("waterloo", runtime, "https://shade.example");

  for (const asset of OFFLINE_PILOT_DATA_ASSETS.waterloo) assert.ok(waterloo.includes(asset));
  for (const asset of OFFLINE_PILOT_DATA_ASSETS["kings-cross"]) {
    assert.equal(waterloo.includes(asset), false);
  }
  assert.ok(waterloo.includes("/data/pilot-routes.json"));
  assert.ok(waterloo.includes("/app-icon.svg"));
  assert.ok(waterloo.includes("/app-icon-192.png"));
  assert.ok(waterloo.includes("/app-icon-512.png"));
  assert.ok(waterloo.includes("/app-icon-maskable-512.png"));
  assert.ok(waterloo.includes("/apple-touch-icon.png"));
  assert.ok(waterloo.includes("/manifest.webmanifest"));
  assert.ok(waterloo.includes("/_next/static/app-123.js"));
  assert.ok(waterloo.includes("/_next/static/app-456.css"));
  assert.equal(waterloo.some((asset) => asset.startsWith("/api/")), false);
  assert.equal(waterloo.some((asset) => asset.includes("tracker")), false);
  assert.equal(waterloo.length, new Set(waterloo).size);
  assert.deepEqual(waterloo, [...waterloo].sort());
});

test("the versioned static manifest matches every selected-pilot byte and SHA-256 digest", async () => {
  for (const areaId of ["waterloo", "kings-cross"]) {
    const metadata = JSON.parse(
      await readFile(new URL(`../public/data/${areaId}-heights.json`, import.meta.url), "utf8"),
    );
    const declared = OFFLINE_PILOT_DATA_ASSETS[areaId];
    for (const file of [
      metadata.validityFile,
      metadata.terrainFile,
      metadata.minimumSurfaceFile,
      metadata.maximumSurfaceFile,
    ]) {
      assert.ok(declared.includes(`/data/${file}`), `${areaId} is missing ${file}`);
    }
    assert.ok(declared.includes(`/data/${areaId}-heights.bin`));
    assert.ok(declared.includes(`/data/${areaId}-map.json`));
    assert.ok(declared.includes(`/data/context-${areaId}.json`));

    for (const asset of [
      "/favicon.svg",
      "/app-icon.svg",
      "/app-icon-192.png",
      "/app-icon-512.png",
      "/app-icon-maskable-512.png",
      "/apple-touch-icon.png",
      "/data/pilot-routes.json",
      ...declared,
    ]) {
      const contents = await readFile(new URL(`../public${asset}`, import.meta.url));
      const expected = OFFLINE_PILOT_STATIC_ASSET_INTEGRITY[asset];
      assert.ok(expected, `${asset} has no pinned integrity entry`);
      assert.equal(contents.byteLength, expected.byteLength, `${asset} byte length changed`);
      assert.equal(sha256(contents), expected.sha256, `${asset} SHA-256 changed`);
    }

    const declaredBytes = await Promise.all(
      ["/data/pilot-routes.json", ...declared].map(async (asset) =>
        (await stat(new URL(`../public${asset}`, import.meta.url))).size),
    );
    assert.equal(
      declaredBytes.reduce((sum, bytes) => sum + bytes, 0),
      OFFLINE_PILOT_DATA_BYTES[areaId],
    );
  }
});

test("the complete manifest pins generated runtime assets by bytes and SHA-256", async () => {
  const paths = buildOfflinePilotAssetList(
    "waterloo",
    ["/_next/static/app.js", "/_next/static/app.css"],
    "https://shade.example",
  );
  const bodies = new Map([
    ["/", "<!doctype html><title>ShadeRoute</title>"],
    ["/manifest.webmanifest", '{"name":"ShadeRoute London pilot"}'],
    ["/_next/static/app.js", "console.log('shade-route');"],
    ["/_next/static/app.css", ":root{color-scheme:light}"],
  ]);
  const fetched = [];
  const fetchRuntime = async (input) => {
    const path = new URL(input).pathname;
    fetched.push(path);
    return new Response(bodies.get(path), { status: 200 });
  };

  const one = await buildOfflinePilotIntegrityManifest(
    "waterloo",
    paths,
    "https://shade.example",
    fetchRuntime,
  );
  const two = await buildOfflinePilotIntegrityManifest(
    "waterloo",
    [...paths].reverse(),
    "https://shade.example",
    fetchRuntime,
  );

  assert.match(one.manifestId, /^sha256-[0-9a-f]{64}$/);
  assert.deepEqual(one, two);
  assert.deepEqual(
    [...new Set(fetched)].sort(),
    ["/", "/_next/static/app.css", "/_next/static/app.js", "/manifest.webmanifest"],
    "release-pinned public files should not be fetched to construct the manifest",
  );
  for (const [path, body] of bodies) {
    const entry = one.assets.find((candidate) => candidate.path === path);
    assert.equal(entry.byteLength, Buffer.byteLength(body));
    assert.equal(entry.sha256, sha256(body));
  }
});

test("verified readiness is versioned, persisted per pilot and rejects malformed records", () => {
  const storage = memoryStorage();
  const assets = buildOfflinePilotAssetList("waterloo", ["/_next/static/app.js"]);
  const record = {
    areaId: "waterloo",
    packVersion: OFFLINE_PILOT_PACK_VERSION,
    workerVersion: "worker-v1",
    manifestId: offlinePilotManifestId(assets),
    integrityManifestId: `sha256-${"a".repeat(64)}`,
    assetCount: assets.length,
    verifiedAt: "2026-08-12T14:15:00.000Z",
  };

  writeVerifiedOfflinePilot(record, storage);
  const kingsCrossRecord = {
    ...record,
    areaId: "kings-cross",
    manifestId: offlinePilotManifestId(
      buildOfflinePilotAssetList("kings-cross", ["/_next/static/app.js"]),
    ),
  };
  writeVerifiedOfflinePilot(kingsCrossRecord, storage);
  assert.deepEqual(readVerifiedOfflinePilot("waterloo", storage), record);
  assert.deepEqual(readVerifiedOfflinePilot("kings-cross", storage), kingsCrossRecord);
  assert.equal(JSON.parse(storage.getItem(OFFLINE_PILOT_STORAGE_KEY)).schemaVersion, 2);

  removeVerifiedOfflinePilot("waterloo", storage);
  assert.deepEqual(readVerifiedOfflinePilot("kings-cross", storage), kingsCrossRecord);
  assert.equal(readVerifiedOfflinePilot("waterloo", storage), null);
  removeVerifiedOfflinePilot("kings-cross", storage);
  assert.equal(storage.getItem(OFFLINE_PILOT_STORAGE_KEY), null);

  storage.setItem(OFFLINE_PILOT_STORAGE_KEY, JSON.stringify({
    schemaVersion: 99,
    pilots: { waterloo: record },
  }));
  assert.equal(readVerifiedOfflinePilot("waterloo", storage), null);
  assert.throws(
    () => writeVerifiedOfflinePilot(record, storage),
    /unsupported version.*not overwritten/i,
  );
});

test("manifest fingerprints and worker requests are deterministic and version-bound", async () => {
  const one = ["/b", "/a", "/a"];
  const two = ["/a", "/a", "/b"];
  assert.equal(offlinePilotManifestId(one), offlinePilotManifestId(two));
  assert.notEqual(offlinePilotManifestId(one), offlinePilotManifestId(["/a", "/c"]));

  const manifest = await syntheticIntegrityManifest("waterloo", ["/", "/data/a"]);

  assert.deepEqual(
    createOfflineWorkerPreparationRequest("waterloo", manifest, "request-1"),
    {
      type: "PREPARE_PILOT_PACK",
      protocolVersion: 2,
      requestId: "request-1",
      areaId: "waterloo",
      packVersion: OFFLINE_PILOT_PACK_VERSION,
      manifest,
    },
  );
  assert.deepEqual(
    createOfflineWorkerVerificationRequest(
      "waterloo",
      ["/", "/data/a"],
      manifest.manifestId,
      "verify-1",
    ),
    {
      type: "VERIFY_PILOT_PACK",
      protocolVersion: 2,
      requestId: "verify-1",
      areaId: "waterloo",
      packVersion: OFFLINE_PILOT_PACK_VERSION,
      assets: ["/", "/data/a"],
      integrityManifestId: manifest.manifestId,
    },
  );
  assert.deepEqual(createOfflineWorkerRemovalRequest("kings-cross", "remove-1"), {
    type: "REMOVE_PILOT_PACK",
    protocolVersion: 2,
    requestId: "remove-1",
    areaId: "kings-cross",
  });
});

test("storage preflight is advisory, bounded and selected-pilot specific", () => {
  assert.deepEqual(assessOfflinePilotStorage("waterloo"), {
    status: "unknown",
    requiredDataBytes: OFFLINE_PILOT_DATA_BYTES.waterloo,
    availableBytes: null,
  });
  assert.equal(
    assessOfflinePilotStorage("waterloo", { quota: 20_000_000, usage: 1_000_000 }).status,
    "sufficient",
  );
  assert.deepEqual(
    assessOfflinePilotStorage("kings-cross", { quota: 14_000_000, usage: 2_000_000 }),
    {
      status: "low",
      requiredDataBytes: OFFLINE_PILOT_DATA_BYTES["kings-cross"],
      availableBytes: 12_000_000,
    },
  );
  assert.equal(
    assessOfflinePilotStorage("waterloo", { quota: 1, usage: 2 }).status,
    "unknown",
  );
});

test("MessageChannel replies must match the request, area and success shape", async () => {
  const manifest = await syntheticIntegrityManifest("waterloo", ["/", "/data/a"]);
  const request = createOfflineWorkerPreparationRequest("waterloo", manifest, "bound-request");
  const response = {
    ok: true,
    type: "PACK_PREPARED",
    requestId: "bound-request",
    areaId: "waterloo",
    packVersion: OFFLINE_PILOT_PACK_VERSION,
    workerVersion: "worker-v1",
    assetCount: 2,
    integrityManifestId: manifest.manifestId,
  };
  assert.equal(offlineWorkerResponseMatchesRequest(request, response), true);
  assert.equal(
    offlineWorkerResponseMatchesRequest(request, { ...response, requestId: "stale-request" }),
    false,
  );
  assert.equal(
    offlineWorkerResponseMatchesRequest(request, { ...response, areaId: "kings-cross" }),
    false,
  );
  assert.equal(
    offlineWorkerResponseMatchesRequest(request, { ...response, type: "PACK_VERIFIED" }),
    false,
  );
  assert.equal(offlineWorkerResponseMatchesRequest(request, "not-a-response"), false);
});

test("the service worker stages and verifies replacements without caching online-only APIs", async () => {
  const source = await readFile(new URL("../public/shade-route-sw.js", import.meta.url), "utf8");
  const installHandler = source.match(/self\.addEventListener\("install"[\s\S]*?\n\}\);/)?.[0] ?? "";
  const fetchHandler = source.match(/self\.addEventListener\("fetch"[\s\S]*$/)?.[0] ?? "";

  assert.match(source, /PREPARE_PILOT_PACK/);
  assert.match(source, /VERIFY_PILOT_PACK/);
  assert.match(source, /REMOVE_PILOT_PACK/);
  assert.match(source, /STAGING_MARKER/);
  assert.match(source, /cacheContainsEveryAsset\(finalCache, manifest\)/);
  assert.match(source, /responseMatchesAsset/);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(source, /oldReadyCaches/);
  assert.doesNotMatch(installHandler, /event\.waitUntil\(self\.skipWaiting\(\)\)/);
  assert.match(source, /ACTIVATE_OFFLINE_UPDATE/);
  assert.match(fetchHandler, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.doesNotMatch(fetchHandler, /cache\.put|caches\.open\([^)]*api/i);
});

test("service-worker preparation is atomic and leaves API requests untouched", async () => {
  const source = await readFile(new URL("../public/shade-route-sw.js", import.meta.url), "utf8");
  const paths = ["/", "/data/pilot-routes.json", "/data/waterloo-map.json"];
  const manifest = await syntheticIntegrityManifest("waterloo", paths);
  const request = createOfflineWorkerPreparationRequest(
    "waterloo",
    manifest,
    "atomic-test",
  );
  const harness = serviceWorkerHarness(source);
  const oldCache = await harness.caches.open(
    `shaderoute-offline-pilot:waterloo:ready:${OFFLINE_PILOT_PACK_VERSION}:old`,
  );
  await oldCache.put("/", new Response("old", { status: 200 }));
  const otherAreaCacheName =
    `shaderoute-offline-pilot:kings-cross:ready:${OFFLINE_PILOT_PACK_VERSION}:keep`;
  const otherAreaCache = await harness.caches.open(otherAreaCacheName);
  await otherAreaCache.put("/", new Response("other pilot", { status: 200 }));

  const prepared = await dispatchWorkerMessage(harness, request);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.type, "PACK_PREPARED");
  assert.equal(prepared.integrityManifestId, manifest.manifestId);
  const cacheNames = await harness.caches.keys();
  assert.equal(cacheNames.some((name) => name.endsWith(":old")), false);
  assert.equal(cacheNames.some((name) => name.includes(":staging:")), false);
  assert.equal(
    cacheNames.filter((name) => name.startsWith("shaderoute-offline-pilot:waterloo:ready:")).length,
    1,
  );
  assert.ok(cacheNames.includes(otherAreaCacheName));

  const verified = await dispatchWorkerMessage(
    harness,
    createOfflineWorkerVerificationRequest(
      "waterloo",
      paths,
      manifest.manifestId,
      "verify-test",
    ),
  );
  assert.equal(verified.ok, true);
  assert.equal(verified.type, "PACK_VERIFIED");
  assert.equal(verified.integrityManifestId, manifest.manifestId);

  let intercepted = false;
  harness.handlers.fetch({
    request: new harness.LocalRequest("/api/route"),
    respondWith() { intercepted = true; },
  });
  assert.equal(intercepted, false);

  const failureHarness = serviceWorkerHarness(source, {
    failingPath: "/data/waterloo-map.json",
  });
  const previous = await failureHarness.caches.open(
    `shaderoute-offline-pilot:waterloo:ready:${OFFLINE_PILOT_PACK_VERSION}:previous`,
  );
  await previous.put("/", new Response("previous", { status: 200 }));
  const failed = await dispatchWorkerMessage(failureHarness, request);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "download-failed");
  assert.ok((await failureHarness.caches.keys()).some((name) => name.endsWith(":previous")));
  assert.equal((await failureHarness.caches.keys()).some((name) => name.includes(":staging:")), false);
});

test("200 responses with truncated or corrupt bytes never replace a verified pack", async (t) => {
  const source = await readFile(new URL("../public/shade-route-sw.js", import.meta.url), "utf8");
  const paths = ["/", "/data/pilot-routes.json", "/data/waterloo-map.json"];
  const manifest = await syntheticIntegrityManifest("waterloo", paths);
  const request = createOfflineWorkerPreparationRequest("waterloo", manifest, "corruption-test");

  for (const [name, corruptBody] of [
    ["truncated", "asset:/data/waterloo-map.jso"],
    ["same-length corruption", "Asset:/data/waterloo-map.json"],
  ]) {
    await t.test(name, async () => {
      const harness = serviceWorkerHarness(source, {
        responseBody: (path) => path === "/data/waterloo-map.json"
          ? corruptBody
          : `asset:${path}`,
      });
      const previousName = `shaderoute-offline-pilot:waterloo:ready:${OFFLINE_PILOT_PACK_VERSION}:previous`;
      const previous = await harness.caches.open(previousName);
      await previous.put("/", new Response("previous", { status: 200 }));

      const failed = await dispatchWorkerMessage(harness, request);
      assert.equal(failed.ok, false);
      assert.equal(failed.code, "verification-failed");
      const cacheNames = await harness.caches.keys();
      assert.ok(cacheNames.includes(previousName), "the previous pack must survive a corrupt refresh");
      assert.equal(cacheNames.some((cacheName) => cacheName.includes(":staging:")), false);
      assert.deepEqual(
        cacheNames.filter((cacheName) => cacheName.includes(":ready:")),
        [previousName],
      );
    });
  }
});

test("verification detects and removes a ready cache corrupted after promotion", async () => {
  const source = await readFile(new URL("../public/shade-route-sw.js", import.meta.url), "utf8");
  const paths = ["/", "/data/pilot-routes.json", "/data/waterloo-map.json"];
  const manifest = await syntheticIntegrityManifest("waterloo", paths);
  const harness = serviceWorkerHarness(source);
  const prepared = await dispatchWorkerMessage(
    harness,
    createOfflineWorkerPreparationRequest("waterloo", manifest, "prepare-before-corruption"),
  );
  assert.equal(prepared.ok, true);

  const readyName = (await harness.caches.keys()).find((name) => name.includes(":ready:"));
  assert.ok(readyName);
  const ready = await harness.caches.open(readyName);
  await ready.put("/data/waterloo-map.json", new Response("truncated", { status: 200 }));

  const verified = await dispatchWorkerMessage(
    harness,
    createOfflineWorkerVerificationRequest(
      "waterloo",
      paths,
      manifest.manifestId,
      "verify-after-corruption",
    ),
  );
  assert.equal(verified.ok, false);
  assert.equal(verified.code, "verification-failed");
  assert.equal((await harness.caches.keys()).includes(readyName), false);
});

test("service-worker removal deletes only the selected area's ready and staging caches", async () => {
  const source = await readFile(new URL("../public/shade-route-sw.js", import.meta.url), "utf8");
  const harness = serviceWorkerHarness(source);
  const cacheNames = [
    `shaderoute-offline-pilot:waterloo:ready:${OFFLINE_PILOT_PACK_VERSION}:ready-one`,
    `shaderoute-offline-pilot:waterloo:staging:${OFFLINE_PILOT_PACK_VERSION}:stage-one`,
    `shaderoute-offline-pilot:kings-cross:ready:${OFFLINE_PILOT_PACK_VERSION}:ready-two`,
    `shaderoute-offline-pilot:kings-cross:staging:${OFFLINE_PILOT_PACK_VERSION}:stage-two`,
    "shaderoute-offline-pilot:waterloo:other:keep-this",
    "unrelated-application-cache",
  ];
  for (const cacheName of cacheNames) {
    const cache = await harness.caches.open(cacheName);
    await cache.put("/", new Response(cacheName, { status: 200 }));
  }

  const removed = await dispatchWorkerMessage(
    harness,
    createOfflineWorkerRemovalRequest("waterloo", "remove-waterloo"),
  );
  assert.equal(removed.ok, true);
  assert.equal(removed.type, "PACK_REMOVED");
  assert.equal(removed.areaId, "waterloo");
  assert.equal(removed.removedCacheCount, 2);

  const remaining = await harness.caches.keys();
  assert.equal(remaining.includes(cacheNames[0]), false);
  assert.equal(remaining.includes(cacheNames[1]), false);
  assert.equal(remaining.includes(cacheNames[2]), true);
  assert.equal(remaining.includes(cacheNames[3]), true);
  assert.equal(remaining.includes(cacheNames[4]), true);
  assert.equal(remaining.includes(cacheNames[5]), true);
});

test("the preparation component makes readiness and online-only limits explicit", async () => {
  const source = await readFile(
    new URL("../components/OfflinePilotPreparation.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /Prepare this pilot for offline use/);
  assert.match(source, /Verified on this device/);
  assert.match(source, /Custom starts and destinations remain online-only/);
  assert.match(source, /Live heat information also needs a connection/);
  assert.match(source, /Browser or device storage controls may clear it/);
  assert.match(source, /verify the pack before relying on offline access/);
  assert.match(source, /This device reports that it is offline/);
  assert.match(source, /assessOfflinePilotStorage/);
  assert.match(source, /offlineWorkerResponseMatchesRequest/);
  assert.match(source, /operationInProgressRef\.current/);
  assert.match(source, /if \(!mountedRef\.current\) return/);
  assert.match(source, /Apply offline support update/);
  assert.match(source, /Remove \$\{areaName\} offline pilot pack/);
  assert.match(source, /worker confirms[\s\S]*removeVerifiedOfflinePilot/);
  assert.match(source, /buildOfflinePilotIntegrityManifest/);
  assert.match(source, /createOfflineWorkerVerificationRequest/);
  assert.match(source, /integrity-checked/);
  assert.match(source, /writeVerifiedOfflinePilot/);
  assert.match(source, /scoring-worker\.ts\?worker&url/);
  assert.match(source, /shadow-worker\.ts\?worker&url/);
  assert.match(source, /maplibre-gl-worker\.mjs\?worker&url/);
  assert.match(source, /new URL\(mapLibreWorkerUrl, origin\)\.toString\(\)/);
  assert.match(source, /Offline pack verified — continue to the field route reference/);
  assert.match(source, /Continue to route selection/);

  const styles = await readFile(
    new URL("../components/OfflinePilotPreparation.module.css", import.meta.url),
    "utf8",
  );
  assert.match(styles, /\.actions button\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /\.fieldAction\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});
