"use client";

import { useId, useRef, useState, type ChangeEvent } from "react";
import {
  ROUTE_WALK_VALIDATION_MAX_BYTES,
  analyseRouteWalkValidationCsv,
  routeWalkValidationTemplateCsv,
  type RouteWalkValidationAnalysis,
} from "../lib/route-walk-validation";
import styles from "./CalibrationObserverRouteWalks.module.css";

type ImportState =
  | { kind: "idle" | "empty" | "invalid"; analysis: null }
  | { kind: "analysed"; analysis: RouteWalkValidationAnalysis };

function download(contents: string, filename: string, type: string) {
  const blob = new Blob([contents], { type });
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

function metric(value: number | null, suffix = "") {
  return value === null ? "Not calculable" : `${value}${suffix}`;
}

export function CalibrationObserverRouteWalks() {
  const headingId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ImportState>({ kind: "idle", analysis: null });
  const [message, setMessage] = useState("");

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > ROUTE_WALK_VALIDATION_MAX_BYTES) {
      setState({ kind: "invalid", analysis: null });
      setMessage("The file exceeds the 256 KB analysis limit. Nothing was read.");
      return;
    }

    try {
      const result = analyseRouteWalkValidationCsv(await file.text());
      if (result.status === "invalid" || !result.analysis) {
        setState({ kind: "invalid", analysis: null });
        setMessage("The file does not match the strict route-walk schema. No values were repaired or inferred.");
        return;
      }
      if (result.status === "empty") {
        setState({ kind: "empty", analysis: null });
        setMessage("The sheet contains only its header. No route walk has been counted.");
        return;
      }
      setState({ kind: "analysed", analysis: result.analysis });
      setMessage(`Analysed ${result.analysis.completeWalkCount} complete route walk${result.analysis.completeWalkCount === 1 ? "" : "s"} locally.`);
    } catch {
      setState({ kind: "invalid", analysis: null });
      setMessage("This browser could not read the route-walk file. Nothing was uploaded or retained.");
    }
  };

  const analysis = state.kind === "analysed" ? state.analysis : null;

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <div className={styles.heading}>
        <span>Complete route walks</span>
        <h3 id={headingId}>Analyse two or three physically walked alternatives</h3>
        <p>
          Freeze the model and route order before walking every alternative in a comparison.
          Import the completed sheet here to calculate direct-sun error, coverage, route-order
          agreement and regret without sending the file to a server.
        </p>
      </div>

      <p className={styles.warning} role="note">
        This analyser does not create field evidence. A header-only or synthetic sheet remains no
        evidence, and comparisons with observed unknown minutes are excluded from order agreement.
      </p>

      <div className={styles.actions}>
        <button
          className="text-button"
          type="button"
          onClick={() => download(
            routeWalkValidationTemplateCsv(),
            "shaderoute-route-walks.csv",
            "text/csv;charset=utf-8",
          )}
        >
          Download empty route-walk sheet
        </button>
        <button
          className={styles.fileAction}
          type="button"
          onClick={() => inputRef.current?.click()}
        >
          Analyse completed sheet
        </button>
        <input
          ref={inputRef}
          className={styles.hiddenInput}
          type="file"
          accept=".csv,text/csv"
          onChange={handleFile}
          tabIndex={-1}
          aria-label="Completed route-walk CSV"
        />
        {analysis && (
          <button
            className="text-button"
            type="button"
            onClick={() => download(
              `${JSON.stringify(analysis, null, 2)}\n`,
              "shaderoute-route-walk-analysis.json",
              "application/json;charset=utf-8",
            )}
          >
            Download analysis JSON
          </button>
        )}
      </div>

      <p
        className={styles.status}
        role={state.kind === "invalid" ? "alert" : "status"}
        aria-live="polite"
      >
        {message}
      </p>

      {analysis && (
        <div className={styles.results} aria-label="Local route-walk analysis results">
          <p className={styles.resultWarning}>
            Local calculation only. Review the source sheet and protocol before publishing any
            result; these numbers do not establish route safety.
          </p>
          <dl className={styles.metrics}>
            <div><dt>Complete walks</dt><dd>{analysis.completeWalkCount}</dd></div>
            <div><dt>Direct-sun minutes MAE</dt><dd>{metric(analysis.directSunMinutesMae, " min")}</dd></div>
            <div><dt>Observed unknown rate</dt><dd>{metric(analysis.observedUnknownRatePercent, "%")}</dd></div>
            <div>
              <dt>Full route-order agreement</dt>
              <dd>
                {analysis.orderComparableComparisonCount === 0
                  ? "Not calculable"
                  : `${analysis.fullRouteOrderAgreementCount} of ${analysis.orderComparableComparisonCount}`}
              </dd>
            </div>
            <div><dt>Mean regret</dt><dd>{metric(analysis.meanRegretMinutes, " min")}</dd></div>
            <div><dt>Comparisons imported</dt><dd>{analysis.comparisonCount}</dd></div>
          </dl>

          <details className={styles.comparisons}>
            <summary>Review comparison-level results ({analysis.comparisonCount})</summary>
            <ul>
              {analysis.comparisons.map((comparison) => (
                <li key={comparison.comparisonId}>
                  <strong>{comparison.comparisonId}</strong>
                  <span>{comparison.pilotArea} · {comparison.comparisonLondonDateTime}</span>
                  <span>
                    Predicted first: {comparison.predictedBestRouteId} · observed first:{" "}
                    {comparison.observedBestRouteId ?? "not calculable"}
                  </span>
                  <span>
                    Full order agreement:{" "}
                    {comparison.fullRouteOrderAgreement === null
                      ? "not calculable"
                      : comparison.fullRouteOrderAgreement
                        ? "yes"
                        : "no"}
                    {comparison.regretMinutes === null
                      ? ""
                      : ` · regret ${comparison.regretMinutes} min`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
