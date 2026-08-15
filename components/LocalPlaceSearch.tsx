"use client";

import { useEffect, useId, useMemo, useState, type KeyboardEvent, type Ref } from "react";
import { fetchOnlinePlaceSearch } from "../lib/place-search-client";
import {
  PLACE_SEARCH_MAX_QUERY_LENGTH,
  PLACE_SEARCH_MIN_QUERY_LENGTH,
  normalisePlaceSearchQuery,
  type OnlinePlaceResult,
} from "../lib/place-search-contract";
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

type OnlineSearchState =
  | { kind: "idle" }
  | { kind: "searching"; key: string }
  | { kind: "available"; key: string; options: PlaceOption[] }
  | { kind: "unavailable"; key: string };

interface LocalPlaceSearchProps {
  area: PilotArea;
  endpoint: NamedPoint;
  endpointLabel: "Start" | "Destination";
  inputRef?: Ref<HTMLInputElement>;
  onEditingChange?: (editing: boolean) => void;
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

function onlineOptions(results: OnlinePlaceResult[]): PlaceOption[] {
  return results.map((result) => ({ ...result }));
}

function uniquePlaceOptions(options: PlaceOption[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.name.toLocaleLowerCase("en-GB")}:${option.lon.toFixed(5)}:${option.lat.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function LocalPlaceSearch({
  area,
  endpoint,
  endpointLabel,
  inputRef,
  onEditingChange,
  onSelect,
}: LocalPlaceSearchProps) {
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
  const [onlineState, setOnlineState] = useState<OnlineSearchState>({ kind: "idle" });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const query = editingQuery ?? endpoint.name;
  const typedQuery = editingQuery === null ? null : normalisePlaceSearchQuery(editingQuery);
  const onlineSearchKey = typedQuery
    ? `${area.id}:${typedQuery.toLocaleLowerCase("en-GB")}`
    : null;

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

  useEffect(() => {
    if (!typedQuery || !onlineSearchKey) return;

    let current = true;
    const controller = new AbortController();
    const debounceId = setTimeout(() => {
      void fetchOnlinePlaceSearch(area, typedQuery, { signal: controller.signal })
        .then((response) => {
          if (!current) return;
          setOnlineState(response.status === "available"
            ? { kind: "available", key: onlineSearchKey, options: onlineOptions(response.results) }
            : { kind: "unavailable", key: onlineSearchKey });
        })
        .catch(() => {
          if (current && !controller.signal.aborted) {
            setOnlineState({ kind: "unavailable", key: onlineSearchKey });
          }
        });
    }, 350);

    return () => {
      current = false;
      clearTimeout(debounceId);
      controller.abort();
    };
  }, [area, onlineSearchKey, typedQuery]);

  const currentContextState: ContextLoadState = contextState.areaId === area.id
    ? contextState
    : { kind: "loading", areaId: area.id, options: [] };

  const options = useMemo(() => [
    ...pilotOptions(area),
    ...currentContextState.options,
  ], [area, currentContextState.options]);
  const currentOnlineState = useMemo<OnlineSearchState>(
    () => onlineSearchKey && "key" in onlineState && onlineState.key === onlineSearchKey
      ? onlineState
      : onlineSearchKey
        ? { kind: "searching", key: onlineSearchKey }
        : { kind: "idle" },
    [onlineSearchKey, onlineState],
  );
  const filteredOptions = useMemo(() => {
    const normalisedQuery = query === endpoint.name ? "" : query.trim().toLocaleLowerCase("en-GB");
    const localMatches = normalisedQuery
      ? options.filter((option) => `${option.name} ${option.kind}`.toLocaleLowerCase("en-GB").includes(normalisedQuery))
      : options;
    const remoteMatches = currentOnlineState.kind === "available" ? currentOnlineState.options : [];
    return uniquePlaceOptions([...localMatches, ...remoteMatches]).slice(0, 8);
  }, [currentOnlineState, endpoint.name, options, query]);

  const safeActiveIndex = Math.min(activeIndex, Math.max(0, filteredOptions.length - 1));

  const choose = (option: PlaceOption) => {
    setEditingQuery(null);
    onEditingChange?.(false);
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
      onEditingChange?.(false);
    }
  };

  return (
    <div
      className="local-place-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <label className="field-label" htmlFor={inputId}>{endpointLabel} location</label>
      <input
        ref={inputRef}
        id={inputId}
        type="search"
        placeholder={`Enter ${endpointLabel.toLocaleLowerCase("en-GB")} place or postcode`}
        value={query}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-activedescendant={open && filteredOptions[safeActiveIndex]
          ? `${listboxId}-${filteredOptions[safeActiveIndex].id}`
          : undefined}
        aria-describedby={helpId}
        aria-busy={currentOnlineState.kind === "searching"}
        autoComplete="off"
        maxLength={PLACE_SEARCH_MAX_QUERY_LENGTH}
        onFocus={(event) => {
          setOpen(true);
          event.currentTarget.select();
        }}
        onChange={(event) => {
          setEditingQuery(event.target.value);
          onEditingChange?.(true);
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
          {currentOnlineState.kind === "unavailable" ? (
            <div className="local-place-load-error" role="status">
              <span>Online place search is unavailable. Bundled pilot places remain available.</span>
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
              <li className="is-empty" role="presentation">
                {currentOnlineState.kind === "searching"
                  ? "Searching online places…"
                  : editingQuery !== null && editingQuery.trim().length < PLACE_SEARCH_MIN_QUERY_LENGTH
                    ? `Type at least ${PLACE_SEARCH_MIN_QUERY_LENGTH} characters to search online.`
                    : "No place matches that search."}
              </li>
            )}
          </ul>
        </div>
      )}
      <small
        id={helpId}
        className={`local-place-hint${editingQuery !== null ? " is-warning" : ""}`}
        aria-live="polite"
      >
        {editingQuery !== null
          ? "Choose a matching result or use Map to set this location."
          : "Enter an address, place or postcode in this pilot area, then choose a match. Use Map for an exact point."}
      </small>
      <span className="visually-hidden" aria-live="polite">
        {open
          ? `${filteredOptions.length} place ${filteredOptions.length === 1 ? "match" : "matches"}.` +
            `${currentOnlineState.kind === "searching" ? " Searching online places." : ""}` +
            `${currentOnlineState.kind === "unavailable" ? " Online place search is unavailable; bundled pilot places remain available." : ""}` +
            `${currentContextState.kind === "error" ? " Local amenity places are unavailable; pilot landmarks remain available." : ""}`
          : ""}
      </span>
    </div>
  );
}
