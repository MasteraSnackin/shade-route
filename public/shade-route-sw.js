/* ShadeRoute offline pilot service worker.
 * Pilot packs are prepared only after an explicit client message. */

const PROTOCOL_VERSION = 1;
const WORKER_VERSION = "shade-route-offline-2026-08-12-v1";
const SUPPORTED_PACK_VERSION = "pilot-data-2026-08-12-v1";
const CACHE_PREFIX = "shaderoute-offline-pilot";
const STAGING_MARKER = ":staging:";
const READY_MARKER = ":ready:";
const MAXIMUM_ASSETS = 80;

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

function validAssetPaths(assets) {
  if (!Array.isArray(assets) || assets.length < 1 || assets.length > MAXIMUM_ASSETS) return null;
  const paths = [];
  for (const value of assets) {
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
      url.pathname === "/shade-route-sw.js"
    ) return null;
    paths.push(`${url.pathname}${url.search}`);
  }
  return [...new Set(paths)].sort();
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

async function cacheContainsEveryAsset(cache, assets) {
  for (const asset of assets) {
    const response = await cache.match(asset, { ignoreSearch: false });
    if (!response || !response.ok) return false;
  }
  return true;
}

async function preparePilotPack(message, port) {
  const assets = validAssetPaths(message.assets);
  if (!assets) {
    reply(port, {
      ok: false,
      type: "PACK_FAILED",
      requestId: message.requestId,
      areaId: message.areaId,
      code: "invalid-request",
      message: "The offline asset list is incomplete.",
    });
    return;
  }
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

  const generation = `${Date.now()}-${message.requestId}`;
  const stagingName = `${CACHE_PREFIX}:${message.areaId}${STAGING_MARKER}${message.packVersion}:${generation}`;
  const finalName = `${readyCachePrefix(message.areaId, message.packVersion)}${generation}`;
  let finalCreated = false;

  try {
    const staging = await caches.open(stagingName);
    for (const asset of assets) {
      const request = new Request(asset, {
        cache: "reload",
        credentials: "same-origin",
      });
      const response = await fetch(request);
      if (!response.ok || response.type === "opaque") {
        throw new Error("download-failed");
      }
      await staging.put(asset, response.clone());
    }
    if (!(await cacheContainsEveryAsset(staging, assets))) {
      throw new Error("verification-failed");
    }

    const finalCache = await caches.open(finalName);
    finalCreated = true;
    for (const asset of assets) {
      const response = await staging.match(asset, { ignoreSearch: false });
      if (!response) throw new Error("verification-failed");
      await finalCache.put(asset, response);
    }
    if (!(await cacheContainsEveryAsset(finalCache, assets))) {
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
      assetCount: assets.length,
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
  if (!assets || message.packVersion !== SUPPORTED_PACK_VERSION) {
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
  for (const name of names) {
    const cache = await caches.open(name);
    if (await cacheContainsEveryAsset(cache, assets)) {
      reply(port, {
        ok: true,
        type: "PACK_VERIFIED",
        requestId: message.requestId,
        areaId: message.areaId,
        packVersion: message.packVersion,
        workerVersion: WORKER_VERSION,
        assetCount: assets.length,
      });
      return;
    }
  }
  reply(port, {
    ok: false,
    type: "PACK_MISSING",
    requestId: message.requestId,
    areaId: message.areaId,
    code: "pack-missing",
    message: "This pilot is not prepared for offline use on this device.",
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
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

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
