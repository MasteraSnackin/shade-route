"use client";

import * as maplibregl from "maplibre-gl";
import mapLibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type {
  CanvasSource,
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  StyleSpecification,
} from "maplibre-gl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Coordinate, NamedPoint, PilotArea, WalkingRoute } from "../lib/routes";
import { loadHeightGrid, type ExposureSection, type ScheduleScore } from "../lib/raster-shade";
import {
  createShadowGridInitialisation,
  createShadowRenderRequest,
  groundShadowFrameFromResponse,
  isShadowRenderResponse,
  isShadowRenderResponseForGeneration,
  SHADOW_RENDER_FAILURE,
} from "../lib/shadow-worker-protocol";
import {
  GROUND_SHADOW_LEGEND,
  heightGridCanvasCoordinates,
  renderGroundShadowFrame,
} from "../lib/shadow-raster";
import type { GroundShadowFrame } from "../lib/shadow-raster";
import {
  concealGroundShadowOverlay,
  groundShadowUnavailableMessage,
  GROUND_SHADOW_LAYER_ID as SHADOW_LAYER_ID,
  GROUND_SHADOW_SOURCE_ID as SHADOW_SOURCE_ID,
  type GroundShadowUnavailableReason,
} from "../lib/ground-shadow-overlay";
import { loadRouteContext, type RouteContextCategory } from "../lib/route-context";
import shadowWorkerUrl from "../workers/shadow-worker.ts?worker&url";

const ROUTE_COLOURS = ["#075f56", "#c25425", "#4e4d91"];
const ROUTE_DASHES: number[][] = [[1, 0], [2, 1.5], [0.5, 1.2]];

export type MapExposureCategory = "sun" | "shade" | "uncertain" | "unknown" | "night";

export interface MapExposureLegendItem {
  category: MapExposureCategory;
  label: string;
  colour: string;
  dash: number[];
}

/** Shared with the textual legend so the map and its explanation cannot drift. */
export const MAP_EXPOSURE_LEGEND: readonly MapExposureLegendItem[] = [
  { category: "sun", label: "Potential direct sun", colour: "#c94f20", dash: [1, 0] },
  { category: "shade", label: "Estimated shade", colour: "#00796b", dash: [3, 1.2] },
  { category: "uncertain", label: "Uncertain", colour: "#6a5d91", dash: [0.35, 1.1] },
  { category: "unknown", label: "Unknown or unmodelled", colour: "#59625e", dash: [0.4, 0.8, 2.2, 0.8] },
  { category: "night", label: "After sunset", colour: "#344553", dash: [4, 1] },
];

export const MAP_CONTEXT_LEGEND: ReadonlyArray<{
  category: RouteContextCategory;
  label: string;
  colour: string;
}> = [
  { category: "cool-space", label: "Official cool space", colour: "#2d5f9a" },
  { category: "drinking-water", label: "Drinking water", colour: "#1685aa" },
  { category: "toilet", label: "Toilet", colour: "#6d5594" },
  { category: "rest", label: "Recorded rest point", colour: "#9a6731" },
  { category: "tree", label: "Recorded individual tree", colour: "#3e7c3d" },
];

const CONTEXT_COLOUR_EXPRESSION: ExpressionSpecification = [
  "match",
  ["get", "category"],
  "cool-space",
  "#2d5f9a",
  "drinking-water",
  "#1685aa",
  "toilet",
  "#6d5594",
  "rest",
  "#9a6731",
  "tree",
  "#3e7c3d",
  "#59625e",
];

const EXPOSURE_SOURCE_ID = "selected-route-exposure";
const ACTIVE_DIRECTION_SOURCE_ID = "active-route-direction";
const ACTIVE_DIRECTION_CASING_ID = "active-route-direction-casing";
const ACTIVE_DIRECTION_LAYER_ID = "active-route-direction-line";
const CONTEXT_SOURCE_ID = "route-context-points";
const CONTEXT_LAYER_ID = "route-context-points-layer";
const MAP_LOAD_TIMEOUT_MS = 20_000;
const SHADOW_WORKER_TIMEOUT_MS = 8_000;
const EMPTY_FEATURE_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [],
};

interface SunPositionStatus {
  dateEpochMs: number;
  isDaylight: boolean;
  azimuthDeg: number;
  altitudeDeg: number;
  lowSun: boolean;
  certainShadowPercent: number;
  possibleShadowPercent: number;
  unknownPercent: number;
  searchLimitedPercent: number;
  raySearchLimitMetres: number;
  lowSunThresholdDegrees: number;
}

type ShadowOverlayStatus =
  | { phase: "idle" }
  | {
      phase: "loading";
      generation: number;
      dateEpochMs: number;
    }
  | {
      phase: "ready";
      generation: number;
      dateEpochMs: number;
      renderMode: "worker" | "fallback";
    }
  | {
      phase: "unavailable";
      generation: number;
      dateEpochMs: number;
      message: string;
    };

interface ShadowWorkerGridState {
  worker: Worker;
  areaId: string;
  grid: Awaited<ReturnType<typeof loadHeightGrid>>;
  version: number;
}

interface RouteMapProps {
  area: PilotArea;
  routes: WalkingRoute[];
  scores: ScheduleScore[];
  departureDate: Date | null;
  timeLabel: string;
  selectedRouteId: string | null;
  origin: NamedPoint;
  destination: NamedPoint;
  picking: "origin" | "destination" | null;
  activeDirectionIndex?: number | null;
  onMapPick: (coordinate: Coordinate) => void;
  onRouteSelect: (routeId: string) => void;
  onRouteSegmentSelect?: (routeSegmentIndex: number) => void;
}

function featureCollectionForRoute(route: WalkingRoute) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "LineString" as const, coordinates: route.coordinates },
      },
    ],
  };
}

function exposureCategory(section: ExposureSection): MapExposureCategory {
  const declared = (section as ExposureSection & { exposure?: string }).exposure;
  if (MAP_EXPOSURE_LEGEND.some(({ category }) => category === declared)) {
    return declared as MapExposureCategory;
  }
  return "unknown";
}

function featureCollectionForExposure(sections: ExposureSection[], routeId: string) {
  return {
    type: "FeatureCollection" as const,
    features: sections.map((section) => ({
      type: "Feature" as const,
      properties: {
        exposure: exposureCategory(section),
        routeId,
        routeSegmentIndex: section.routeSegmentIndex,
      },
      geometry: {
        type: "LineString" as const,
        coordinates: [section.start, section.end],
      },
    })),
  };
}

function markerElement(kind: "origin" | "destination") {
  const element = document.createElement("div");
  element.className = `map-point map-point-${kind}`;
  element.setAttribute("aria-hidden", "true");
  element.textContent = kind === "origin" ? "A" : "B";
  return element;
}

function mapTransitionDuration() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 500;
}

function sunDirection(azimuthDeg: number) {
  const directions = [
    "north",
    "north-east",
    "east",
    "south-east",
    "south",
    "south-west",
    "west",
    "north-west",
  ];
  const normalised = ((azimuthDeg % 360) + 360) % 360;
  return directions[Math.round(normalised / 45) % directions.length];
}

function formatAngle(value: number) {
  return `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}°`;
}

function formatCoveragePercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function groundShadowCoverageStatus(status: SunPositionStatus) {
  if (!status.isDaylight) return "No direct sun while the sun is below the horizon";
  const parts = [
    `${formatCoveragePercent(status.certainShadowPercent)} shade supported by both height bounds`,
    `${formatCoveragePercent(status.possibleShadowPercent)} possible shade within the height range`,
  ];
  if (status.unknownPercent > 0) {
    parts.push(`${formatCoveragePercent(status.unknownPercent)} unknown`);
  }
  if (status.searchLimitedPercent > 0) {
    parts.push(
      `${formatCoveragePercent(status.searchLimitedPercent)} unresolved at the ${status.raySearchLimitMetres} m ray-search cap`,
    );
  }
  return parts.join(" · ");
}

function groundShadowLimitWarning(status: SunPositionStatus) {
  if (!status.isDaylight) return null;
  const reasons: string[] = [];
  if (status.lowSun) {
    reasons.push(
      `sun altitude is below ${status.lowSunThresholdDegrees}°, so long casts are especially sensitive to height error`,
    );
  }
  if (status.searchLimitedPercent > 0) {
    reasons.push(
      `rays stop at ${status.raySearchLimitMetres} m, so longer possible shadows are not shown as shade`,
    );
  }
  return reasons.length ? `Model warning: ${reasons.join("; ")}.` : null;
}

export function RouteMap({
  area,
  routes,
  scores,
  departureDate,
  timeLabel,
  selectedRouteId,
  origin,
  destination,
  picking,
  activeDirectionIndex = null,
  onMapPick,
  onRouteSelect,
  onRouteSegmentSelect,
}: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const originMarkerRef = useRef<maplibregl.Marker | null>(null);
  const destinationMarkerRef = useRef<maplibregl.Marker | null>(null);
  const contextPopupRef = useRef<maplibregl.Popup | null>(null);
  const pickingRef = useRef(picking);
  const pickCallbackRef = useRef(onMapPick);
  const selectCallbackRef = useRef(onRouteSelect);
  const segmentSelectCallbackRef = useRef(onRouteSegmentSelect);
  const routeIdsByLayerRef = useRef<Record<string, string | undefined>>({});
  const selectedRouteIdRef = useRef(selectedRouteId);
  const lastFittedRoutesRef = useRef("");
  const previousActiveDirectionRef = useRef<number | null>(null);
  const shadowCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const shadowWorkerRef = useRef<Worker | null>(null);
  const shadowWorkerGridRef = useRef<ShadowWorkerGridState | null>(null);
  const shadowGenerationRef = useRef(0);
  const shadowGridVersionRef = useRef(0);
  const [sunPosition, setSunPosition] = useState<SunPositionStatus | null>(null);
  const [shadowOverlayStatus, setShadowOverlayStatus] =
    useState<ShadowOverlayStatus>({ phase: "idle" });
  const [mapFailure, setMapFailure] = useState<string | null>(null);

  // This runs before paint on updates, so a frame from the previous time can
  // never remain visible while the next worker generation is pending.
  useLayoutEffect(() => {
    const generation = shadowGenerationRef.current + 1;
    shadowGenerationRef.current = generation;
    const map = mapRef.current;
    if (map) concealGroundShadowOverlay(map);
    // This state transition is deliberately synchronous: React flushes layout
    // effects before paint, keeping the visible status in step with the
    // already-concealed MapLibre canvas layer.
    setShadowOverlayStatus(
      departureDate
        ? { phase: "loading", generation, dateEpochMs: departureDate.getTime() }
        : { phase: "idle" },
    );
  }, [area, departureDate, routes]);

  useEffect(() => {
    pickingRef.current = picking;
    pickCallbackRef.current = onMapPick;
    selectCallbackRef.current = onRouteSelect;
    segmentSelectCallbackRef.current = onRouteSegmentSelect;
    selectedRouteIdRef.current = selectedRouteId;
  }, [picking, onMapPick, onRouteSelect, onRouteSegmentSelect, selectedRouteId]);

  useEffect(() => () => {
    shadowGenerationRef.current += 1;
    shadowWorkerRef.current?.terminate();
    shadowWorkerRef.current = null;
    shadowWorkerGridRef.current = null;
    contextPopupRef.current?.remove();
    contextPopupRef.current = null;
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    setMapFailure(null);
    // Vinext cannot infer MapLibre's default sibling worker at runtime. Giving
    // Vite the worker entry explicitly emits a same-origin, hashed asset.
    maplibregl.setWorkerUrl(mapLibreWorkerUrl);
    const localStyle: StyleSpecification = {
      version: 8,
      sources: {
        "pilot-map": {
          type: "geojson",
          data: `/data/${area.id}-map.json`,
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
        },
      },
      layers: [
        { id: "paper", type: "background", paint: { "background-color": "#f3f0e8" } },
        {
          id: "green-space",
          type: "fill",
          source: "pilot-map",
          filter: ["==", ["get", "kind"], "green"],
          paint: { "fill-color": "#d8e8d8", "fill-opacity": 0.9 },
        },
        {
          id: "water",
          type: "fill",
          source: "pilot-map",
          filter: ["==", ["get", "kind"], "water"],
          paint: { "fill-color": "#bad9dc", "fill-opacity": 1 },
        },
        {
          id: "road-casing",
          type: "line",
          source: "pilot-map",
          filter: ["==", ["get", "kind"], "road"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#cac6bc",
            "line-width": [
              "match", ["get", "class"],
              ["motorway", "trunk", "primary"], 7,
              ["secondary", "tertiary"], 5,
              ["footway", "path", "steps", "pedestrian"], 2.3,
              3.5,
            ],
          },
        },
        {
          id: "roads",
          type: "line",
          source: "pilot-map",
          filter: ["==", ["get", "kind"], "road"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": [
              "match", ["get", "class"],
              ["footway", "path", "steps", "pedestrian"], "#f8f5ee",
              "#fffefa",
            ],
            "line-width": [
              "match", ["get", "class"],
              ["motorway", "trunk", "primary"], 5.4,
              ["secondary", "tertiary"], 3.7,
              ["footway", "path", "steps", "pedestrian"], 1.2,
              2.4,
            ],
          },
        },
        {
          id: "buildings",
          type: "fill-extrusion",
          source: "pilot-map",
          filter: ["==", ["get", "kind"], "building"],
          paint: {
            "fill-extrusion-color": [
              "interpolate", ["linear"], ["coalesce", ["get", "heightMetres"], 12],
              0, "#ddd8cc",
              24, "#c9c2b4",
              80, "#b1ada5",
            ],
            "fill-extrusion-height": ["coalesce", ["get", "heightMetres"], 12],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": 0.98,
            "fill-extrusion-vertical-gradient": true,
          },
        },
      ],
    };
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: localStyle,
      bounds: [
        [area.bbox[0], area.bbox[1]],
        [area.bbox[2], area.bbox[3]],
      ],
      fitBoundsOptions: { padding: 44 },
      attributionControl: { compact: true },
      pitch: 52,
      bearing: -24,
      canvasContextAttributes: { antialias: true },
    });
    let styleReady = false;
    const handleLoad = () => {
      styleReady = true;
      setMapFailure(null);
    };
    const handleMapError = (event: maplibregl.ErrorEvent) => {
      console.error("Unable to render the local 3D map.", event.error);
      if (!styleReady) {
        setMapFailure("The local 3D map could not start. Reload this page to retry.");
      }
    };
    const loadTimer = window.setTimeout(() => {
      if (!styleReady) {
        setMapFailure("The local 3D map did not finish loading. Reload this page to retry.");
      }
    }, MAP_LOAD_TIMEOUT_MS);
    map.on("load", handleLoad);
    map.on("error", handleMapError);
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
    map.on("click", (event) => {
      if (pickingRef.current) pickCallbackRef.current([event.lngLat.lng, event.lngLat.lat]);
    });
    mapRef.current = map;
    return () => {
      window.clearTimeout(loadTimer);
      map.off("load", handleLoad);
      map.off("error", handleMapError);
      map.remove();
      mapRef.current = null;
    };
  }, [area.bbox, area.id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let active = true;
    const update = () => {
      if (!active || mapRef.current !== map) return;
      const boundary = {
        type: "FeatureCollection" as const,
        features: [
          {
            type: "Feature" as const,
            properties: {},
            geometry: {
              type: "Polygon" as const,
              coordinates: [[
                [area.bbox[0], area.bbox[1]],
                [area.bbox[2], area.bbox[1]],
                [area.bbox[2], area.bbox[3]],
                [area.bbox[0], area.bbox[3]],
                [area.bbox[0], area.bbox[1]],
              ]],
            },
          },
        ],
      };
      const source = map.getSource("pilot-boundary") as GeoJSONSource | undefined;
      if (source) source.setData(boundary);
      else {
        map.addSource("pilot-boundary", { type: "geojson", data: boundary });
        map.addLayer({
          id: "pilot-boundary-fill",
          type: "fill",
          source: "pilot-boundary",
          paint: { "fill-color": "#087f70", "fill-opacity": 0.035 },
        });
        map.addLayer({
          id: "pilot-boundary-line",
          type: "line",
          source: "pilot-boundary",
          paint: { "line-color": "#087f70", "line-opacity": 0.45, "line-dasharray": [2, 2] },
        });
      }
    };
    if (map.isStyleLoaded()) update();
    else map.once("load", update);
    map.fitBounds(
      [
        [area.bbox[0], area.bbox[1]],
        [area.bbox[2], area.bbox[3]],
      ],
      { padding: 44, duration: mapTransitionDuration(), pitch: 52, bearing: -24 },
    );
    return () => {
      active = false;
      map.off("load", update);
    };
  }, [area]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let active = true;
    const controller = new AbortController();

    const updateContext = async () => {
      try {
        const data = await loadRouteContext(area.id, { signal: controller.signal });
        if (!active || mapRef.current !== map) return;
        const geojson = {
          type: "FeatureCollection" as const,
          features: data.features.map((feature) => ({
            type: "Feature" as const,
            properties: {
              id: feature.id,
              category: feature.category,
              name: feature.name,
            },
            geometry: { type: "Point" as const, coordinates: feature.coordinate },
          })),
        };
        const source = map.getSource(CONTEXT_SOURCE_ID) as GeoJSONSource | undefined;
        if (source) source.setData(geojson);
        else map.addSource(CONTEXT_SOURCE_ID, { type: "geojson", data: geojson });
        if (!map.getLayer(CONTEXT_LAYER_ID)) {
          map.addLayer({
            id: CONTEXT_LAYER_ID,
            type: "circle",
            source: CONTEXT_SOURCE_ID,
            paint: {
              "circle-color": CONTEXT_COLOUR_EXPRESSION,
              "circle-radius": [
                "match", ["get", "category"],
                "cool-space", 7,
                "drinking-water", 6,
                "toilet", 6,
                "rest", 5,
                "tree", 4,
                5,
              ],
              "circle-stroke-color": "#fffefa",
              "circle-stroke-width": 2,
              "circle-opacity": 0.96,
            },
          });
          map.on("click", CONTEXT_LAYER_ID, (event) => {
            if (pickingRef.current) return;
            const feature = event.features?.[0];
            if (feature?.geometry.type !== "Point") return;
            const coordinates = feature.geometry.coordinates as Coordinate;
            const category = String(feature.properties?.category ?? "record");
            const legend = MAP_CONTEXT_LEGEND.find((item) => item.category === category);
            const content = document.createElement("div");
            const title = document.createElement("strong");
            title.textContent = String(feature.properties?.name ?? "Local context record");
            const note = document.createElement("p");
            note.textContent = `${legend?.label ?? "Local context record"}. Availability and access are not live.`;
            content.append(title, note);
            contextPopupRef.current?.remove();
            contextPopupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" })
              .setLngLat(coordinates)
              .setDOMContent(content)
              .addTo(map);
          });
          map.on("mouseenter", CONTEXT_LAYER_ID, () => {
            if (!pickingRef.current) map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", CONTEXT_LAYER_ID, () => {
            map.getCanvas().style.cursor = pickingRef.current ? "crosshair" : "";
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("Unable to load local context records.", error);
      }
    };

    if (map.isStyleLoaded()) void updateContext();
    else map.once("load", updateContext);
    return () => {
      active = false;
      controller.abort();
      contextPopupRef.current?.remove();
      contextPopupRef.current = null;
      map.off("load", updateContext);
    };
  }, [area.id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !departureDate) return;
    let active = true;
    let pauseTimer: number | undefined;
    let workerTimer: number | undefined;
    let removeWorkerListeners: (() => void) | undefined;
    const generation = shadowGenerationRef.current;
    const dateEpochMs = departureDate.getTime();
    concealGroundShadowOverlay(map);

    const markUnavailable = (reason: GroundShadowUnavailableReason) => {
      if (
        !active ||
        shadowGenerationRef.current !== generation ||
        mapRef.current !== map
      ) return;
      concealGroundShadowOverlay(map);
      setSunPosition(null);
      setShadowOverlayStatus({
        phase: "unavailable",
        generation,
        dateEpochMs,
        message: groundShadowUnavailableMessage(reason, SHADOW_WORKER_TIMEOUT_MS),
      });
    };

    const applyShadowFrame = (
      grid: Awaited<ReturnType<typeof loadHeightGrid>>,
      frame: GroundShadowFrame,
      renderMode: "worker" | "fallback",
    ) => {
      if (
        !active ||
        shadowGenerationRef.current !== generation ||
        mapRef.current !== map
      ) return;

      try {
        const canvas = shadowCanvasRef.current ?? document.createElement("canvas");
        shadowCanvasRef.current = canvas;
        if (canvas.width !== frame.width || canvas.height !== frame.height) {
          canvas.width = frame.width;
          canvas.height = frame.height;
        }
        const context = canvas.getContext("2d");
        if (!context) throw new Error("The ground-shadow canvas is unavailable.");
        const imagePixels = frame.pixels as Uint8ClampedArray<ArrayBuffer>;
        context.putImageData(new ImageData(imagePixels, frame.width, frame.height), 0, 0);

        const coordinates = heightGridCanvasCoordinates(grid);
        const source = map.getSource(SHADOW_SOURCE_ID) as CanvasSource | undefined;
        if (source) {
          source.setCoordinates(coordinates);
          source.play();
        } else {
          map.addSource(SHADOW_SOURCE_ID, {
            type: "canvas",
            canvas,
            animate: true,
            coordinates,
          });
          map.addLayer(
            {
              id: SHADOW_LAYER_ID,
              type: "raster",
              source: SHADOW_SOURCE_ID,
              paint: {
                "raster-opacity": frame.isDaylight ? 0.88 : 0.72,
                "raster-fade-duration": 0,
                "raster-resampling": "nearest",
              },
            },
            "buildings",
          );
        }
        map.setPaintProperty(
          SHADOW_LAYER_ID,
          "raster-opacity",
          frame.isDaylight ? 0.88 : 0.72,
        );
        map.setLight({
          anchor: "map",
          color: frame.isDaylight ? "#fff4d4" : "#b9c9d6",
          intensity: frame.isDaylight ? 0.58 : 0.16,
          position: [1.5, frame.azimuthDeg, Math.max(0, 90 - frame.altitudeDeg)],
        });
        setSunPosition({
          dateEpochMs,
          isDaylight: frame.isDaylight,
          azimuthDeg: frame.azimuthDeg,
          altitudeDeg: frame.altitudeDeg,
          lowSun: frame.lowSun,
          certainShadowPercent: frame.certainShadowPercent,
          possibleShadowPercent: frame.possibleShadowPercent,
          unknownPercent: frame.unknownPercent,
          searchLimitedPercent: frame.searchLimitedPercent,
          raySearchLimitMetres: frame.raySearchLimitMetres,
          lowSunThresholdDegrees: frame.lowSunThresholdDegrees,
        });
        setShadowOverlayStatus({
          phase: "ready",
          generation,
          dateEpochMs,
          renderMode,
        });
        map.triggerRepaint();
        if (pauseTimer) window.clearTimeout(pauseTimer);
        pauseTimer = window.setTimeout(() => {
          (map.getSource(SHADOW_SOURCE_ID) as CanvasSource | undefined)?.pause();
        }, 100);
      } catch (error) {
        console.error("Unable to apply the current ground-shadow frame.", error);
        markUnavailable("render");
      }
    };

    const updateShadows = async () => {
      let grid: Awaited<ReturnType<typeof loadHeightGrid>>;
      try {
        grid = await loadHeightGrid(area.id);
      } catch (error) {
        console.error("Unable to load ground-shadow coverage.", error);
        markUnavailable("height-data");
        return;
      }
      if (
        !active ||
        shadowGenerationRef.current !== generation ||
        mapRef.current !== map
      ) return;

      const centre: Coordinate = [
        (area.bbox[0] + area.bbox[2]) / 2,
        (area.bbox[1] + area.bbox[3]) / 2,
      ];
      let fallbackAttempted = false;
      const renderFallback = (workerError?: unknown) => {
        if (
          fallbackAttempted ||
          !active ||
          shadowGenerationRef.current !== generation ||
          mapRef.current !== map
        ) return;
        fallbackAttempted = true;
        if (workerError !== undefined) {
          console.error(
            "The background ground-shadow renderer failed; using the on-device fallback.",
            workerError,
          );
        }
        try {
          const frame = renderGroundShadowFrame(grid, departureDate, centre);
          applyShadowFrame(grid, frame, "fallback");
        } catch (error) {
          console.error("Unable to render the fallback ground-shadow frame.", error);
          markUnavailable("render");
        }
      };
      if (typeof Worker === "undefined") {
        renderFallback();
        return;
      }

      let worker = shadowWorkerRef.current;
      if (!worker) {
        try {
          worker = new Worker(shadowWorkerUrl, {
            type: "module",
          });
          shadowWorkerRef.current = worker;
        } catch (error) {
          renderFallback(error);
          return;
        }
      }
      const workerInstance = worker;

      let settled = false;
      const removeListeners = () => {
        if (workerTimer) {
          window.clearTimeout(workerTimer);
          workerTimer = undefined;
        }
        workerInstance.removeEventListener("message", handleMessage);
        workerInstance.removeEventListener("error", handleError);
        workerInstance.removeEventListener("messageerror", handleMessageError);
        if (removeWorkerListeners === removeListeners) removeWorkerListeners = undefined;
      };
      const failWorker = (
        reason: GroundShadowUnavailableReason,
        error?: unknown,
      ) => {
        if (settled) return;
        settled = true;
        removeListeners();
        if (error !== undefined) {
          console.error("The ground-shadow worker failed.", error);
        }
        if (shadowWorkerRef.current === workerInstance) {
          workerInstance.terminate();
          shadowWorkerRef.current = null;
        }
        if (shadowWorkerGridRef.current?.worker === workerInstance) {
          shadowWorkerGridRef.current = null;
        }
        renderFallback(error ?? groundShadowUnavailableMessage(reason, SHADOW_WORKER_TIMEOUT_MS));
      };
      const handleMessage = (event: MessageEvent<unknown>) => {
        if (!isShadowRenderResponse(event.data)) {
          failWorker("worker-message");
          return;
        }
        if (!isShadowRenderResponseForGeneration(event.data, generation)) return;
        if (event.data.type === SHADOW_RENDER_FAILURE) {
          failWorker("worker-failure", event.data.error);
          return;
        }
        settled = true;
        removeListeners();
        applyShadowFrame(grid, groundShadowFrameFromResponse(event.data), "worker");
      };
      const handleError = (event: ErrorEvent) => {
        event.preventDefault();
        failWorker("worker-failure", event.error ?? event.message);
      };
      const handleMessageError = () => failWorker("worker-message");

      removeWorkerListeners = removeListeners;
      workerInstance.addEventListener("message", handleMessage);
      workerInstance.addEventListener("error", handleError);
      workerInstance.addEventListener("messageerror", handleMessageError);
      let workerGrid = shadowWorkerGridRef.current;
      if (
        !workerGrid ||
        workerGrid.worker !== workerInstance ||
        workerGrid.areaId !== area.id ||
        workerGrid.grid !== grid
      ) {
        const version = shadowGridVersionRef.current + 1;
        shadowGridVersionRef.current = version;
        const initialisation = createShadowGridInitialisation(version, grid);
        try {
          workerInstance.postMessage(initialisation.message, initialisation.transfer);
        } catch (error) {
          failWorker("worker-failure", error);
          return;
        }
        workerGrid = { worker: workerInstance, areaId: area.id, grid, version };
        shadowWorkerGridRef.current = workerGrid;
      }
      const message = createShadowRenderRequest(
        generation,
        workerGrid.version,
        departureDate,
        centre,
      );
      try {
        workerInstance.postMessage(message);
        workerTimer = window.setTimeout(
          () => failWorker("worker-timeout"),
          SHADOW_WORKER_TIMEOUT_MS,
        );
      } catch (error) {
        failWorker("worker-failure", error);
      }
    };

    if (map.isStyleLoaded()) void updateShadows();
    else map.once("load", updateShadows);
    return () => {
      active = false;
      removeWorkerListeners?.();
      if (pauseTimer) window.clearTimeout(pauseTimer);
      if (workerTimer) window.clearTimeout(workerTimer);
      map.off("load", updateShadows);
    };
  // A fresh route set is also the explicit retry signal after a transient
  // height-pack failure, so both scoring and the 3D shadow layer recover.
  }, [area, departureDate, routes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let active = true;

    const updateRoutes = () => {
      if (!active || mapRef.current !== map) return;
      for (let index = 0; index < 3; index += 1) {
        const route = routes[index];
        const sourceId = `route-source-${index}`;
        const layerId = `route-line-${index}`;
        routeIdsByLayerRef.current[layerId] = route?.id;
        const data = route ? featureCollectionForRoute(route) : EMPTY_FEATURE_COLLECTION;
        const source = map.getSource(sourceId) as GeoJSONSource | undefined;
        if (source) source.setData(data);
        else map.addSource(sourceId, { type: "geojson", data });

        const selected = route?.id === selectedRouteId;
        if (map.getLayer(layerId)) {
          map.setPaintProperty(layerId, "line-width", selected ? 8 : 4);
          map.setPaintProperty(layerId, "line-opacity", selected ? 0.98 : 0.64);
        } else {
          map.addLayer({
            id: layerId,
            type: "line",
            source: sourceId,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": ROUTE_COLOURS[index],
              "line-width": selected ? 8 : 4,
              "line-opacity": selected ? 0.98 : 0.64,
              "line-dasharray": ROUTE_DASHES[index],
            },
          });
          map.on("click", layerId, () => {
            if (pickingRef.current) return;
            const currentRouteId = routeIdsByLayerRef.current[layerId];
            if (currentRouteId) selectCallbackRef.current(currentRouteId);
          });
          map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
          map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = pickingRef.current ? "crosshair" : ""; });
        }
      }

      if (routes.length) {
        const coordinates = routes.flatMap((route) => route.coordinates);
        const geometryKey = routes
          .map((route) => {
            const first = route.coordinates[0];
            const last = route.coordinates.at(-1);
            return `${route.id}:${route.coordinates.length}:${first?.join(",")}:${last?.join(",")}`;
          })
          .join("|");
        if (coordinates.length && geometryKey !== lastFittedRoutesRef.current) {
          const bounds = coordinates.reduce(
            (value, coordinate) => value.extend(coordinate),
            new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
          );
          map.fitBounds(bounds, {
            padding: 54,
            duration: mapTransitionDuration(),
            maxZoom: 16,
            pitch: 52,
            bearing: -24,
          });
          lastFittedRoutesRef.current = geometryKey;
        }
      }
    };

    if (map.isStyleLoaded()) updateRoutes();
    else map.once("load", updateRoutes);
    return () => {
      active = false;
      map.off("load", updateRoutes);
    };
  }, [routes, selectedRouteId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let active = true;

    const updateExposure = () => {
      if (!active || mapRef.current !== map) return;
      const selectedScore = scores.find((score) => score.routeId === selectedRouteId);
      const data = selectedScore && selectedRouteId
        ? featureCollectionForExposure(selectedScore.sections, selectedRouteId)
        : EMPTY_FEATURE_COLLECTION;
      const source = map.getSource(EXPOSURE_SOURCE_ID) as GeoJSONSource | undefined;
      if (source) source.setData(data);
      else map.addSource(EXPOSURE_SOURCE_ID, { type: "geojson", data });

      for (const style of MAP_EXPOSURE_LEGEND) {
        const layerId = `selected-exposure-${style.category}`;
        if (!map.getLayer(layerId)) {
          map.addLayer({
            id: layerId,
            type: "line",
            source: EXPOSURE_SOURCE_ID,
            filter: ["==", ["get", "exposure"], style.category],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": style.colour,
              "line-width": 5,
              "line-opacity": 1,
              "line-dasharray": style.dash,
            },
          });
          map.on("click", layerId, (event) => {
            if (!pickingRef.current && selectedRouteIdRef.current) {
              selectCallbackRef.current(selectedRouteIdRef.current);
              const segmentIndex = Number(event.features?.[0]?.properties?.routeSegmentIndex);
              if (Number.isInteger(segmentIndex) && segmentIndex >= 0) {
                segmentSelectCallbackRef.current?.(segmentIndex);
              }
            }
          });
          map.on("mouseenter", layerId, () => {
            if (!pickingRef.current) map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", layerId, () => {
            map.getCanvas().style.cursor = pickingRef.current ? "crosshair" : "";
          });
        }
        // A route source may have been added since these layers were created.
        // Keeping the exposure layers last ensures the selected route remains legible.
        map.moveLayer(layerId);
      }
    };

    if (map.isStyleLoaded()) updateExposure();
    else map.once("load", updateExposure);
    return () => {
      active = false;
      map.off("load", updateExposure);
    };
  }, [scores, selectedRouteId, routes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let active = true;

    const updateActiveDirection = () => {
      if (!active || mapRef.current !== map) return;
      const selectedRoute = routes.find((route) => route.id === selectedRouteId);
      const direction = activeDirectionIndex === null
        ? null
        : selectedRoute?.directions[activeDirectionIndex] ?? null;
      const coordinates = selectedRoute && direction
        ? selectedRoute.coordinates.slice(
            Math.max(0, direction.beginIndex),
            Math.min(selectedRoute.coordinates.length, Math.max(direction.beginIndex + 2, direction.endIndex + 1)),
          )
        : [];
      const data = coordinates.length >= 2
        ? {
            type: "FeatureCollection" as const,
            features: [{
              type: "Feature" as const,
              properties: { directionIndex: activeDirectionIndex },
              geometry: { type: "LineString" as const, coordinates },
            }],
          }
        : EMPTY_FEATURE_COLLECTION;
      const source = map.getSource(ACTIVE_DIRECTION_SOURCE_ID) as GeoJSONSource | undefined;
      if (source) source.setData(data);
      else map.addSource(ACTIVE_DIRECTION_SOURCE_ID, { type: "geojson", data });

      if (!map.getLayer(ACTIVE_DIRECTION_CASING_ID)) {
        map.addLayer({
          id: ACTIVE_DIRECTION_CASING_ID,
          type: "line",
          source: ACTIVE_DIRECTION_SOURCE_ID,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#fffefa", "line-width": 12, "line-opacity": 0.98 },
        });
      }
      if (!map.getLayer(ACTIVE_DIRECTION_LAYER_ID)) {
        map.addLayer({
          id: ACTIVE_DIRECTION_LAYER_ID,
          type: "line",
          source: ACTIVE_DIRECTION_SOURCE_ID,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#e99b1f", "line-width": 7, "line-opacity": 1 },
        });
      }
      map.moveLayer(ACTIVE_DIRECTION_CASING_ID);
      map.moveLayer(ACTIVE_DIRECTION_LAYER_ID);

      if (coordinates.length >= 2) {
        const bounds = coordinates.reduce(
          (value, coordinate) => value.extend(coordinate),
          new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
        );
        map.fitBounds(bounds, {
          padding: 110,
          duration: mapTransitionDuration(),
          maxZoom: 18,
          pitch: 58,
          bearing: -24,
        });
      } else if (previousActiveDirectionRef.current !== null && selectedRoute?.coordinates.length) {
        const bounds = selectedRoute.coordinates.reduce(
          (value, coordinate) => value.extend(coordinate),
          new maplibregl.LngLatBounds(selectedRoute.coordinates[0], selectedRoute.coordinates[0]),
        );
        map.fitBounds(bounds, {
          padding: 54,
          duration: mapTransitionDuration(),
          maxZoom: 16,
          pitch: 52,
          bearing: -24,
        });
      }
      previousActiveDirectionRef.current = activeDirectionIndex;
    };

    if (map.isStyleLoaded()) updateActiveDirection();
    else map.once("load", updateActiveDirection);
    return () => {
      active = false;
      map.off("load", updateActiveDirection);
    };
  }, [activeDirectionIndex, routes, selectedRouteId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    originMarkerRef.current?.remove();
    destinationMarkerRef.current?.remove();
    originMarkerRef.current = new maplibregl.Marker({ element: markerElement("origin") })
      .setLngLat([origin.lon, origin.lat])
      .addTo(map);
    destinationMarkerRef.current = new maplibregl.Marker({ element: markerElement("destination") })
      .setLngLat([destination.lon, destination.lat])
      .addTo(map);
  }, [origin, destination]);

  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = picking ? "crosshair" : "";
  }, [picking]);

  const currentShadowOverlayStatus =
    departureDate &&
    shadowOverlayStatus.phase !== "idle" &&
    shadowOverlayStatus.dateEpochMs === departureDate.getTime()
      ? shadowOverlayStatus
      : null;
  const currentSunPosition =
    currentShadowOverlayStatus?.phase === "ready" &&
    sunPosition?.dateEpochMs === currentShadowOverlayStatus.dateEpochMs
      ? sunPosition
      : null;
  const sunStatus = currentSunPosition
    ? `Sun ${sunDirection(currentSunPosition.azimuthDeg)} (${formatAngle(currentSunPosition.azimuthDeg)}) · altitude ${formatAngle(currentSunPosition.altitudeDeg)}${currentSunPosition.isDaylight ? "" : " · below horizon"}`
    : "Calculating sun position";
  const coverageStatus = currentSunPosition
    ? groundShadowCoverageStatus(currentSunPosition)
    : "Calculating model bounds";
  const limitWarning = currentSunPosition
    ? groundShadowLimitWarning(currentSunPosition)
    : null;
  const shadowUnavailableMessage =
    currentShadowOverlayStatus?.phase === "unavailable"
      ? currentShadowOverlayStatus.message
      : null;
  const shadowIsLoading = Boolean(
    !mapFailure &&
      departureDate &&
      (!currentShadowOverlayStatus || currentShadowOverlayStatus.phase === "loading"),
  );
  const usedFallbackRenderer =
    currentShadowOverlayStatus?.phase === "ready" &&
    currentShadowOverlayStatus.renderMode === "fallback";
  const mapStatus = mapFailure
    ? mapFailure
    : shadowUnavailableMessage
      ? shadowUnavailableMessage
      : shadowIsLoading
        ? `Updating 3D ground shade for ${timeLabel}. The previous overlay is hidden.`
        : currentSunPosition
          ? `3D modelled ground shade · ${timeLabel} · ${sunStatus} · ${coverageStatus}${usedFallbackRenderer ? " · rendered on this device without the background worker" : ""}`
          : "Choose a departure time to display modelled 3D ground shade. Routes remain available.";
  const pickingLabel = picking === "origin" ? "start" : "destination";

  const chooseMapCentre = () => {
    if (!picking) return;
    const centre = mapRef.current?.getCenter();
    if (!centre) return;
    // ShadeRouteApp remains the single bounds-validation boundary for pointer,
    // geolocation and keyboard-selected coordinates.
    pickCallbackRef.current([centre.lng, centre.lat]);
  };

  return (
    <div className="map-wrap">
      <div
        ref={containerRef}
        className="route-map"
        role="region"
        aria-label={`3D modelled ground-shade map of ${area.name} for ${timeLabel}. ${picking ? `Choose the ${pickingLabel} point. Click or tap a point, or use the arrow keys to position the map centre and then use the map-centre button.` : "Routes are also listed below the map."}`}
      />
      {picking ? <span className="map-pick-centre" aria-hidden="true" /> : null}
      <div
        className={`map-status${picking ? " is-picking" : ""}${mapFailure || shadowUnavailableMessage ? " is-error" : ""}${shadowIsLoading ? " is-loading" : ""}${currentSunPosition?.isDaylight && !picking && !mapFailure ? " has-shadow-key" : ""}`}
        aria-busy={!picking && shadowIsLoading}
        aria-live={picking || mapFailure || shadowUnavailableMessage ? "polite" : "off"}
      >
        {picking ? (
          <>
            <span>
              Click or tap within the outlined area. With a keyboard, focus the map, use its arrow keys
              to place the centre marker, then choose the button below.
            </span>
            <button type="button" onClick={chooseMapCentre}>
              Use map centre for {pickingLabel}
            </button>
          </>
        ) : (
          <>
            <span>{mapStatus}</span>
            {currentSunPosition?.isDaylight ? (
              <span className="ground-shadow-key" aria-label="Ground-shade overlay key">
                {GROUND_SHADOW_LEGEND.map((item) => (
                  <span key={item.channel}>
                    <i
                      aria-hidden="true"
                      style={{
                        backgroundColor: `rgba(${item.rgba[0]}, ${item.rgba[1]}, ${item.rgba[2]}, ${item.rgba[3] / 255})`,
                      }}
                    />
                    {item.label}
                  </span>
                ))}
              </span>
            ) : null}
            {limitWarning ? (
              <strong>{limitWarning}</strong>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export { ROUTE_COLOURS, ROUTE_DASHES };
