/* ShadeRoute offline pilot service worker.
 * Pilot packs are prepared only after an explicit client message. */

const PROTOCOL_VERSION = 2;
const WORKER_VERSION = "shade-route-offline-2026-08-15-v4";
const SUPPORTED_PACK_VERSION = "pilot-data-2026-08-15-v4";
const CACHE_PREFIX = "shaderoute-offline-pilot";
const STAGING_MARKER = ":staging:";
const READY_MARKER = ":ready:";
const MAXIMUM_ASSETS = 80;
const MAXIMUM_ASSET_BYTES = 25_000_000;
const MAXIMUM_PACK_BYTES = 64_000_000;
const MANIFEST_CACHE_PATH = "/.shaderoute/offline-integrity-manifest.json";

function safePart(value) {
  return typeof value === "string" && /^[a-z0-9._-]{1,100}$/i.test(value);
}

function validAreaId(value) {
  return value === "waterloo" || value === "kings-cross";
}

function reply(port, payload) {
  if (port) port.postMessage(payload);
}

function readyCachePrefix(areaId, packVersion) {
  return `${CACHE_PREFIX}:${areaId}${READY_MARKER}${packVersion}:`;
}

function normaliseAssetPath(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value, self.location.origin);
  } catch {
    return null;
  }
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/.shaderoute/") ||
    url.pathname === "/shade-route-sw.js"
  ) return null;
  return `${url.pathname}${url.search}`;
}

function validAssetPaths(assets) {
  if (!Array.isArray(assets) || assets.length < 1 || assets.length > MAXIMUM_ASSETS) return null;
  const paths = [];
  for (const value of assets) {
    const path = normaliseAssetPath(value);
    if (!path) return null;
    paths.push(path);
  }
  if (new Set(paths).size !== paths.length) return null;
  return paths.sort();
}

function validIntegrityId(value) {
  return typeof value === "string" && /^sha256-[0-9a-f]{64}$/.test(value);
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
}

function canonicalIntegrityManifest(areaId, packVersion, assets) {
  return JSON.stringify([
    areaId,
    packVersion,
    assets.map(({ path, byteLength, sha256 }) => [path, byteLength, sha256]),
  ]);
}

async function validateIntegrityManifest(value, areaId, packVersion) {
  if (
    !value ||
    typeof value !== "object" ||
    value.areaId !== areaId ||
    value.packVersion !== packVersion ||
    !validIntegrityId(value.manifestId) ||
    !Array.isArray(value.assets) ||
    value.assets.length < 1 ||
    value.assets.length > MAXIMUM_ASSETS
  ) return null;

  let totalBytes = 0;
  const assets = [];
  for (const candidate of value.assets) {
    if (!candidate || typeof candidate !== "object") return null;
    const path = normaliseAssetPath(candidate.path);
    if (
      !path ||
      path !== candidate.path ||
      !Number.isSafeInteger(candidate.byteLength) ||
      candidate.byteLength < 1 ||
      candidate.byteLength > MAXIMUM_ASSET_BYTES ||
      typeof candidate.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(candidate.sha256)
    ) return null;
    totalBytes += candidate.byteLength;
    if (totalBytes > MAXIMUM_PACK_BYTES) return null;
    assets.push({ path, byteLength: candidate.byteLength, sha256: candidate.sha256 });
  }
  assets.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(assets.map(({ path }) => path)).size !== assets.length) return null;

  const canonical = new TextEncoder().encode(
    canonicalIntegrityManifest(areaId, packVersion, assets),
  );
  const manifestId = `sha256-${await sha256Hex(canonical)}`;
  if (manifestId !== value.manifestId) return null;
  return { areaId, packVersion, manifestId, assets };
}

function validRequest(message) {
  if (
    !message ||
    typeof message !== "object" ||
    message.protocolVersion !== PROTOCOL_VERSION ||
    !safePart(message.requestId) ||
    !validAreaId(message.areaId)
  ) return false;
  if (message.type === "REMOVE_PILOT_PACK") return true;
  return (
    (message.type === "PREPARE_PILOT_PACK" || message.type === "VERIFY_PILOT_PACK") &&
    safePart(message.packVersion)
  );
}

async function responseMatchesAsset(response, asset) {
  if (!response || !response.ok || response.type === "opaque") return false;
  try {
    const bytes = await response.clone().arrayBuffer();
    return bytes.byteLength === asset.byteLength && await sha256Hex(bytes) === asset.sha256;
  } catch {
    return false;
  }
}

async function cacheContainsEveryAsset(cache, manifest) {
  for (const asset of manifest.assets) {
    const response = await cache.match(asset.path, { ignoreSearch: false });
    if (!(await responseMatchesAsset(response, asset))) return false;
  }
  return true;
}

async function preparePilotPack(message, port) {
  if (message.packVersion !== SUPPORTED_PACK_VERSION) {
    reply(port, {
      ok: false,
      type: "PACK_FAILED",
      requestId: message.requestId,
      areaId: message.areaId,
      code: "unsupported-version",
      message: "Offline support has an update waiting. Apply it before preparing this pilot.",
    });
    return;
  }
  let manifest = null;
  try {
    manifest = await validateIntegrityManifest(
      message.manifest,
      message.areaId,
      message.packVersion,
    );
  } catch {
    reply(port, {
      ok: false,
      type: "PACK_FAILED",
      requestId: message.requestId,
      areaId: message.areaId,
      code: "verification-failed",
      message: "This browser could not verify the offline integrity manifest.",
    });
    return;
  }
  if (!manifest) {
    reply(port, {
      ok: false,
      type: "PACK_FAILED",
      requestId: message.requestId,
      areaId: message.areaId,
      code: "invalid-request",
      message: "The offline integrity manifest is incomplete or invalid.",
    });
    return;
  }

  const generation = `${Date.now()}-${message.requestId}`;
  const stagingName = `${CACHE_PREFIX}:${message.areaId}${STAGING_MARKER}${message.packVersion}:${generation}`;
  const finalName = `${readyCachePrefix(message.areaId, message.packVersion)}${generation}`;
  let finalCreated = false;

  try {
    const staging = await caches.open(stagingName);
    for (const asset of manifest.assets) {
      const request = new Request(asset.path, {
        cache: "reload",
        credentials: "same-origin",
      });
      const response = await fetch(request);
      if (!response.ok || response.type === "opaque") {
        throw new Error("download-failed");
      }
      if (!(await responseMatchesAsset(response, asset))) {
        throw new Error("verification-failed");
      }
      await staging.put(asset.path, response.clone());
    }
    if (!(await cacheContainsEveryAsset(staging, manifest))) {
      throw new Error("verification-failed");
    }
    await staging.put(
      MANIFEST_CACHE_PATH,
      new Response(JSON.stringify(manifest), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
    );

    const finalCache = await caches.open(finalName);
    finalCreated = true;
    for (const asset of manifest.assets) {
      const response = await staging.match(asset.path, { ignoreSearch: false });
      if (!response) throw new Error("verification-failed");
      await finalCache.put(asset.path, response);
    }
    const storedManifest = await staging.match(MANIFEST_CACHE_PATH, { ignoreSearch: false });
    if (!storedManifest) throw new Error("verification-failed");
    await finalCache.put(MANIFEST_CACHE_PATH, storedManifest);
    if (!(await cacheContainsEveryAsset(finalCache, manifest))) {
      throw new Error("verification-failed");
    }

    // The previously verified pack remains available until its complete
    // replacement has been copied and checked.
    const cacheNames = await caches.keys();
    const oldReadyCaches = cacheNames.filter(
      (name) => name.startsWith(`${CACHE_PREFIX}:${message.areaId}${READY_MARKER}`) && name !== finalName,
    );
    await Promise.all(oldReadyCaches.map((name) => caches.delete(name)));
    await caches.delete(stagingName);

    reply(port, {
      ok: true,
      type: "PACK_PREPARED",
      requestId: message.requestId,
      areaId: message.areaId,
      packVersion: message.packVersion,
      workerVersion: WORKER_VERSION,
      assetCount: manifest.assets.length,
      integrityManifestId: manifest.manifestId,
    });
  } catch (error) {
    await caches.delete(stagingName);
    if (finalCreated) await caches.delete(finalName);
    const verificationFailed = error instanceof Error && error.message === "verification-failed";
    reply(port, {
      ok: false,
      type: "PACK_FAILED",
      requestId: message.requestId,
      areaId: message.areaId,
      code: verificationFailed ? "verification-failed" : "download-failed",
      message: verificationFailed
        ? "The downloaded pilot pack could not be verified. The previous verified pack was kept."
        : "The pilot pack could not be downloaded. Check the connection and try again.",
    });
  }
}

async function verifyPilotPack(message, port) {
  const assets = validAssetPaths(message.assets);
  if (
    !assets ||
    message.packVersion !== SUPPORTED_PACK_VERSION ||
    !validIntegrityId(message.integrityManifestId)
  ) {
    reply(port, {
      ok: false,
      type: "PACK_MISSING",
      requestId: message.requestId,
      areaId: message.areaId,
      code: "pack-missing",
      message: "This pilot is not prepared for offline use on this device.",
    });
    return;
  }
  const names = (await caches.keys())
    .filter((name) => name.startsWith(readyCachePrefix(message.areaId, message.packVersion)))
    .reverse();
  let integrityFailure = false;
  for (const name of names) {
    const cache = await caches.open(name);
    let manifest = null;
    try {
      const stored = await cache.match(MANIFEST_CACHE_PATH, { ignoreSearch: false });
      if (stored?.ok) {
        manifest = await validateIntegrityManifest(
          await stored.json(),
          message.areaId,
          message.packVersion,
        );
      }
    } catch {
      manifest = null;
    }
    if (!manifest) {
      integrityFailure = true;
      await caches.delete(name);
      continue;
    }
    const manifestPaths = manifest.assets.map(({ path }) => path);
    if (
      manifest.manifestId !== message.integrityManifestId ||
      manifestPaths.length !== assets.length ||
      manifestPaths.some((path, index) => path !== assets[index])
    ) {
      integrityFailure = true;
      await caches.delete(name);
      continue;
    }

    if (await cacheContainsEveryAsset(cache, manifest)) {
      reply(port, {
        ok: true,
        type: "PACK_VERIFIED",
        requestId: message.requestId,
        areaId: message.areaId,
        packVersion: message.packVersion,
        workerVersion: WORKER_VERSION,
        assetCount: manifest.assets.length,
        integrityManifestId: manifest.manifestId,
      });
      return;
    }
    integrityFailure = true;
    await caches.delete(name);
  }
  reply(port, {
    ok: false,
    type: integrityFailure ? "PACK_FAILED" : "PACK_MISSING",
    requestId: message.requestId,
    areaId: message.areaId,
    code: integrityFailure ? "verification-failed" : "pack-missing",
    message: integrityFailure
      ? "The saved pilot pack failed its integrity check and was removed. Prepare it again before relying on offline access."
      : "This pilot is not prepared for offline use on this device.",
  });
}

function selectedAreaCache(name, areaId) {
  const areaPrefix = `${CACHE_PREFIX}:${areaId}`;
  return name.startsWith(`${areaPrefix}${READY_MARKER}`) ||
    name.startsWith(`${areaPrefix}${STAGING_MARKER}`);
}

async function removePilotPack(message, port) {
  try {
    const cacheNames = await caches.keys();
    const selectedCaches = cacheNames.filter((name) => selectedAreaCache(name, message.areaId));
    await Promise.all(selectedCaches.map((name) => caches.delete(name)));
    const remaining = (await caches.keys()).filter((name) => selectedAreaCache(name, message.areaId));
    if (remaining.length) throw new Error("removal-failed");
    reply(port, {
      ok: true,
      type: "PACK_REMOVED",
      requestId: message.requestId,
      areaId: message.areaId,
      workerVersion: WORKER_VERSION,
      removedCacheCount: selectedCaches.length,
    });
  } catch {
    reply(port, {
      ok: false,
      type: "PACK_FAILED",
      requestId: message.requestId,
      areaId: message.areaId,
      code: "removal-failed",
      message: "The selected offline pilot pack could not be removed. Its readiness must be checked again.",
    });
  }
}

async function findOfflineResponse(request) {
  const cacheNames = (await caches.keys())
    .filter((name) => name.startsWith(`${CACHE_PREFIX}:`) && name.includes(READY_MARKER))
    .reverse();
  for (const cacheName of cacheNames) {
    const response = await (await caches.open(cacheName)).match(request, { ignoreSearch: false });
    if (response) return response;
  }
  return null;
}

self.addEventListener("install", () => {
  // Deliberately do not call skipWaiting: an update must not replace the
  // active worker while a journey page is using the previous application shell.
});

self.addEventListener("activate", (event) => {
  // Activation never deletes a verified pack. Packs are replaced atomically by
  // the explicit preparation flow.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const message = event.data;
  const port = event.ports && event.ports[0];
  if (message?.type === "ACTIVATE_OFFLINE_UPDATE") {
    // The component sends this only after the user chooses to apply the update.
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (!validRequest(message)) {
    reply(port, {
      ok: false,
      type: "PACK_FAILED",
      requestId: typeof message?.requestId === "string" ? message.requestId : "invalid",
      code: "invalid-request",
      message: "The offline request was not recognised.",
    });
    return;
  }
  if (message.type === "PREPARE_PILOT_PACK") {
    event.waitUntil(preparePilotPack(message, port));
  } else if (message.type === "VERIFY_PILOT_PACK") {
    event.waitUntil(verifyPilotPack(message, port));
  } else if (message.type === "REMOVE_PILOT_PACK") {
    event.waitUntil(removePilotPack(message, port));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Custom routing and live heat context remain online-only and are never
  // answered from an offline pilot pack.
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/.shaderoute/")
  ) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) return response;
      return (await findOfflineResponse(request)) ?? response;
    } catch (networkError) {
      const offlineResponse = await findOfflineResponse(request);
      if (offlineResponse) return offlineResponse;
      throw networkError;
    }
  })());
});
