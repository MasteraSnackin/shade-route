"use client";

import { useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  FIELD_FEEDBACK_STORAGE_KEY,
  clearFieldFeedback,
  deleteFieldFeedback,
  fieldFeedbackSnapshotStatus,
  fieldFeedbackToCsv,
  fieldFeedbackToJson,
  readFieldFeedback,
  submitFieldFeedback,
  type FieldFeedbackContext,
  type FieldFeedbackOutcome,
  type FieldFeedbackRecord,
} from "../lib/local-journeys";

const FIELD_FEEDBACK_CHANGE_EVENT = "shaderoute:field-feedback-change";
const STORAGE_UNAVAILABLE_SNAPSHOT = "__shaderoute_storage_unavailable__";

const OUTCOMES: Array<{ value: FieldFeedbackOutcome; label: string }> = [
  { value: "predicted-correct", label: "The displayed sun or shade estimate matched" },
  { value: "actually-sunny", label: "It was actually sunny" },
  { value: "actually-shaded", label: "It was actually shaded" },
  { value: "blocked-or-inaccessible", label: "The route was blocked or inaccessible" },
  { value: "other", label: "Something else" },
];

export interface FieldFeedbackProps {
  context: FieldFeedbackContext;
  onSubmitted?: (record: FieldFeedbackRecord) => void;
}

interface FeedbackDraft {
  contextKey: string;
  outcome: FieldFeedbackOutcome | "";
  predictionRecordedFirst: boolean;
  pavementSide: "left" | "right" | "centre" | "not-recorded";
  weatherVisibility: "clear-direct-sun" | "intermittent-sun" | "overcast" | "not-recorded";
  leafState: "leaf-on" | "partial" | "leaf-off" | "not-applicable" | "not-recorded";
  temporaryConditions: string;
  note: string;
  includeLocation: boolean;
}

function fieldFeedbackSnapshot() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(FIELD_FEEDBACK_STORAGE_KEY) ?? "";
  } catch {
    return STORAGE_UNAVAILABLE_SNAPSHOT;
  }
}

function subscribeToFieldFeedback(onChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const handleStorage = (event: StorageEvent) => {
    if (!event.key || event.key === FIELD_FEEDBACK_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(FIELD_FEEDBACK_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(FIELD_FEEDBACK_CHANGE_EVENT, onChange);
  };
}

function announceFieldFeedbackChange() {
  window.dispatchEvent(new Event(FIELD_FEEDBACK_CHANGE_EVENT));
}

function downloadFile(filename: string, contents: string, mimeType: string) {
  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function outcomeLabel(outcome: FieldFeedbackOutcome) {
  return OUTCOMES.find((option) => option.value === outcome)?.label ?? outcome;
}

const londonFeedbackDate = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeZone: "Europe/London",
});

function predictedStateLabel(state: FieldFeedbackContext["predictedState"]) {
  switch (state) {
    case "sun": return "direct sun";
    case "shade": return "shade";
    case "uncertain": return "uncertain exposure";
    case "unknown": return "no model coverage";
    case "night": return "night";
    default: return "not supplied";
  }
}

export function FieldFeedback({ context, onSubmitted }: FieldFeedbackProps) {
  const rawSnapshot = useSyncExternalStore(
    subscribeToFieldFeedback,
    fieldFeedbackSnapshot,
    () => "",
  );
  const storageUnavailable = rawSnapshot === STORAGE_UNAVAILABLE_SNAPSHOT;
  const records = rawSnapshot && !storageUnavailable ? readFieldFeedback() : [];
  const storageUnreadable = !storageUnavailable && fieldFeedbackSnapshotStatus(rawSnapshot) === "unreadable";
  const contextKey = [
    context.routeId,
    context.segmentId,
    context.predictedAt,
    context.location?.latitude,
    context.location?.longitude,
  ].join("|");
  const [draftState, setDraftState] = useState<FeedbackDraft>({
    contextKey,
    outcome: "",
    predictionRecordedFirst: false,
    pavementSide: "not-recorded",
    weatherVisibility: "not-recorded",
    leafState: "not-recorded",
    temporaryConditions: "",
    note: "",
    includeLocation: false,
  });
  const draft = draftState.contextKey === contextKey
    ? draftState
    : {
        contextKey,
        outcome: "" as const,
        predictionRecordedFirst: false,
        pavementSide: "not-recorded" as const,
        weatherVisibility: "not-recorded" as const,
        leafState: "not-recorded" as const,
        temporaryConditions: "",
        note: "",
        includeLocation: false,
      };
  const [status, setStatus] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const cancelClearRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const noteId = useId();
  const locationId = useId();
  const privacyId = useId();
  const exportPrivacyId = useId();
  const locationAvailable = Boolean(context.location);
  const predictionCanBeConfirmed = context.predictedState === "sun" || context.predictedState === "shade";
  const storageBlocked = storageUnavailable || storageUnreadable;

  const updateDraft = (update: Partial<Omit<FeedbackDraft, "contextKey">>) => {
    setDraftState({ ...draft, ...update, contextKey });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.outcome) {
      setStatus("Choose what you observed before saving the report.");
      return;
    }
    try {
      const record = submitFieldFeedback(context, {
        outcome: draft.outcome,
        predictionRecordedFirst: draft.predictionRecordedFirst,
        pavementSide: draft.pavementSide,
        weatherVisibility: draft.weatherVisibility,
        leafState: draft.leafState,
        temporaryConditions: draft.temporaryConditions,
        note: draft.note,
        includeLocation: locationAvailable && draft.includeLocation,
      });
      announceFieldFeedbackChange();
      setDraftState({
        contextKey,
        outcome: "",
        predictionRecordedFirst: false,
        pavementSide: "not-recorded",
        weatherVisibility: "not-recorded",
        leafState: "not-recorded",
        temporaryConditions: "",
        note: "",
        includeLocation: false,
      });
      setStatus("Operational section report saved locally on this device. Nothing was sent to a server.");
      onSubmitted?.(record);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The report could not be saved.");
    }
  };

  const handleDelete = (record: FieldFeedbackRecord) => {
    try {
      deleteFieldFeedback(record.id);
      announceFieldFeedbackChange();
      setStatus("The on-device report was deleted.");
      setConfirmClear(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The report could not be deleted.");
    }
  };

  const handleClear = () => {
    try {
      clearFieldFeedback();
      announceFieldFeedbackChange();
      setConfirmClear(false);
      setStatus("All on-device reports were deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Reports could not be cleared.");
    }
  };

  const requestClear = () => {
    setConfirmClear(true);
    window.setTimeout(() => cancelClearRef.current?.focus(), 0);
  };

  const handleExport = (format: "json" | "csv") => {
    try {
      const filename = `shaderoute-field-feedback.${format}`;
      const contents = format === "json"
        ? fieldFeedbackToJson(records)
        : fieldFeedbackToCsv(records);
      downloadFile(filename, contents, format === "json" ? "application/json" : "text/csv");
      setStatus(`Download started for ${records.length} on-device report${records.length === 1 ? "" : "s"} as ${format.toUpperCase()}.`);
    } catch {
      setStatus("The export could not be prepared by this browser.");
    }
  };

  return (
    <section className="model-status-panel field-feedback" aria-labelledby={headingId}>
      <span>Operational field feedback</span>
      <h3 id={headingId}>Report conditions on this modelled section</h3>
      <p id={privacyId}>
        Nothing is saved automatically or sent to a server. Choosing Save writes the route section,
        modelled time, time saved, pavement side, visible-sun conditions, leaf state, temporary
        conditions, answer and optional note to this browser&apos;s local storage. The optional point is
        the model section&apos;s start, not a device GPS observation. An exported file leaves this browser
        only if you share it. Up to 500 reports can be kept here.
      </p>

      {context.predictedState && (
        <p>Displayed estimate for this section: {predictedStateLabel(context.predictedState)}.</p>
      )}

      {storageUnavailable ? (
        <p role="status">Browser storage is unavailable, so reports cannot be read or saved.</p>
      ) : storageUnreadable ? (
        <p role="status">
          Existing report data cannot be read. Clear it below before saving another report.
        </p>
      ) : null}

      <form onSubmit={handleSubmit} aria-describedby={privacyId}>
        <div className="access-option">
          <input
            id={`${headingId}-prediction-first`}
            aria-label="Estimate seen before checking current conditions"
            type="checkbox"
            checked={draft.predictionRecordedFirst}
            disabled={storageBlocked || !context.predictedState || !context.predictedAt}
            onChange={(event) => updateDraft({ predictionRecordedFirst: event.target.checked })}
          />
          <label htmlFor={`${headingId}-prediction-first`}>
            <strong>I saw the displayed estimate before checking current conditions</strong>
            <small>This records report order only; it does not make this a fixed-point calibration observation.</small>
          </label>
        </div>

        <fieldset disabled={storageBlocked}>
          <legend>What happened on this section?</legend>
          {OUTCOMES.map((option) => {
            const unavailableForEstimate = option.value === "predicted-correct" && !predictionCanBeConfirmed;
            return (
              <label key={option.value} style={{ minHeight: 44 }}>
                <input
                  type="radio"
                  name="fieldOutcome"
                  value={option.value}
                  checked={draft.outcome === option.value}
                  required
                  disabled={unavailableForEstimate}
                  onChange={() => updateDraft({ outcome: option.value })}
                />
                <div>
                  {option.label}
                  {unavailableForEstimate && " — unavailable when the estimate is uncertain or missing"}
                </div>
              </label>
            );
          })}
        </fieldset>

        <div className="field-feedback-grid">
          <label>
            Side of pavement
            <select
              value={draft.pavementSide}
              onChange={(event) => updateDraft({
                pavementSide: event.target.value as FeedbackDraft["pavementSide"],
              })}
            >
              <option value="not-recorded">Not recorded</option>
              <option value="left">Left in direction of travel</option>
              <option value="right">Right in direction of travel</option>
              <option value="centre">Centre or shared space</option>
            </select>
          </label>
          <label>
            Sun visibility
            <select
              value={draft.weatherVisibility}
              onChange={(event) => updateDraft({
                weatherVisibility: event.target.value as FeedbackDraft["weatherVisibility"],
              })}
            >
              <option value="not-recorded">Not recorded</option>
              <option value="clear-direct-sun">Clear direct sunlight visible</option>
              <option value="intermittent-sun">Intermittent sunlight</option>
              <option value="overcast">Overcast; no direct-sun validation</option>
            </select>
          </label>
          <label>
            Leaf state
            <select
              value={draft.leafState}
              onChange={(event) => updateDraft({
                leafState: event.target.value as FeedbackDraft["leafState"],
              })}
            >
              <option value="not-recorded">Not recorded</option>
              <option value="leaf-on">Leaf on</option>
              <option value="partial">Partial leaf</option>
              <option value="leaf-off">Leaf off</option>
              <option value="not-applicable">No relevant vegetation</option>
            </select>
          </label>
        </div>

        <label>
          Temporary conditions
          <input
            type="text"
            value={draft.temporaryConditions}
            maxLength={500}
            onChange={(event) => updateDraft({ temporaryConditions: event.target.value })}
            placeholder="For example: works hoarding, parked vehicle or temporary canopy"
          />
        </label>

        <label htmlFor={noteId}>Optional detail</label>
        <textarea
          id={noteId}
          value={draft.note}
          maxLength={1_000}
          rows={3}
          disabled={storageBlocked}
          onChange={(event) => updateDraft({ note: event.target.value })}
          placeholder="For example: temporary works, a closed pavement or tree shade"
        />

        <label className="access-option" htmlFor={locationId}>
          <input
            id={locationId}
            type="checkbox"
            aria-label="Include the model section reference point"
            checked={locationAvailable && draft.includeLocation}
            disabled={storageBlocked || !locationAvailable}
            onChange={(event) => updateDraft({ includeLocation: event.target.checked })}
          />
          <span>
            <strong>Include the model section reference point</strong>
            <small>
              {locationAvailable
                ? "Off by default. This is the model section’s start coordinate, not your device position or a measured observation point."
                : "No model section reference point is available, so no coordinates will be stored."}
            </small>
          </span>
        </label>

        <button className="primary-button" type="submit" disabled={storageBlocked}>
          Save report on this device
        </button>
      </form>

      <p>
        A report does not confirm that a route is safe or accessible. Check current conditions and
        follow closures and official instructions.
      </p>

      {records.length > 0 && (
        <details className="directions-panel">
          <summary>
            On-device reports <small>{records.length}</small>
          </summary>
          <ol>
            {records.map((record) => (
              <li key={record.id}>
                <span>{londonFeedbackDate.format(new Date(record.submittedAt))}</span>
                <div>
                  <strong>{outcomeLabel(record.outcome)}</strong>
                  <small>
                    {record.routeName ?? record.routeId}
                    {record.includeLocation ? " · model section point included" : " · no coordinates"}
                  </small>
                </div>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => handleDelete(record)}
                  aria-label={`Delete report from ${londonFeedbackDate.format(new Date(record.submittedAt))}`}
                >
                  Delete
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}

      <p id={exportPrivacyId}>
        Exports contain route details, modelled and saved times, notes and any model section point you
        chose to include. They are operational reports, not the fixed-point calibration dataset. Check the
        file before sharing it.
      </p>
      <div aria-describedby={exportPrivacyId}>
        <button
          className="text-button"
          type="button"
          disabled={records.length === 0}
          onClick={() => handleExport("json")}
        >
          Export JSON
        </button>
        <button
          className="text-button"
          type="button"
          disabled={records.length === 0}
          onClick={() => handleExport("csv")}
        >
          Export CSV
        </button>
        {(records.length > 0 || storageUnreadable) && (
          confirmClear ? (
            <>
              <span>{storageUnreadable ? "Remove the unreadable local data?" : "Delete every report?"}</span>
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
              {storageUnreadable ? "Clear unreadable data" : "Clear reports"}
            </button>
          )
        )}
      </div>

      {status && <p role="status">{status}</p>}
    </section>
  );
}
