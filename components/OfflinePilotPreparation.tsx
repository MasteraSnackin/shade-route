"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildOfflinePilotAssetList,
  buildOfflinePilotIntegrityManifest,
  createOfflineWorkerRemovalRequest,
  createOfflineWorkerPreparationRequest,
  createOfflineWorkerVerificationRequest,
  OFFLINE_PILOT_DATA_BYTES,
  OFFLINE_PILOT_PACK_VERSION,
  OFFLINE_PILOT_SERVICE_WORKER_URL,
  offlinePilotManifestId,
  readVerifiedOfflinePilot,
  removeVerifiedOfflinePilot,
  writeVerifiedOfflinePilot,
  type OfflinePilotAreaId,
  type OfflineWorkerRequest,
  type OfflineWorkerResponse,
  type VerifiedOfflinePilotRecord,
} from "../lib/offline-pilot";
import scoringWorkerUrl from "../workers/scoring-worker.ts?worker&url";
import shadowWorkerUrl from "../workers/shadow-worker.ts?worker&url";
import styles from "./OfflinePilotPreparation.module.css";

export type OfflinePilotPreparationPhase =
  | "idle"
  | "checking"
  | "preparing"
  | "removing"
  | "ready"
  | "removed"
  | "stale"
  | "failed"
  | "unsupported";

export interface OfflinePilotPreparationStatus {
  phase: OfflinePilotPreparationPhase;
  record: VerifiedOfflinePilotRecord | null;
  message: string | null;
}

export interface OfflinePilotPreparationProps {
  areaId: OfflinePilotAreaId;
  areaName: string;
  /** Shows the online-only warning more prominently while custom endpoints are active. */
  customRoutingActive?: boolean;
  className?: string;
  onStatusChange?: (status: OfflinePilotPreparationStatus) => void;
}

const RESPONSE_TIMEOUT_MS = 180_000;

function isLocalBuildAsset(value: string, origin: string) {
  try {
    const url = new URL(value, origin);
    return url.origin === origin && url.pathname.startsWith("/_next/static/");
  } catch {
    return false;
  }
}

/**
 * Captures the hashed scripts and styles in the current application shell.
 * Worker bundle URLs are added explicitly because workers need not appear in
 * the document resource list on every browser.
 */
export function currentOfflineRuntimeAssets() {
  if (typeof window === "undefined") return [];
  const origin = window.location.origin;
  const documentAssets = [
    ...Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"), (node) => node.src),
    ...Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'),
      (node) => node.href,
    ),
  ];
  const observedBuildAssets = typeof performance.getEntriesByType === "function"
    ? performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((asset) => isLocalBuildAsset(asset, origin))
    : [];

  return [
    ...documentAssets,
    ...observedBuildAssets,
    new URL(scoringWorkerUrl, origin).toString(),
    new URL(shadowWorkerUrl, origin).toString(),
  ];
}

function requestId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `offline-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function sendWorkerRequest(worker: ServiceWorker, request: OfflineWorkerRequest) {
  return new Promise<OfflineWorkerResponse>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      reject(new Error("Offline preparation did not finish. Try again on a stable connection."));
    }, RESPONSE_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<OfflineWorkerResponse>) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      resolve(event.data);
    };
    worker.postMessage(request, [channel.port2]);
  });
}

async function serviceWorkerRegistration() {
  const registration = await navigator.serviceWorker.register(OFFLINE_PILOT_SERVICE_WORKER_URL, {
    scope: "/",
    updateViaCache: "none",
  });
  const readyRegistration = await navigator.serviceWorker.ready;
  const worker = readyRegistration.active ?? registration.active;
  if (!worker) throw new Error("Offline support could not start in this browser.");
  return { registration, worker };
}

function readableVerifiedDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function approximatePackSize(areaId: OfflinePilotAreaId) {
  return (OFFLINE_PILOT_DATA_BYTES[areaId] / 1_000_000).toFixed(1);
}

function storageOrNull() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function OfflinePilotPreparation({
  areaId,
  areaName,
  customRoutingActive = false,
  className,
  onStatusChange,
}: OfflinePilotPreparationProps) {
  const [status, setStatus] = useState<OfflinePilotPreparationStatus>({
    phase: "idle",
    record: null,
    message: null,
  });
  const [updateRegistration, setUpdateRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const statusChangeRef = useRef(onStatusChange);
  const browserOrigin = typeof window === "undefined"
    ? "https://shaderoute.invalid"
    : window.location.origin;

  const assets = useMemo(
    () => buildOfflinePilotAssetList(areaId, currentOfflineRuntimeAssets(), browserOrigin),
    [areaId, browserOrigin],
  );
  const manifestId = useMemo(() => offlinePilotManifestId(assets), [assets]);

  const publishStatus = useCallback((next: OfflinePilotPreparationStatus) => {
    setStatus(next);
    statusChangeRef.current?.(next);
  }, []);

  useEffect(() => {
    statusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const trackWaitingUpdate = useCallback((registration: ServiceWorkerRegistration) => {
    if (registration.waiting && navigator.serviceWorker.controller) {
      setUpdateRegistration(registration);
    }
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          setUpdateRegistration(registration);
        }
      });
    }, { once: true });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const checkExistingPack = async () => {
      // Defer state publication so this effect only synchronises with browser
      // storage and service-worker state after the committed render.
      await Promise.resolve();
      if (cancelled) return;
      if (!("serviceWorker" in navigator) || !("caches" in window)) {
        publishStatus({
          phase: "unsupported",
          record: null,
          message: "This browser does not support verified offline pilot packs.",
        });
        return;
      }
      const storage = storageOrNull();
      const saved = storage ? readVerifiedOfflinePilot(areaId, storage) : null;
      if (!saved) {
        publishStatus({ phase: "idle", record: null, message: null });
        return;
      }
      if (saved.packVersion !== OFFLINE_PILOT_PACK_VERSION || saved.manifestId !== manifestId) {
        publishStatus({
          phase: "stale",
          record: saved,
          message: "The saved pilot pack belongs to an earlier application version. Prepare it again before relying on offline access.",
        });
        return;
      }

      publishStatus({ phase: "checking", record: saved, message: "Checking the saved pilot pack…" });
      try {
        const { registration, worker } = await serviceWorkerRegistration();
        trackWaitingUpdate(registration);
        const response = await sendWorkerRequest(
          worker,
          createOfflineWorkerVerificationRequest(
            areaId,
            assets,
            saved.integrityManifestId,
            requestId(),
          ),
        );
        if (cancelled) return;
        if (
          !response.ok ||
          response.type !== "PACK_VERIFIED" ||
          response.integrityManifestId !== saved.integrityManifestId
        ) {
          if (storage) removeVerifiedOfflinePilot(areaId, storage);
          publishStatus({
            phase: "stale",
            record: null,
            message: response.ok
              ? "The saved pilot pack no longer matches its integrity record. Prepare it again before relying on offline access."
              : response.message,
          });
          return;
        }
        publishStatus({ phase: "ready", record: saved, message: null });
      } catch {
        if (!cancelled) {
          publishStatus({
            phase: "stale",
            record: saved,
            message: "The saved pilot pack could not be verified in this browser session.",
          });
        }
      }
    };
    void checkExistingPack();
    return () => {
      cancelled = true;
    };
  }, [areaId, assets, manifestId, publishStatus, trackWaitingUpdate]);

  const prepare = async () => {
    if (!("serviceWorker" in navigator) || !("caches" in window)) return;
    const previousRecord = status.record;
    publishStatus({
      phase: "preparing",
      record: previousRecord,
      message: `Downloading and checking the ${areaName} pilot pack…`,
    });
    try {
      const integrityManifest = await buildOfflinePilotIntegrityManifest(
        areaId,
        assets,
        browserOrigin,
      );
      const { registration, worker } = await serviceWorkerRegistration();
      trackWaitingUpdate(registration);
      const response = await sendWorkerRequest(
        worker,
        createOfflineWorkerPreparationRequest(areaId, integrityManifest, requestId()),
      );
      if (!response.ok) throw new Error(response.message);
      if (response.type !== "PACK_PREPARED") {
        throw new Error("The offline worker did not confirm preparation.");
      }
      if (response.integrityManifestId !== integrityManifest.manifestId) {
        throw new Error("The offline worker did not confirm the expected integrity manifest.");
      }
      const record: VerifiedOfflinePilotRecord = {
        areaId,
        packVersion: response.packVersion,
        workerVersion: response.workerVersion,
        manifestId,
        integrityManifestId: response.integrityManifestId,
        assetCount: response.assetCount,
        verifiedAt: new Date().toISOString(),
      };
      const storage = storageOrNull();
      if (!storage) throw new Error("Browser storage is unavailable. Offline readiness could not be recorded.");
      writeVerifiedOfflinePilot(record, storage);
      publishStatus({ phase: "ready", record, message: null });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "The pilot pack could not be prepared. Check the connection and try again.";
      publishStatus({
        phase: previousRecord ? "stale" : "failed",
        record: previousRecord,
        message: previousRecord
          ? `${message} The earlier recorded pack has not been marked as current.`
          : message,
      });
    }
  };

  const applyUpdate = () => {
    const waiting = updateRegistration?.waiting;
    if (!waiting) return;
    waiting.postMessage({ type: "ACTIVATE_OFFLINE_UPDATE" });
    setUpdateRegistration(null);
    publishStatus({
      phase: "stale",
      record: status.record,
      message: "Offline support was updated. Prepare this pilot again to verify it against the update.",
    });
  };

  const removePack = async () => {
    if (!("serviceWorker" in navigator) || !("caches" in window)) return;
    const previousRecord = status.record;
    publishStatus({
      phase: "removing",
      record: previousRecord,
      message: `Removing the ${areaName} offline pilot pack…`,
    });
    try {
      const { registration, worker } = await serviceWorkerRegistration();
      trackWaitingUpdate(registration);
      const response = await sendWorkerRequest(
        worker,
        createOfflineWorkerRemovalRequest(areaId, requestId()),
      );
      if (!response.ok) throw new Error(response.message);
      if (response.type !== "PACK_REMOVED") {
        throw new Error("The offline worker did not confirm removal.");
      }
      const storage = storageOrNull();
      if (!storage) {
        throw new Error("The downloaded files were removed, but browser storage could not clear their readiness record.");
      }
      // The local readiness record is cleared only after the worker confirms
      // that this area's ready and staging caches are absent.
      removeVerifiedOfflinePilot(areaId, storage);
      publishStatus({
        phase: "removed",
        record: null,
        message: `The ${areaName} offline pilot pack was removed from this device.`,
      });
    } catch (error) {
      publishStatus({
        phase: "stale",
        record: previousRecord,
        message: error instanceof Error
          ? error.message
          : "The selected offline pilot pack could not be removed.",
      });
    }
  };

  const ready = status.phase === "ready" && status.record;
  const working = status.phase === "preparing" ||
    status.phase === "checking" ||
    status.phase === "removing";
  const canRemove = Boolean(status.record);

  return (
    <section className={[styles.panel, className].filter(Boolean).join(" ")} aria-labelledby={`offline-${areaId}-title`}>
      <div className={styles.heading}>
        <div>
          <span>Offline pilot</span>
          <h3 id={`offline-${areaId}-title`}>{areaName}</h3>
        </div>
        <strong className={ready ? styles.ready : styles.notReady}>
          {ready ? "Verified on this device" : "Not verified for offline use"}
        </strong>
      </div>

      <p className={styles.explanation}>
        Prepare the bundled pilot routes, local map and shade model for this corridor. The pilot data is about {approximatePackSize(areaId)} MB, plus the application files, and is stored only on this device. Browser or device storage controls may clear it, so verify the pack before relying on offline access.
      </p>
      <p className={customRoutingActive ? styles.onlineWarning : styles.onlineNote}>
        Custom starts and destinations remain online-only because a routing service must calculate their route. Live heat information also needs a connection.
      </p>

      {ready && (
        <p className={styles.verifiedDetail}>
          Last downloaded and integrity-checked {readableVerifiedDate(ready.verifiedAt)} · {ready.assetCount} files
        </p>
      )}
      {status.message && (
        <p className={styles.status} role={status.phase === "failed" ? "alert" : "status"}>
          {status.message}
        </p>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryAction}
          disabled={working || status.phase === "unsupported"}
          onClick={() => void prepare()}
        >
          {status.phase === "preparing"
            ? "Preparing and checking…"
            : ready
              ? "Refresh offline pilot pack"
              : "Prepare this pilot for offline use"}
        </button>
        {updateRegistration && (
          <button type="button" className={styles.secondaryAction} onClick={applyUpdate}>
            Apply offline support update
          </button>
        )}
        {canRemove && (
          <button
            type="button"
            className={styles.removeAction}
            disabled={working}
            onClick={() => void removePack()}
          >
            {status.phase === "removing"
              ? `Removing ${areaName} offline pilot pack…`
              : `Remove ${areaName} offline pilot pack`}
          </button>
        )}
      </div>
    </section>
  );
}
