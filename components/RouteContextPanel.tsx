"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  buildRouteContextSummary,
  GLA_COOL_SPACES_2025_DATASET_URL,
  GLA_COOL_SPACES_CURRENT_MAP_URL,
  GLA_PUBLIC_REALM_TREES_DATASET_URL,
  LONDON_DATASTORE_TERMS_URL,
  loadRouteContext,
  type RouteContextAreaId,
  type RouteContextCategory,
  type RouteContextData,
  type RouteContextFeature,
  type RouteContextSource,
} from "../lib/route-context";
import type { WalkingRoute } from "../lib/routes";

export interface RouteContextPanelProps {
  areaId: RouteContextAreaId;
  route: Pick<WalkingRoute, "id" | "coordinates">;
  routeName?: string;
  radiusMetres?: number;
}

const CATEGORY_LABELS: Record<RouteContextCategory, string> = {
  "cool-space": "GLA cool spaces (2025 register)",
  "drinking-water": "Drinking water",
  toilet: "Toilets",
  rest: "Benches and rest points",
  tree: "Recorded tree points",
};

type LoadState =
  | { kind: "loading"; areaId: null }
  | { kind: "available"; areaId: RouteContextAreaId; data: RouteContextData }
  | { kind: "error"; areaId: RouteContextAreaId };

function sourceDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(new Date(value));
}

function routePosition(percent: number) {
  if (percent <= 15) return "near the start";
  if (percent >= 85) return "near the destination";
  return "along the route";
}

function detailPhrases(feature: RouteContextFeature) {
  const details = feature.details;
  if (!details) return [];
  const isGlaCoolSpace = "dataset" in feature.sourceRef &&
    feature.sourceRef.dataset === "gla-cool-spaces-2025";
  const recordLabel = isGlaCoolSpace ? "the 2025 GLA register" : "OpenStreetMap";
  const phrases: string[] = [];
  if (details.coolSpaceTier) phrases.push(`Tier ${details.coolSpaceTier} in the 2025 GLA register`);
  if (details.openingHours) {
    phrases.push(`${isGlaCoolSpace ? "2025 register" : "OSM"} hours: ${details.openingHours}`);
  }
  if (details.access === "customers") phrases.push("customer access only");
  else if (details.access === "private") phrases.push("private access");
  if (details.fee === "yes") phrases.push(`fee recorded in ${recordLabel}`);
  else if (details.fee === "no") phrases.push(`no fee recorded in ${recordLabel}`);
  if (details.wheelchair === "yes") phrases.push(`wheelchair access recorded in ${recordLabel}`);
  else if (details.wheelchair === "limited") {
    phrases.push(`limited wheelchair access recorded in ${recordLabel}`);
  } else if (details.wheelchair === "no") {
    phrases.push(`not wheelchair accessible in ${recordLabel}`);
  }
  if (details.backrest === "yes") phrases.push("backrest recorded");
  if (details.treeSpecies) phrases.push(`inventory species: ${details.treeSpecies}`);
  if (details.treeMaintainer) phrases.push(`inventory maintainer: ${details.treeMaintainer}`);
  if (details.treeInventoryLocation === "Highways") {
    phrases.push("classified as Highways in the GLA inventory");
  }
  if (details.level) phrases.push(`level ${details.level}`);
  if (details.checkDate) phrases.push(`checked ${details.checkDate}`);
  if (details.notes) phrases.push(...details.notes);
  return phrases;
}

function sourceDescription(source: RouteContextSource) {
  if (source.url === GLA_COOL_SPACES_2025_DATASET_URL) {
    return `local extract captured ${sourceDate(source.snapshotAt)}`;
  }
  if (source.url === GLA_PUBLIC_REALM_TREES_DATASET_URL) {
    return `source file last modified ${sourceDate(source.snapshotAt)}`;
  }
  return `snapshot ${sourceDate(source.snapshotAt)}`;
}

export function RouteContextPanel({
  areaId,
  route,
  routeName,
  radiusMetres,
}: RouteContextPanelProps) {
  const headingId = useId();
  const [state, setState] = useState<LoadState>({ kind: "loading", areaId: null });

  useEffect(() => {
    const controller = new AbortController();
    void loadRouteContext(areaId, { signal: controller.signal })
      .then((data) => setState({ kind: "available", areaId, data }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "error", areaId });
      });
    return () => controller.abort();
  }, [areaId]);

  const summary = useMemo(
    () => state.kind === "available" && state.areaId === areaId
      ? buildRouteContextSummary(route, state.data, { radiusMetres })
      : null,
    [areaId, radiusMetres, route, state],
  );
  const currentState: LoadState = state.areaId === areaId
    ? state
    : { kind: "loading", areaId: null };

  return (
    <aside className="route-context-panel" aria-labelledby={headingId}>
      <header>
        <span>Local context</span>
        <h3 id={headingId}>
          Cool spaces, water, rest and trees near {routeName ?? "this route"}
        </h3>
      </header>

      {currentState.kind === "loading" ? (
        <p role="status">Loading the local context snapshot…</p>
      ) : null}

      {currentState.kind === "error" ? (
        <p role="status">
          Local context is unavailable. This does not mean that amenities are absent.
        </p>
      ) : null}

      {currentState.kind === "available" && summary ? (
        <>
          <p>
            GLA 2025 cool-space, GLA street-tree inventory and OpenStreetMap records within
            {` ${summary.radiusMetres} m`} straight-line of the route. Records are partial and
            availability is not live.
          </p>
          <div className="route-context-panel__categories">
            {summary.categories.map(({ category, completeness, matches, additionalMatchCount }) => (
              <section key={category} aria-labelledby={`${headingId}-${category}`}>
                <h4 id={`${headingId}-${category}`}>{CATEGORY_LABELS[category]}</h4>
                {matches.length ? (
                  <ul>
                    {matches.map((match) => {
                      const details = detailPhrases(match.feature);
                      return (
                        <li key={match.feature.id}>
                          <a href={match.feature.sourceRef.url} target="_blank" rel="noreferrer">
                            {match.feature.name}
                          </a>
                          <span>
                            {match.distanceFromRouteMetres === 0
                              ? "On the displayed route geometry"
                              : `About ${match.distanceFromRouteMetres} m straight-line from the route`}
                            {` · ${routePosition(match.routeProgressPercent)}`}
                          </span>
                          {match.minimumReturnDetourMetres > 0 ? (
                            <small>
                              Return detour is at least {match.minimumReturnDetourMetres} m; streets,
                              crossings and entrances can make it longer.
                            </small>
                          ) : null}
                          {details.length ? <small>{details.join(" · ")}</small> : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p>
                    {completeness.status === "not-collected"
                      ? "Not collected for this pilot."
                      : category === "cool-space"
                        ? "No nearby site in the local 2025 GLA extract; check the live GLA map for the current scheme."
                        : category === "tree"
                          ? "No nearby point in these partial tree inventories; this is not evidence that no tree exists."
                          : "No nearby record in this partial snapshot; this is not evidence that none exists."}
                  </p>
                )}
                {additionalMatchCount > 0 ? (
                  <small>{additionalMatchCount} more nearby record{additionalMatchCount === 1 ? "" : "s"}.</small>
                ) : null}
                <details>
                  <summary>Coverage note</summary>
                  <p>{completeness.note}</p>
                </details>
              </section>
            ))}
          </div>
          <p className="route-context-panel__source">
            Source snapshots: {[currentState.data.source, ...(currentState.data.additionalSources ?? [])].map((source, index) => (
              <span key={source.url}>
                {index ? "; " : ""}<a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>, {sourceDescription(source)} ({source.licence})
              </span>
            ))}.
            The cool-space entries are from the 2025 register, not the GLA&apos;s live Summer
            2026 map. Check the <a href={GLA_COOL_SPACES_CURRENT_MAP_URL} target="_blank" rel="noreferrer">
              current GLA map
            </a> and the venue before travelling. The dataset page states no dataset-specific
            licence; reuse follows the <a href={LONDON_DATASTORE_TERMS_URL} target="_blank" rel="noreferrer">
              London Datastore terms
            </a>. The GLA cannot warrant the source data&apos;s quality or accuracy, and its use
            here does not imply GLA endorsement, affiliation, support or approval. GLA
            public-realm tree records shown here are inventory points classified as Highways;
            they may be dated or incomplete and do not establish a current tree. Inventory
            points do not establish canopy or usable shade. OpenStreetMap individual-tree
            records have the same shade limitation.
          </p>
        </>
      ) : null}
    </aside>
  );
}
