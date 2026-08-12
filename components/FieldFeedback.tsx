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
    note: "",
    includeLocation: false,
  });
  const draft = draftState.contextKey === contextKey
    ? draftState
    : { contextKey, outcome: "" as const, note: "", includeLocation: false };
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
        note: draft.note,
        includeLocation: locationAvailable && draft.includeLocation,
      });
      announceFieldFeedbackChange();
      setDraftState({ contextKey, outcome: "", note: "", includeLocation: false });
      setStatus("Report saved on this device. Nothing was sent to a server.");
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
      <span>Field observations</span>
      <h3 id={headingId}>Report what you observed</h3>
      <p id={privacyId}>
        This saves the route section, modelled time, answer and optional note in this browser.
        Section coordinates are excluded unless you explicitly include them. This form does not
        submit anything to a server; an exported file leaves this browser only if you share it. Up
        to 500 reports can be kept here.
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
            aria-label="Include this section’s coordinates"
            checked={locationAvailable && draft.includeLocation}
            disabled={storageBlocked || !locationAvailable}
            onChange={(event) => updateDraft({ includeLocation: event.target.checked })}
          />
          <span>
            <strong>Include this section’s coordinates</strong>
            <small>
              {locationAvailable
                ? "Off by default. This adds coordinates to the on-device report and any export."
                : "No section coordinates are available, so none will be stored."}
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
                    {record.includeLocation ? " · coordinates included" : " · no coordinates"}
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
        Exports contain route details, dates, notes and any coordinates you chose to include. Check
        the file before sharing it.
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
