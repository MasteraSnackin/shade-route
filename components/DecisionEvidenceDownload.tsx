"use client";

import { useId, useState } from "react";
import {
  createDecisionEvidence,
  decisionEvidenceFilename,
  serialiseDecisionEvidence,
  type DecisionEvidenceInput,
} from "../lib/decision-evidence";

export interface DecisionEvidenceDownloadProps {
  /** createdAt is optional here so the click time can be recorded without retaining activity history. */
  input: Omit<DecisionEvidenceInput, "createdAt"> & { createdAt?: Date | string };
}

function downloadJson(filename: string, contents: string) {
  const blob = new Blob([contents], { type: "application/json;charset=utf-8" });
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

export function DecisionEvidenceDownload({ input }: DecisionEvidenceDownloadProps) {
  const headingId = useId();
  const privacyId = useId();
  const [status, setStatus] = useState("");

  const handleDownload = () => {
    const record = createDecisionEvidence({
      ...input,
      createdAt: input.createdAt ?? new Date(),
    });
    const contents = record ? serialiseDecisionEvidence(record) : null;
    if (!record || !contents) {
      setStatus("The evidence file could not be created because the current decision data is incomplete.");
      return;
    }
    try {
      downloadJson(decisionEvidenceFilename(record), contents);
      setStatus("Decision evidence downloaded on this device. Nothing was uploaded.");
    } catch {
      setStatus("This browser could not download the evidence file. Nothing was uploaded.");
    }
  };

  return (
    <section className="model-status-panel decision-evidence" aria-labelledby={headingId}>
      <div className="decision-evidence__heading">
        <span>Local decision record</span>
        <h3 id={headingId}>Download decision evidence</h3>
      </div>
      <p id={privacyId} className="decision-evidence__privacy">
        The JSON file records bounded endpoint names, the selected route, comparison, each scheduled
        journey&apos;s model output and source dates. Exact endpoint coordinates, device location, route
        geometry, free-text notes, saved history and inferred health information are excluded. It is
        created locally and is not uploaded. Endpoint names can still reveal a routine or care
        journey, so review the file before sharing it.
      </p>
      <button
        className="primary-button decision-evidence__action"
        type="button"
        onClick={handleDownload}
        aria-describedby={privacyId}
      >
        Download evidence JSON
      </button>
      {status && (
        <p className="decision-evidence__status" role="status" aria-live="polite">
          {status}
        </p>
      )}
      <small className="decision-evidence__limitation">
        This is an uncalibrated clear-sky model record, not proof that a route will be shaded,
        step-free, open or safe when travelled.
      </small>
    </section>
  );
}
