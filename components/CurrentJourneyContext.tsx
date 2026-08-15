"use client";

import { useEffect, useId, useState } from "react";
import {
  parseCurrentJourneyContextData,
  type CurrentContextAreaId,
  type CurrentJourneyContextData,
  type MetOfficeCurrentContext,
  type StreetManagerCurrentContext,
  type TflCurrentContext,
} from "../lib/current-context";
import styles from "./CurrentJourneyContext.module.css";

type ViewState =
  | { kind: "loading"; areaId: CurrentContextAreaId }
  | { kind: "ready"; areaId: CurrentContextAreaId; context: CurrentJourneyContextData }
  | { kind: "error"; areaId: CurrentContextAreaId };

function formatDateTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/London",
  }).format(date);
}

function ProviderStatus({ status, stale }: { status: string; stale: boolean }) {
  const label = stale ? "Cached" : status === "available" ? "Current" : status === "disabled" ? "Not configured" : "Unavailable";
  return <span className={`${styles.status} ${status === "available" && !stale ? styles.available : styles.neutral}`}>{label}</span>;
}

function TflPanel({ context }: { context: TflCurrentContext }) {
  return (
    <article className={styles.provider} aria-labelledby="current-tfl-title">
      <div className={styles.providerHeading}>
        <h4 id="current-tfl-title">Station and lift reports</h4>
        <ProviderStatus status={context.status} stale={context.stale} />
      </div>
      <p>{context.message}</p>
      {context.issues.length > 0 ? (
        <ul className={styles.records}>
          {context.issues.map((issue, index) => (
            <li key={`${issue.kind}-${index}`}>
              <strong>{issue.kind === "lift" ? "Lift report" : "Station disruption"}</strong>
              <span>{issue.summary}</span>
              {issue.validFrom ? <small>From {formatDateTime(issue.validFrom)}{issue.validTo ? ` to ${formatDateTime(issue.validTo)}` : ""}</small> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className={styles.source}>Source: <a href={context.source.url} target="_blank" rel="noreferrer">{context.source.label}</a>{context.retrievedAt ? `, fetched ${formatDateTime(context.retrievedAt)}` : ""}.</p>
    </article>
  );
}

function WeatherPanel({ context }: { context: MetOfficeCurrentContext }) {
  return (
    <article className={styles.provider} aria-labelledby="current-weather-title">
      <div className={styles.providerHeading}>
        <h4 id="current-weather-title">Weather and UV</h4>
        <ProviderStatus status={context.status} stale={context.stale} />
      </div>
      {context.forecast ? (
        <>
          <dl className={styles.metrics}>
            <div><dt>Air temperature</dt><dd>{context.forecast.temperatureC}°C</dd></div>
            <div><dt>Feels like</dt><dd>{context.forecast.feelsLikeC}°C</dd></div>
            <div><dt>UV index</dt><dd>{context.forecast.uvIndex}</dd></div>
          </dl>
          <p><strong>{context.forecast.condition}.</strong> {context.forecast.cloudContext.label}; this feed does not provide a cloud percentage.</p>
          <p className={styles.source}>Forecast for {formatDateTime(context.forecast.forecastAt)}. Model run {formatDateTime(context.forecast.modelRunAt)}.</p>
        </>
      ) : <p>{context.message}</p>}
      <p className={styles.source}>Source: <a href={context.source.url} target="_blank" rel="noreferrer">{context.source.label}</a>{context.retrievedAt ? `, fetched ${formatDateTime(context.retrievedAt)}` : ""}. Powered by Met Office data.</p>
    </article>
  );
}

function RoadworksPanel({ context }: { context: StreetManagerCurrentContext }) {
  return (
    <article className={styles.provider} aria-labelledby="current-roadworks-title">
      <div className={styles.providerHeading}>
        <h4 id="current-roadworks-title">Reported street works</h4>
        <ProviderStatus status={context.status} stale={context.stale} />
      </div>
      <p>{context.message}</p>
      {context.works.length > 0 ? (
        <ul className={styles.records}>
          {context.works.map((work) => (
            <li key={work.reference}>
              <strong>{work.street}</strong>
              <span>{work.category}; {work.trafficManagement}.</span>
              <small>Permit status: {work.permitStatus}. {formatDateTime(work.startsAt)} to {formatDateTime(work.endsAt)}</small>
            </li>
          ))}
        </ul>
      ) : null}
      {context.recordsLimited ? <p className={styles.source}>Showing the first 12 validated records.</p> : null}
      <p className={styles.source}>Source: <a href={context.source.url} target="_blank" rel="noreferrer">{context.source.label}</a>{context.retrievedAt ? `, fetched ${formatDateTime(context.retrievedAt)}` : ""}.</p>
    </article>
  );
}

export function CurrentJourneyContext({ areaId }: { areaId: CurrentContextAreaId }) {
  const [state, setState] = useState<ViewState>({ kind: "loading", areaId });
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/current-context?area=${encodeURIComponent(areaId)}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        const context = parseCurrentJourneyContextData(payload, areaId);
        if (!response.ok || !context) throw new Error("Current context unavailable");
        setState({ kind: "ready", areaId, context });
      } catch {
        if (!controller.signal.aborted) setState({ kind: "error", areaId });
      }
    }
    void load();
    return () => controller.abort();
  }, [areaId]);

  const viewState: ViewState = state.areaId === areaId ? state : { kind: "loading", areaId };

  return (
    <section className={styles.panel} aria-labelledby={titleId} aria-live="polite">
      <div className={styles.heading}>
        <div>
          <span>Optional live layer</span>
          <h3 id={titleId}>Current journey context</h3>
        </div>
      </div>
      {viewState.kind === "loading" ? <p className={styles.loading}>Checking configured public-data services…</p> : null}
      {viewState.kind === "error" ? <p className={styles.warning}>Current context could not be loaded. The shade comparison still works independently.</p> : null}
      {viewState.kind === "ready" ? (
        <>
          <div className={styles.grid}>
            <TflPanel context={viewState.context.providers.tfl} />
            <WeatherPanel context={viewState.context.providers.weather} />
            <RoadworksPanel context={viewState.context.providers.roadworks} />
          </div>
          <div className={styles.limitations}>
            <strong>How to use this information</strong>
            <ul>{viewState.context.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
          </div>
        </>
      ) : null}
    </section>
  );
}
