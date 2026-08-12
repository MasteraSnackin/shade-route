"use client";

import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import type { NamedPoint, PilotArea } from "../lib/routes";

interface ContextFeature {
  id?: string;
  category?: string;
  name?: string;
  coordinate?: [number, number];
}

interface ContextData {
  features?: ContextFeature[];
}

interface PlaceOption extends NamedPoint {
  id: string;
  kind: string;
}

type ContextLoadState =
  | { kind: "loading"; areaId: string; options: PlaceOption[] }
  | { kind: "available"; areaId: string; options: PlaceOption[] }
  | { kind: "error"; areaId: string; options: PlaceOption[] };

interface LocalPlaceSearchProps {
  area: PilotArea;
  endpoint: NamedPoint;
  endpointLabel: "Start" | "Destination";
  onSelect: (point: NamedPoint) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  "cool-space": "Recorded cool space",
  "drinking-water": "Recorded drinking water",
  toilet: "Recorded toilet",
  rest: "Recorded rest point",
  tree: "Named tree",
};

function insideArea(coordinate: [number, number], area: PilotArea) {
  const [west, south, east, north] = area.bbox;
  return coordinate[0] >= west && coordinate[0] <= east && coordinate[1] >= south && coordinate[1] <= north;
}

function pilotOptions(area: PilotArea): PlaceOption[] {
  return [area.start, area.destination].map((point, index) => ({
    ...point,
    id: `${area.id}-pilot-${index}`,
    kind: "Pilot landmark",
  }));
}

function contextOptions(value: unknown, area: PilotArea): PlaceOption[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as ContextData).features)) {
    throw new Error("Local place records were not in the expected format.");
  }
  const seenNames = new Set<string>();
  return (value as ContextData).features!.flatMap((feature, index): PlaceOption[] => {
    const name = feature?.name?.trim();
    const coordinate = feature?.coordinate;
    const normalisedName = name?.toLocaleLowerCase("en-GB");
    if (
      !name ||
      !normalisedName ||
      seenNames.has(normalisedName) ||
      !Array.isArray(coordinate) ||
      coordinate.length !== 2 ||
      !coordinate.every(Number.isFinite) ||
      !insideArea(coordinate as [number, number], area)
    ) return [];
    seenNames.add(normalisedName);
    return [{
      id: feature.id ?? `${area.id}-context-${index}`,
      name,
      lon: coordinate[0],
      lat: coordinate[1],
      kind: CATEGORY_LABELS[feature.category ?? ""] ?? "Local landmark",
    }];
  });
}

async function loadLocalPlaceOptions(
  area: PilotArea,
  options: { signal?: AbortSignal; fetchImplementation?: typeof fetch } = {},
) {
  const response = await (options.fetchImplementation ?? fetch)(`/data/context-${area.id}.json`, {
    signal: options.signal,
  });
  if (!response.ok) throw new Error("Local place records could not be loaded.");
  return contextOptions(await response.json(), area);
}

export function LocalPlaceSearch({ area, endpoint, endpointLabel, onSelect }: LocalPlaceSearchProps) {
  const inputId = useId();
  const listboxId = useId();
  const helpId = useId();
  const [contextState, setContextState] = useState<ContextLoadState>({
    kind: "loading",
    areaId: "",
    options: [],
  });
  const [retrySequence, setRetrySequence] = useState(0);
  const [editingQuery, setEditingQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const query = editingQuery ?? endpoint.name;

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    void loadLocalPlaceOptions(area, { signal: controller.signal })
      .then((loadedOptions) => {
        if (!current) return;
        setContextState({ kind: "available", areaId: area.id, options: loadedOptions });
      })
      .catch(() => {
        if (current && !controller.signal.aborted) {
          setContextState({ kind: "error", areaId: area.id, options: [] });
        }
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [area, retrySequence]);

  const currentContextState: ContextLoadState = contextState.areaId === area.id
    ? contextState
    : { kind: "loading", areaId: area.id, options: [] };

  const options = useMemo(() => [
    ...pilotOptions(area),
    ...currentContextState.options,
  ], [area, currentContextState.options]);
  const filteredOptions = useMemo(() => {
    const normalisedQuery = query === endpoint.name ? "" : query.trim().toLocaleLowerCase("en-GB");
    const matches = normalisedQuery
      ? options.filter((option) => `${option.name} ${option.kind}`.toLocaleLowerCase("en-GB").includes(normalisedQuery))
      : options;
    return matches.slice(0, 8);
  }, [endpoint.name, options, query]);

  const safeActiveIndex = Math.min(activeIndex, Math.max(0, filteredOptions.length - 1));

  const choose = (option: PlaceOption) => {
    setEditingQuery(null);
    setOpen(false);
    setActiveIndex(0);
    onSelect({ name: option.name, lat: option.lat, lon: option.lon });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => filteredOptions.length ? (current + 1) % filteredOptions.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => filteredOptions.length
        ? (current - 1 + filteredOptions.length) % filteredOptions.length
        : 0);
    } else if (event.key === "Enter" && open && filteredOptions[safeActiveIndex]) {
      event.preventDefault();
      choose(filteredOptions[safeActiveIndex]);
    } else if (event.key === "Escape") {
      setOpen(false);
      setEditingQuery(null);
    }
  };

  return (
    <div
      className="local-place-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setEditingQuery(null);
        }
      }}
    >
      <label className="field-label" htmlFor={inputId}>{endpointLabel}</label>
      <input
        id={inputId}
        type="search"
        value={query}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-activedescendant={open && filteredOptions[safeActiveIndex]
          ? `${listboxId}-${filteredOptions[safeActiveIndex].id}`
          : undefined}
        aria-describedby={helpId}
        autoComplete="off"
        onFocus={(event) => {
          setOpen(true);
          event.currentTarget.select();
        }}
        onChange={(event) => {
          setEditingQuery(event.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={handleKeyDown}
      />
      {open && (
        <div className="local-place-popup">
          {currentContextState.kind === "error" ? (
            <div className="local-place-load-error" role="status">
              <span>Local amenity places could not be loaded. The two pilot landmarks are still available.</span>
              <button
                type="button"
                onClick={() => {
                  setContextState({ kind: "loading", areaId: area.id, options: [] });
                  setRetrySequence((current) => current + 1);
                }}
              >
                Retry local places
              </button>
            </div>
          ) : null}
          <ul id={listboxId} className="local-place-results" role="listbox" aria-label={`${endpointLabel} places`}>
            {filteredOptions.length ? filteredOptions.map((option, index) => (
              <li
                key={option.id}
                id={`${listboxId}-${option.id}`}
                role="option"
                aria-selected={index === safeActiveIndex}
                tabIndex={-1}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") choose(option);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <strong>{option.name}</strong>
                <span>{option.kind}</span>
              </li>
            )) : (
              <li className="is-empty" role="option" aria-selected="false">No bundled place matches that search.</li>
            )}
          </ul>
        </div>
      )}
      <small id={helpId} className="visually-hidden">
        Search pilot landmarks and partial local amenity records stored in this data pack. Use the map button for an exact point.
      </small>
      <span className="visually-hidden" aria-live="polite">
        {open
          ? `${filteredOptions.length} local place ${filteredOptions.length === 1 ? "match" : "matches"}.${currentContextState.kind === "error" ? " Local amenity places are unavailable; pilot landmarks remain available." : ""}`
          : ""}
      </span>
    </div>
  );
}
