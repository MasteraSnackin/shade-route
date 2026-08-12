"use client";

import { useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  SAVED_JOURNEYS_STORAGE_KEY,
  clearLocalJourneys,
  deleteLocalJourney,
  readSavedJourneys,
  saveLocalJourney,
  savedJourneysSnapshotStatus,
  type SavedJourney,
  type SavedJourneySetup,
} from "../lib/local-journeys";

const SAVED_JOURNEYS_CHANGE_EVENT = "shaderoute:saved-journeys-change";
const STORAGE_UNAVAILABLE_SNAPSHOT = "__shaderoute_storage_unavailable__";

export interface SavedJourneysProps {
  currentSetup: SavedJourneySetup;
  suggestedLabel?: string;
  onLoad: (setup: SavedJourneySetup, journey: SavedJourney) => void;
  onSaved?: (journey: SavedJourney) => void;
}

function savedJourneysSnapshot() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(SAVED_JOURNEYS_STORAGE_KEY) ?? "";
  } catch {
    return STORAGE_UNAVAILABLE_SNAPSHOT;
  }
}

function subscribeToSavedJourneys(onChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const handleStorage = (event: StorageEvent) => {
    if (!event.key || event.key === SAVED_JOURNEYS_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(SAVED_JOURNEYS_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(SAVED_JOURNEYS_CHANGE_EVENT, onChange);
  };
}

function announceSavedJourneysChange() {
  window.dispatchEvent(new Event(SAVED_JOURNEYS_CHANGE_EVENT));
}

export function SavedJourneys({
  currentSetup,
  suggestedLabel,
  onLoad,
  onSaved,
}: SavedJourneysProps) {
  const rawSnapshot = useSyncExternalStore(
    subscribeToSavedJourneys,
    savedJourneysSnapshot,
    () => "",
  );
  const storageUnavailable = rawSnapshot === STORAGE_UNAVAILABLE_SNAPSHOT;
  const journeys = rawSnapshot && !storageUnavailable ? readSavedJourneys() : [];
  const storageUnreadable = !storageUnavailable && savedJourneysSnapshotStatus(rawSnapshot) === "unreadable";
  const [status, setStatus] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const cancelClearRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const labelId = useId();
  const privacyId = useId();
  const defaultLabel = suggestedLabel?.trim() ||
    `${currentSetup.origin.name} to ${currentSetup.destination.name}`;
  const setupIdentity = [
    currentSetup.origin.lat,
    currentSetup.origin.lon,
    currentSetup.destination.lat,
    currentSetup.destination.lon,
  ].join("|");

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const label = String(form.get("journeyLabel") ?? "").trim();
    try {
      const updated = saveLocalJourney({ label, setup: currentSetup });
      announceSavedJourneysChange();
      const saved = updated[0];
      setStatus(`Saved “${saved.label}” on this device.`);
      setConfirmClear(false);
      onSaved?.(saved);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "This journey could not be saved.");
    }
  };

  const handleDelete = (journey: SavedJourney) => {
    try {
      deleteLocalJourney(journey.id);
      announceSavedJourneysChange();
      setStatus(`Removed “${journey.label}” from this device.`);
      setConfirmClear(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "This journey could not be removed.");
    }
  };

  const handleClear = () => {
    try {
      clearLocalJourneys();
      announceSavedJourneysChange();
      setConfirmClear(false);
      setStatus("All saved journeys were removed from this device.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Saved journeys could not be cleared.");
    }
  };

  const requestClear = () => {
    setConfirmClear(true);
    window.setTimeout(() => cancelClearRef.current?.focus(), 0);
  };

  return (
    <section className="model-status-panel saved-journeys" aria-labelledby={headingId}>
      <span>On-device shortcuts</span>
      <h3 id={headingId}>Saved journeys</h3>
      <p id={privacyId}>
        This stores the named start and destination, preferred time and route settings in this
        browser. Saving does not send the data to a server or create an account. Up to 20 journeys
        can be saved.
      </p>

      <form key={setupIdentity} onSubmit={handleSave} aria-describedby={privacyId}>
        <label htmlFor={labelId}>Journey name</label>
        <input
          id={labelId}
          name="journeyLabel"
          type="text"
          defaultValue={defaultLabel}
          maxLength={100}
          required
          autoComplete="off"
          disabled={storageUnavailable || storageUnreadable}
        />
        <button
          className="primary-button"
          type="submit"
          disabled={storageUnavailable || storageUnreadable}
        >
          Save current setup
        </button>
      </form>

      {storageUnavailable ? (
        <p role="status">Browser storage is unavailable, so journeys cannot be read or saved.</p>
      ) : storageUnreadable ? (
        <p role="status">
          Existing saved-journey data cannot be read. Clear it below before saving another journey.
        </p>
      ) : journeys.length > 0 ? (
        <ul aria-label="Journeys saved on this device">
          {journeys.map((journey) => (
            <li key={journey.id}>
              <div>
                <strong>{journey.label}</strong>
                <small>
                  {journey.setup.departureTime ? `${journey.setup.departureTime} · ` : ""}
                  {journey.setup.profile === "worker" ? "Outdoor worker" : "Heat-vulnerable person"}
                  {journey.setup.avoidSteps ? " · avoid known steps" : ""}
                </small>
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => onLoad(journey.setup, journey)}
                aria-label={`Load ${journey.label}`}
              >
                Load
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => handleDelete(journey)}
                aria-label={`Delete ${journey.label} from this device`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No journeys are saved on this device.</p>
      )}

      {!storageUnavailable && (journeys.length > 0 || storageUnreadable) && (
        <div>
          {confirmClear ? (
            <>
              <span>{storageUnreadable ? "Remove the unreadable local data?" : "Remove every saved journey?"}</span>
              <button className="text-button" type="button" onClick={handleClear}>
                Confirm clear
              </button>
              <button
                className="text-button"
                type="button"
                ref={cancelClearRef}
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button className="text-button" type="button" onClick={requestClear}>
              {storageUnreadable ? "Clear unreadable data" : "Clear saved journeys"}
            </button>
          )}
        </div>
      )}

      {status && <p role="status">{status}</p>}
    </section>
  );
}
