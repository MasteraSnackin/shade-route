export type OfflinePilotAreaId = "waterloo" | "kings-cross";

export const OFFLINE_PILOT_SCHEMA_VERSION = 1 as const;
export const OFFLINE_PILOT_PROTOCOL_VERSION = 1 as const;
export const OFFLINE_PILOT_PACK_VERSION = "pilot-data-2026-08-12-v1";
export const OFFLINE_PILOT_WORKER_VERSION = "shade-route-offline-2026-08-12-v1";
export const OFFLINE_PILOT_STORAGE_KEY = "shaderoute.offline-pilots.v1";
export const OFFLINE_PILOT_SERVICE_WORKER_URL = "/shade-route-sw.js";

/** Current selected-pilot data plus the shared route pack; excludes the generated app shell. */
export const OFFLINE_PILOT_DATA_BYTES: Readonly<Record<OfflinePilotAreaId, number>> = {
  waterloo: 7_577_041,
  "kings-cross": 10_123_955,
};

const SHARED_PILOT_ASSETS = [
  "/",
  "/favicon.svg",
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
  manifestId: string;
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
      assets: string[];
    }
  | {
      type: "VERIFY_PILOT_PACK";
      protocolVersion: typeof OFFLINE_PILOT_PROTOCOL_VERSION;
      requestId: string;
      areaId: OfflinePilotAreaId;
      packVersion: string;
      assets: string[];
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

function isAreaId(value: unknown): value is OfflinePilotAreaId {
  return value === "waterloo" || value === "kings-cross";
}

function normaliseLocalAsset(value: string, origin: string) {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname.startsWith("/api/")) return null;
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

export function createOfflineWorkerRequest(
  type: "PREPARE_PILOT_PACK" | "VERIFY_PILOT_PACK",
  areaId: OfflinePilotAreaId,
  assets: readonly string[],
  requestId: string,
): OfflineWorkerRequest {
  return {
    type,
    protocolVersion: OFFLINE_PILOT_PROTOCOL_VERSION,
    requestId,
    areaId,
    packVersion: OFFLINE_PILOT_PACK_VERSION,
    assets: [...assets],
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
