"use client";

import { useEffect, useState } from "react";
import type { HeatContextAvailable } from "../lib/heat-context";

type ViewState =
  | { kind: "loading" }
  | { kind: "available"; context: HeatContextAvailable }
  | { kind: "error" };

function validContext(value: unknown): value is HeatContextAvailable {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<HeatContextAvailable>;
  const scale = context.scale as Partial<HeatContextAvailable["scale"]> | undefined;
  return (
    context.status === "available" &&
    context.region === "London" &&
    context.regionType === "Government Office Region" &&
    typeof context.riskScore === "number" &&
    Number.isInteger(context.riskScore) &&
    context.riskScore >= 1 &&
    context.riskScore <= 16 &&
    typeof context.asOf === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(context.asOf) &&
    scale?.min === 1 &&
    scale.max === 16 &&
    typeof context.stale === "boolean"
  );
}

function formatDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(date);
}

export function HeatContext() {
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch("/api/heat-context", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok || !validContext(payload)) throw new Error("Heat context unavailable");
        setState({ kind: "available", context: payload });
      } catch {
        if (!controller.signal.aborted) setState({ kind: "error" });
      }
    }

    void load();
    return () => controller.abort();
  }, []);

  const sourceLink = (
    <a
      href="https://ukhsa-dashboard.data.gov.uk/weather-health-alerts/heat/london"
      target="_blank"
      rel="noreferrer"
    >
      UKHSA heat-health alerts
    </a>
  );

  return (
    <section className="heat-context" aria-labelledby="heat-context-title" aria-live="polite">
      <h3 id="heat-context-title">London heat-health context</h3>

      {state.kind === "loading" ? (
        <p>Loading regional UKHSA context…</p>
      ) : null}

      {state.kind === "error" ? (
        <p>Regional UKHSA heat-health context is currently unavailable. See {sourceLink}.</p>
      ) : null}

      {state.kind === "available" ? (
        <>
          <p>
            {state.context.stale ? "Previously fetched" : "Latest fetched"} UKHSA risk score for
            London: <strong>{state.context.riskScore} of {state.context.scale.max}</strong>, dated{" "}
            <time dateTime={state.context.asOf}>{formatDate(state.context.asOf)}</time>.
          </p>
          <p>Source: {sourceLink}.</p>
        </>
      ) : null}

      <p>This is regional context, not a ShadeRoute route safety score.</p>
    </section>
  );
}
