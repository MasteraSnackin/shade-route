import { PILOT_DATA_VERSION } from "./release-identity.ts";

export type OfflinePilotAreaId = "waterloo" | "kings-cross";

export const OFFLINE_PILOT_SCHEMA_VERSION = 2 as const;
export const OFFLINE_PILOT_PROTOCOL_VERSION = 2 as const;
export const OFFLINE_PILOT_PACK_VERSION = PILOT_DATA_VERSION;
export const OFFLINE_PILOT_WORKER_VERSION = "shade-route-offline-2026-08-15-v4";
export const OFFLINE_PILOT_STORAGE_KEY = "shaderoute.offline-pilots.v2";
export const OFFLINE_PILOT_SERVICE_WORKER_URL = "/shade-route-sw.js";

export interface OfflinePilotAssetIntegrity {
  path: string;
  byteLength: number;
  sha256: string;
}

export interface OfflinePilotIntegrityManifest {
  areaId: OfflinePilotAreaId;
  packVersion: typeof OFFLINE_PILOT_PACK_VERSION;
  manifestId: string;
  assets: OfflinePilotAssetIntegrity[];
}

/**
 * Release-pinned integrity for the public assets that make up the two data packs.
 * Tests recalculate every value from `public/`, so changing an asset requires an
 * explicit manifest and pack-version update rather than silently blessing it.
 */
export const OFFLINE_PILOT_STATIC_ASSET_INTEGRITY: Readonly<
  Record<string, Readonly<Omit<OfflinePilotAssetIntegrity, "path">>>
> = {
  "/favicon.svg": {
    byteLength: 712,
    sha256: "e6d2e59b7b5bbb0342e0fb496dfc262decbfe4426bbb7b047aec8d467d1dc6f7",
  },
  "/app-icon.svg": {
    byteLength: 360,
    sha256: "3d07de014faff02f1834e9deafadcf12319c3afaa6fe12ec356eed2f2190e1aa",
  },
  "/app-icon-192.png": {
    byteLength: 6_947,
    sha256: "f2be7835bf6266a7c9ea849313e5a5360bd3e0c1b07a637dbdca3b478c6b2851",
  },
  "/app-icon-512.png": {
    byteLength: 23_274,
    sha256: "755396c9859a0f83223ab1fda2121ab4cf8acb0271407d67da83a20005a7a342",
  },
  "/app-icon-maskable-512.png": {
    byteLength: 16_498,
    sha256: "6bb8f09c80f896a75678348d6e2add0020c9f80963d5f75d369c1749c72b611b",
  },
  "/apple-touch-icon.png": {
    byteLength: 4_396,
    sha256: "37ac1eb251151f5eb876ad2430be9708f0c61b42d660b8c4935c3fc99856f10b",
  },
  "/data/pilot-routes.json": {
    byteLength: 43_451,
    sha256: "f7b3342927967ffbb893bf152e59ce5325674e58497bbe8d75b1aed47ed86ce4",
  },
  "/data/context-waterloo.json": {
    byteLength: 1_736_135,
    sha256: "dc9cb731bd49f5f9438c30587c8c1ccb6686e81e72cd4cd66b4f6ecf107cf9db",
  },
  "/data/waterloo-map.json": {
    byteLength: 3_346_962,
    sha256: "2f811587c5948baaab4b362832ee34db98b04801d455a39a45b244f712a02a44",
  },
  "/data/waterloo-heights.json": {
    byteLength: 879,
    sha256: "72ac57609f2b9313c1d86adfb3f400cbc5f2eb330d08a9a49e778d1215971d96",
  },
  "/data/waterloo-heights.bin": {
    byteLength: 298_390,
    sha256: "2c0919f5c61feb72022cc8b6b5af3bdbbfe1e33d56cac037a47a6c675a6cd022",
  },
  "/data/waterloo-validity.bin": {
    byteLength: 298_390,
    sha256: "8b7855a83f296af82233f299571072217f6b19f0322cb314355321a0e9e1ab91",
  },
  "/data/waterloo-terrain.bin": {
    byteLength: 1_193_560,
    sha256: "f1fa6a4a8ead90fb77d0d9942e98da12696380098e6eaf2a93766f68b22723e3",
  },
  "/data/waterloo-surface-min.bin": {
    byteLength: 1_193_560,
    sha256: "6d98e673213eb012a45bd21629b22eea3516366bd6d52b464ed0f7b7b33f2c9d",
  },
  "/data/waterloo-surface-max.bin": {
    byteLength: 1_193_560,
    sha256: "fa4674c54b89ce71dd528fec042477815b18aefa31da225b44ca5dded2c10a73",
  },
  "/data/context-kings-cross.json": {
    byteLength: 2_670_425,
    sha256: "29239399ca676bdc30cc99b528f67471dfcb8a7c8908fd394fc4cd5a7058579e",
  },
  "/data/kings-cross-map.json": {
    byteLength: 5_054_745,
    sha256: "6e98e2406a52e0004dbdf54435e4aad9435fbd1ad5534c2fc385afc93937304c",
  },
  "/data/kings-cross-heights.json": {
    byteLength: 892,
    sha256: "7141f741e1a863c21a69d8509b8e2d1165204992cf6bd7381b6f3a684b5e0eae",
  },
  "/data/kings-cross-heights.bin": {
    byteLength: 358_125,
    sha256: "9c57831a951c3822a30d1f1d34339123a65bb4ff9269af9425df9871e5b76f88",
  },
  "/data/kings-cross-validity.bin": {
    byteLength: 358_125,
    sha256: "933ceed00b7118fc38e51836dc091313e43818fb20c9918575d1e31febdc1cf4",
  },
  "/data/kings-cross-terrain.bin": {
    byteLength: 1_432_500,
    sha256: "6462e6fa4f437920edf52ab310552e138e4618b374507a518ff9af7f4feb813e",
  },
  "/data/kings-cross-surface-min.bin": {
    byteLength: 1_432_500,
    sha256: "25e42b3cac40c91af4807749201241aad9485e0a417a8e848d0e43bc366e862e",
  },
  "/data/kings-cross-surface-max.bin": {
    byteLength: 1_432_500,
    sha256: "36fb4267c4d4475b7124ae5417b394db0bb0dfaa0b626ac3a40f4c49b9969915",
  },
};

/** Current selected-pilot data plus the shared route pack; excludes the generated app shell. */
export const OFFLINE_PILOT_DATA_BYTES: Readonly<Record<OfflinePilotAreaId, number>> = {
  waterloo: 9_304_887,
  "kings-cross": 12_783_263,
};

const SHARED_PILOT_ASSETS = [
  "/",
  "/favicon.svg",
  "/app-icon.svg",
  "/app-icon-192.png",
  "/app-icon-512.png",
  "/app-icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
  "/data/pilot-routes.json",
] as const;

/**
 * These are the exact runtime data files used by RouteMap, LocalPlaceSearch and
 * loadHeightGrid for each bundled corridor. The shared route file intentionally
 * contains both pilot corridors; no custom route response is cached.
 */
export const OFFLINE_PILOT_DATA_ASSETS: Readonly<
  Record<OfflinePilotAreaId, readonly string[]>
> = {
  waterloo: [
    "/data/context-waterloo.json",
    "/data/waterloo-map.json",
    "/data/waterloo-heights.json",
    "/data/waterloo-heights.bin",
    "/data/waterloo-validity.bin",
    "/data/waterloo-terrain.bin",
    "/data/waterloo-surface-min.bin",
    "/data/waterloo-surface-max.bin",
  ],
  "kings-cross": [
    "/data/context-kings-cross.json",
    "/data/kings-cross-map.json",
    "/data/kings-cross-heights.json",
    "/data/kings-cross-heights.bin",
    "/data/kings-cross-validity.bin",
    "/data/kings-cross-terrain.bin",
    "/data/kings-cross-surface-min.bin",
    "/data/kings-cross-surface-max.bin",
  ],
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface VerifiedOfflinePilotRecord {
  areaId: OfflinePilotAreaId;
  packVersion: string;
  workerVersion: string;
  /** Identifies the current app-shell and selected-pilot path set. */
  manifestId: string;
  /** SHA-256 of the exact path, byte-length and content-hash manifest. */
  integrityManifestId: string;
  assetCount: number;
  verifiedAt: string;
}

interface OfflinePilotEnvelope {
  schemaVersion: typeof OFFLINE_PILOT_SCHEMA_VERSION;
  pilots: Partial<Record<OfflinePilotAreaId, VerifiedOfflinePilotRecord>>;
}

export type OfflineWorkerRequest =
  | {
      type: "PREPARE_PILOT_PACK";
      protocolVersion: typeof OFFLINE_PILOT_PROTOCOL_VERSION;
      requestId: string;
      areaId: OfflinePilotAreaId;
      packVersion: string;
      manifest: OfflinePilotIntegrityManifest;
    }
  | {
      type: "VERIFY_PILOT_PACK";
      protocolVersion: typeof OFFLINE_PILOT_PROTOCOL_VERSION;
      requestId: string;
      areaId: OfflinePilotAreaId;
      packVersion: string;
      assets: string[];
      integrityManifestId: string;
    }
  | {
      type: "REMOVE_PILOT_PACK";
      protocolVersion: typeof OFFLINE_PILOT_PROTOCOL_VERSION;
      requestId: string;
      areaId: OfflinePilotAreaId;
    };

export interface OfflineWorkerPackSuccess {
  ok: true;
  type: "PACK_PREPARED" | "PACK_VERIFIED";
  requestId: string;
  areaId: OfflinePilotAreaId;
  packVersion: string;
  workerVersion: string;
  assetCount: number;
  integrityManifestId: string;
}

export interface OfflineWorkerRemovalSuccess {
  ok: true;
  type: "PACK_REMOVED";
  requestId: string;
  areaId: OfflinePilotAreaId;
  workerVersion: string;
  removedCacheCount: number;
}

export type OfflineWorkerSuccess = OfflineWorkerPackSuccess | OfflineWorkerRemovalSuccess;

export interface OfflineWorkerFailure {
  ok: false;
  type: "PACK_FAILED" | "PACK_MISSING";
  requestId: string;
  areaId?: OfflinePilotAreaId;
  code:
    | "invalid-request"
    | "unsupported-version"
    | "download-failed"
    | "verification-failed"
    | "pack-missing"
    | "removal-failed";
  message: string;
}

export type OfflineWorkerResponse = OfflineWorkerSuccess | OfflineWorkerFailure;

export interface OfflineStorageEstimate {
  quota?: number;
  usage?: number;
}

export interface OfflineStorageAssessment {
  status: "unknown" | "sufficient" | "low";
  requiredDataBytes: number;
  availableBytes: number | null;
}

function isAreaId(value: unknown): value is OfflinePilotAreaId {
  return value === "waterloo" || value === "kings-cross";
}

/**
 * Storage estimates are advisory because browsers may evict or deduplicate
 * cached responses. A known free-space shortfall is surfaced before the
 * download, but the service worker remains the authority on whether the
 * atomic pack can actually be prepared.
 */
export function assessOfflinePilotStorage(
  areaId: OfflinePilotAreaId,
  estimate?: OfflineStorageEstimate | null,
): OfflineStorageAssessment {
  const requiredDataBytes = OFFLINE_PILOT_DATA_BYTES[areaId];
  const quota = estimate?.quota;
  const usage = estimate?.usage;
  if (
    typeof quota !== "number" ||
    typeof usage !== "number" ||
    !Number.isFinite(quota) ||
    !Number.isFinite(usage) ||
    quota < 0 ||
    usage < 0 ||
    usage > quota
  ) {
    return { status: "unknown", requiredDataBytes, availableBytes: null };
  }
  const availableBytes = Math.max(0, Math.floor(quota - usage));
  return {
    status: availableBytes < requiredDataBytes ? "low" : "sufficient",
    requiredDataBytes,
    availableBytes,
  };
}

/** Rejects stale, cross-area and structurally invalid MessageChannel replies. */
export function offlineWorkerResponseMatchesRequest(
  request: OfflineWorkerRequest,
  response: unknown,
): response is OfflineWorkerResponse {
  if (!response || typeof response !== "object") return false;
  const candidate = response as Record<string, unknown>;
  if (
    candidate.requestId !== request.requestId ||
    typeof candidate.ok !== "boolean" ||
    (candidate.areaId !== undefined && candidate.areaId !== request.areaId)
  ) return false;

  if (!candidate.ok) {
    return (candidate.type === "PACK_FAILED" || candidate.type === "PACK_MISSING") &&
      typeof candidate.code === "string" &&
      typeof candidate.message === "string";
  }

  const expectedType = request.type === "PREPARE_PILOT_PACK"
    ? "PACK_PREPARED"
    : request.type === "VERIFY_PILOT_PACK"
      ? "PACK_VERIFIED"
      : "PACK_REMOVED";
  if (candidate.type !== expectedType || candidate.areaId !== request.areaId) return false;

  if (candidate.type === "PACK_REMOVED") {
    return typeof candidate.workerVersion === "string" &&
      Number.isSafeInteger(candidate.removedCacheCount) &&
      Number(candidate.removedCacheCount) >= 0;
  }
  return candidate.packVersion === OFFLINE_PILOT_PACK_VERSION &&
    typeof candidate.workerVersion === "string" &&
    Number.isSafeInteger(candidate.assetCount) &&
    Number(candidate.assetCount) > 0 &&
    typeof candidate.integrityManifestId === "string" &&
    /^sha256-[0-9a-f]{64}$/.test(candidate.integrityManifestId);
}

function normaliseLocalAsset(value: string, origin: string) {
  try {
    const url = new URL(value, origin);
    if (
      url.origin !== origin ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/.shaderoute/") ||
      url.pathname === OFFLINE_PILOT_SERVICE_WORKER_URL
    ) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * Builds the deliberately narrow cache manifest. `runtimeAssets` should be the
 * current page's same-origin scripts, styles and two worker bundle URLs.
 */
export function buildOfflinePilotAssetList(
  areaId: OfflinePilotAreaId,
  runtimeAssets: Iterable<string>,
  origin = "https://shaderoute.invalid",
) {
  const assets = [
    ...SHARED_PILOT_ASSETS,
    ...OFFLINE_PILOT_DATA_ASSETS[areaId],
    ...runtimeAssets,
  ]
    .map((asset) => normaliseLocalAsset(asset, origin))
    .filter((asset): asset is string => asset !== null);

  return [...new Set(assets)].sort();
}

function bytesToHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: ArrayBuffer) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot cryptographically verify an offline pilot pack.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(digest);
}

function canonicalIntegrityManifest(
  areaId: OfflinePilotAreaId,
  assets: readonly OfflinePilotAssetIntegrity[],
) {
  return JSON.stringify([
    areaId,
    OFFLINE_PILOT_PACK_VERSION,
    assets.map(({ path, byteLength, sha256 }) => [path, byteLength, sha256]),
  ]);
}

export async function offlinePilotIntegrityManifestId(
  areaId: OfflinePilotAreaId,
  assets: readonly OfflinePilotAssetIntegrity[],
) {
  const canonical = new TextEncoder().encode(canonicalIntegrityManifest(areaId, assets));
  const bytes = canonical.buffer.slice(
    canonical.byteOffset,
    canonical.byteOffset + canonical.byteLength,
  ) as ArrayBuffer;
  return `sha256-${await sha256Hex(bytes)}`;
}

/**
 * Builds the exact manifest sent to the service worker. Release-pinned pilot
 * files use checked-in hashes. Generated app-shell assets are independently
 * read once here and again by the service worker, so the promoted response must
 * agree on both byte length and SHA-256 content.
 */
export async function buildOfflinePilotIntegrityManifest(
  areaId: OfflinePilotAreaId,
  assetPaths: readonly string[],
  origin = "https://shaderoute.invalid",
  fetchImplementation: typeof fetch = fetch,
): Promise<OfflinePilotIntegrityManifest> {
  const normalisedPaths = assetPaths
    .map((asset) => normaliseLocalAsset(asset, origin))
    .filter((asset): asset is string => asset !== null);
  if (normalisedPaths.length !== assetPaths.length || new Set(normalisedPaths).size !== assetPaths.length) {
    throw new Error("The offline asset list is incomplete or contains duplicate paths.");
  }

  const assets = await Promise.all(
    [...normalisedPaths].sort().map(async (path): Promise<OfflinePilotAssetIntegrity> => {
      const expected = OFFLINE_PILOT_STATIC_ASSET_INTEGRITY[path];
      if (expected) return { path, ...expected };

      const response = await fetchImplementation(new URL(path, origin), {
        cache: "reload",
        credentials: "same-origin",
      });
      if (!response.ok || response.type === "opaque") {
        throw new Error("An application file could not be read for offline verification.");
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength < 1) {
        throw new Error("An empty application file cannot be included in an offline pilot pack.");
      }
      return {
        path,
        byteLength: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      };
    }),
  );

  return {
    areaId,
    packVersion: OFFLINE_PILOT_PACK_VERSION,
    manifestId: await offlinePilotIntegrityManifestId(areaId, assets),
    assets,
  };
}

/** A stable, non-security fingerprint used to match a verified status to its manifest. */
export function offlinePilotManifestId(assets: readonly string[]) {
  let hash = 0x811c9dc5;
  for (const character of [...assets].sort().join("\n")) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function validRecord(value: unknown): value is VerifiedOfflinePilotRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<VerifiedOfflinePilotRecord>;
  return Boolean(
    isAreaId(record.areaId) &&
      typeof record.packVersion === "string" &&
      record.packVersion.length > 0 &&
      typeof record.workerVersion === "string" &&
      record.workerVersion.length > 0 &&
      typeof record.manifestId === "string" &&
      /^fnv1a-[0-9a-f]{8}$/.test(record.manifestId) &&
      typeof record.integrityManifestId === "string" &&
      /^sha256-[0-9a-f]{64}$/.test(record.integrityManifestId) &&
      Number.isSafeInteger(record.assetCount) &&
      record.assetCount! > 0 &&
      typeof record.verifiedAt === "string" &&
      Number.isFinite(Date.parse(record.verifiedAt)),
  );
}

function readEnvelope(storage: StorageLike, requireWritableSchema = false): OfflinePilotEnvelope {
  let raw: string | null;
  try {
    raw = storage.getItem(OFFLINE_PILOT_STORAGE_KEY);
  } catch {
    if (requireWritableSchema) {
      throw new Error("Browser storage is unavailable. Offline readiness could not be recorded.");
    }
    return { schemaVersion: OFFLINE_PILOT_SCHEMA_VERSION, pilots: {} };
  }
  if (!raw) return { schemaVersion: OFFLINE_PILOT_SCHEMA_VERSION, pilots: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<OfflinePilotEnvelope>;
    if (parsed.schemaVersion !== OFFLINE_PILOT_SCHEMA_VERSION || !parsed.pilots) {
      if (requireWritableSchema) {
        throw new Error("Saved offline status uses an unsupported version and was not overwritten.");
      }
      return { schemaVersion: OFFLINE_PILOT_SCHEMA_VERSION, pilots: {} };
    }
    const pilots: OfflinePilotEnvelope["pilots"] = {};
    for (const areaId of ["waterloo", "kings-cross"] as const) {
      const candidate = parsed.pilots[areaId];
      if (validRecord(candidate) && candidate.areaId === areaId) pilots[areaId] = candidate;
    }
    return { schemaVersion: OFFLINE_PILOT_SCHEMA_VERSION, pilots };
  } catch (error) {
    if (requireWritableSchema) {
      if (error instanceof Error && /unsupported version/.test(error.message)) throw error;
      throw new Error("Saved offline status could not be read and was not overwritten.");
    }
    return { schemaVersion: OFFLINE_PILOT_SCHEMA_VERSION, pilots: {} };
  }
}

export function readVerifiedOfflinePilot(
  areaId: OfflinePilotAreaId,
  storage: StorageLike,
) {
  return readEnvelope(storage).pilots[areaId] ?? null;
}

export function writeVerifiedOfflinePilot(
  record: VerifiedOfflinePilotRecord,
  storage: StorageLike,
) {
  if (!validRecord(record)) throw new Error("The offline verification record is incomplete.");
  const envelope = readEnvelope(storage, true);
  envelope.pilots[record.areaId] = record;
  try {
    storage.setItem(OFFLINE_PILOT_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    throw new Error("Browser storage is unavailable. Offline readiness could not be recorded.");
  }
  return record;
}

export function removeVerifiedOfflinePilot(
  areaId: OfflinePilotAreaId,
  storage: StorageLike,
) {
  const envelope = readEnvelope(storage, true);
  delete envelope.pilots[areaId];
  try {
    if (Object.keys(envelope.pilots).length) {
      storage.setItem(OFFLINE_PILOT_STORAGE_KEY, JSON.stringify(envelope));
    } else {
      storage.removeItem(OFFLINE_PILOT_STORAGE_KEY);
    }
  } catch {
    throw new Error("Browser storage is unavailable. Offline readiness could not be cleared.");
  }
}

export function createOfflineWorkerPreparationRequest(
  areaId: OfflinePilotAreaId,
  manifest: OfflinePilotIntegrityManifest,
  requestId: string,
): OfflineWorkerRequest {
  if (manifest.areaId !== areaId || manifest.packVersion !== OFFLINE_PILOT_PACK_VERSION) {
    throw new Error("The offline integrity manifest does not match the selected pilot.");
  }
  return {
    type: "PREPARE_PILOT_PACK",
    protocolVersion: OFFLINE_PILOT_PROTOCOL_VERSION,
    requestId,
    areaId,
    packVersion: OFFLINE_PILOT_PACK_VERSION,
    manifest: {
      ...manifest,
      assets: manifest.assets.map((asset) => ({ ...asset })),
    },
  };
}

export function createOfflineWorkerVerificationRequest(
  areaId: OfflinePilotAreaId,
  assets: readonly string[],
  integrityManifestId: string,
  requestId: string,
): OfflineWorkerRequest {
  return {
    type: "VERIFY_PILOT_PACK",
    protocolVersion: OFFLINE_PILOT_PROTOCOL_VERSION,
    requestId,
    areaId,
    packVersion: OFFLINE_PILOT_PACK_VERSION,
    assets: [...assets],
    integrityManifestId,
  };
}

export function createOfflineWorkerRemovalRequest(
  areaId: OfflinePilotAreaId,
  requestId: string,
): OfflineWorkerRequest {
  return {
    type: "REMOVE_PILOT_PACK",
    protocolVersion: OFFLINE_PILOT_PROTOCOL_VERSION,
    requestId,
    areaId,
  };
}
