"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAP_CONTEXT_LEGEND, MAP_EXPOSURE_LEGEND, RouteMap, ROUTE_COLOURS, ROUTE_DASHES } from "./RouteMap";
import { ShadeTimeExplorer } from "./ShadeTimeExplorer";
import { DepartureAdvice } from "./DepartureAdvice";
import { HeatContext } from "./HeatContext";
import { JourneyMode, type JourneyLocationRequestStatus } from "./JourneyMode";
import { SavedJourneys } from "./SavedJourneys";
import { FieldFeedback } from "./FieldFeedback";
import { RouteContextPanel } from "./RouteContextPanel";
import {
  buildDepartureAdvice,
  type DepartureAdviceResult,
} from "../lib/departure-advice";
import {
  labelRouteScores,
  loadHeightGrid,
  scoreRouteSchedule,
  type LabelledRasterScore,
} from "../lib/raster-shade";
import {
  haversineMetres,
  pointInsideArea,
  type Coordinate,
  type NamedPoint,
  type PilotArea,
  type PilotRouteData,
  type WalkingRoute,
} from "../lib/routes";
import {
  formatLondonDateTime,
  initialLondonDateTimeValue,
  londonDateTimeValue,
  parseLondonDateTime,
} from "../lib/london-time";
import { buildJourneySteps } from "../lib/journey-mode";
import type { SavedJourneySetup } from "../lib/local-journeys";

type Profile = "vulnerable" | "worker";
type Picking = "origin" | "destination" | null;

interface RouteAccessSummary {
  hasStairs: boolean;
  hasEscalator: boolean;
  hasUnderground: boolean;
  avoidsKnownBarriers: boolean;
  label: string;
  crossingEvidence: "mapped" | "not-mentioned" | "unavailable";
  surfaceEvidence: "rough-flag" | "not-flagged" | "unavailable";
}

function minutes(seconds: number) {
  return Math.max(0, Math.round(seconds / 60));
}

function formatDistance(metres: number) {
  return metres < 1000 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1000).toFixed(1)} km`;
}

function labelText(label: LabelledRasterScore["labels"][number]) {
  if (label === "least-sun") return "Least direct sun";
  if (label === "fastest") return "Fastest";
  return "Suggested trade-off";
}

function routeName(index: number) {
  return ["Route one", "Route two", "Route three"][index] ?? `Route ${index + 1}`;
}

function descriptiveRouteName(route: WalkingRoute, index: number) {
  const knownNames: Array<[string, string]> = [
    ["waterloo-1", "Via York Road"],
    ["waterloo-2", "Via Station Approach"],
    ["waterloo-3", "Via Lower Marsh"],
    ["kings-cross-1", "Via Endsleigh Gardens"],
    ["kings-cross-2", "Via Euston Road"],
    ["kings-cross-3", "Via Euston Square"],
  ];
  const known = knownNames.find(([prefix]) => route.id.startsWith(prefix));
  if (known) return known[1];

  const namedStreet = route.directions
    .map((direction) => direction.instruction.match(/(?:onto|on) ([^.]*)/i)?.[1]?.trim())
    .find((name) => name && !/walkway|crosswalk|ramp/i.test(name));
  return namedStreet ? `Via ${namedStreet}` : routeName(index);
}

function routeAccessSummary(route: WalkingRoute): RouteAccessSummary {
  const instructions = route.directions.map((direction) => direction.instruction).join(" ").toLowerCase();
  const accessReference = route.accessReference?.toLowerCase() ?? "";
  const accessText = `${instructions} ${accessReference}`;
  const hasStairs = /\bstair(?:s|way)?\b/.test(accessText);
  const hasEscalator = /\bescalator\b/.test(accessText);
  const hasUnderground = /level\s*-\d|underground|subway|tunnel|below ground/.test(accessText);
  const hasAccessEvidence = accessText.trim().length > 0;
  const crossingMentioned = route.directions.some((direction) => /cross(?:ing|walk)|traffic signal|zebra/i.test(direction.instruction));
  const roughFlag = route.directions.some((direction) => direction.roughSurfaceFlag);
  const barriers = [hasStairs && "stairs", hasEscalator && "escalator"].filter(Boolean);
  return {
    hasStairs,
    hasEscalator,
    hasUnderground,
    avoidsKnownBarriers: hasAccessEvidence && !hasStairs && !hasEscalator,
    label: barriers.length
      ? `Includes ${barriers.join(" and ")}`
      : hasAccessEvidence
        ? "No steps identified; step-free not verified"
        : "Access details unavailable; step-free not verified",
    crossingEvidence: route.directions.length ? (crossingMentioned ? "mapped" : "not-mentioned") : "unavailable",
    surfaceEvidence: route.directions.length ? (roughFlag ? "rough-flag" : "not-flagged") : "unavailable",
  };
}

function combineLondonDateAndTime(current: string, time: string | undefined) {
  const date = /^(\d{4}-\d{2}-\d{2})T/.exec(current)?.[1];
  return date && time ? `${date}T${time}` : current;
}

function applyAccessGuard(
  labelled: LabelledRasterScore[],
  activeRoutes: WalkingRoute[],
  stepFreeRequested: boolean,
) {
  const daylight = labelled.some((score) => score.isDaylight);
  const withoutSuggestion: LabelledRasterScore[] = labelled.map((score) => ({
    ...score,
    labels: score.labels.filter((label) => label !== "recommended") as LabelledRasterScore["labels"],
    recommendationReason: null,
  }));
  if (!daylight) return withoutSuggestion;
  const modelSupportsSuggestion = labelled.every(
    (score) => !score.isDaylight || (score.coveragePercent >= 90 && !score.lowSunConfidence),
  );
  if (!modelSupportsSuggestion) return withoutSuggestion;

  if (!stepFreeRequested) {
    return labelled;
  }

  const suitable = withoutSuggestion.filter((score) => {
    const route = activeRoutes.find((candidate) => candidate.id === score.routeId);
    return route ? routeAccessSummary(route).avoidsKnownBarriers : false;
  });
  if (!suitable.length) return withoutSuggestion;

  const fastestSuitable = suitable.reduce((best, score) =>
    score.durationSeconds / score.journeyCount < best.durationSeconds / best.journeyCount
      ? score
      : best,
  );
  const fastestDuration = fastestSuitable.durationSeconds / fastestSuitable.journeyCount;
  const allowedExtra = Math.min(300, fastestDuration * 0.2);
  const eligible = suitable.filter(
    (score) => score.durationSeconds / score.journeyCount <= fastestDuration + allowedExtra,
  );
  const suggested = eligible.reduce((best, score) =>
    score.estimatedDirectSunSeconds < best.estimatedDirectSunSeconds ? score : best,
  );
  const sunSaving = Math.max(
    0,
    fastestSuitable.estimatedDirectSunSeconds - suggested.estimatedDirectSunSeconds,
  );
  const extraSeconds = Math.max(
    0,
    suggested.durationSeconds / suggested.journeyCount - fastestDuration,
  );
  const accessReason = suggested.routeId === fastestSuitable.routeId
    ? "Suggested because it is the fastest eligible route and avoids known stair and escalator instructions. Step-free access is not verified."
    : `Suggested trade-off: about ${minutes(extraSeconds)} min longer per journey for about ${minutes(sunSaving)} fewer min in direct sun. It avoids known stair and escalator instructions; step-free access is not verified.`;
  return withoutSuggestion.map((score) => ({
    ...score,
    labels: score.routeId === suggested.routeId
      ? (["recommended", ...score.labels.filter((label) => label !== "recommended")] as LabelledRasterScore["labels"])
      : score.labels,
    recommendationReason: score.routeId === suggested.routeId ? accessReason : null,
  }));
}

function pointsMatch(a: NamedPoint, b: NamedPoint) {
  return haversineMetres([a.lon, a.lat], [b.lon, b.lat]) < 4;
}

export function ShadeRouteApp() {
  const [data, setData] = useState<PilotRouteData | null>(null);
  const [areaId, setAreaId] = useState<PilotArea["id"]>("waterloo");
  const [origin, setOrigin] = useState<NamedPoint>({
    name: "London Waterloo Station",
    lat: 51.50225,
    lon: -0.11316,
  });
  const [destination, setDestination] = useState<NamedPoint>({
    name: "St Thomas’ Hospital",
    lat: 51.49906,
    lon: -0.1187,
  });
  const [routes, setRoutes] = useState<WalkingRoute[]>([]);
  const [scores, setScores] = useState<LabelledRasterScore[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [departure, setDeparture] = useState(initialLondonDateTimeValue);
  const [profile, setProfile] = useState<Profile>("vulnerable");
  const [journeyCount, setJourneyCount] = useState(1);
  const [repeatEveryMinutes, setRepeatEveryMinutes] = useState(120);
  const [avoidSteps, setAvoidSteps] = useState(true);
  const [picking, setPicking] = useState<Picking>(null);
  const [customJourney, setCustomJourney] = useState(false);
  const [plannerCollapsed, setPlannerCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shadePlaying, setShadePlaying] = useState(false);
  const [comparisonFocusSequence, setComparisonFocusSequence] = useState(0);
  const [journeyModeOpen, setJourneyModeOpen] = useState(false);
  const [journeyPosition, setJourneyPosition] = useState<Coordinate | null>(null);
  const [journeyLocationStatus, setJourneyLocationStatus] = useState<JourneyLocationRequestStatus>("idle");
  const [activeDirectionIndex, setActiveDirectionIndex] = useState<number | null>(null);
  const [inspectionDeparture, setInspectionDeparture] = useState<Date | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [departureAdviceState, setDepartureAdviceState] = useState<{
    key: string;
    advice: DepartureAdviceResult;
  } | null>(null);
  const [departureAdviceErrorKey, setDepartureAdviceErrorKey] = useState<string | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine);
  const resultsRef = useRef<HTMLElement>(null);
  const calculationGenerationRef = useRef(0);
  const adviceGenerationRef = useRef(0);
  const lastFocusedComparisonRef = useRef(0);

  const area = useMemo(
    () => data?.areas.find((candidate) => candidate.id === areaId) ?? null,
    [data, areaId],
  );
  const departureAdviceRoutes = useMemo(
    () => avoidSteps
      ? routes.filter((route) => routeAccessSummary(route).avoidsKnownBarriers)
      : routes,
    [avoidSteps, routes],
  );
  const departureAdviceKey = `${area?.id ?? "none"}|${departureAdviceRoutes.map((route) => route.id).join(",")}|${departure}|${profile}|${journeyCount}|${repeatEveryMinutes}|${avoidSteps}`;
  const departureAdvice = departureAdviceState?.key === departureAdviceKey
    ? departureAdviceState.advice
    : null;
  const departureAdviceUnavailableForAccess = avoidSteps && routes.length > 0 && departureAdviceRoutes.length === 0;

  const selectedRoute = useMemo(
    () => routes.find((route) => route.id === selectedRouteId) ?? routes[0] ?? null,
    [routes, selectedRouteId],
  );
  const selectedScore = useMemo(
    () => scores.find((score) => score.routeId === selectedRoute?.id) ?? null,
    [scores, selectedRoute],
  );
  const departureDate = useMemo(() => parseLondonDateTime(departure), [departure]);
  const mapDepartureDate = inspectionDeparture ?? departureDate;
  const mapTimeLabel = inspectionDeparture
    ? `${new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(inspectionDeparture)} · selected step`
    : formatLondonDateTime(departure);
  const activeDirection = activeDirectionIndex === null
    ? null
    : selectedRoute?.directions[activeDirectionIndex] ?? null;
  const activeExposureSection = activeDirection && selectedScore
    ? selectedScore.sections.find((section) => (
        section.routeSegmentIndex >= activeDirection.beginIndex &&
        section.routeSegmentIndex < Math.max(activeDirection.beginIndex + 1, activeDirection.endIndex)
      )) ?? null
    : null;
  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 760px)").matches) setPlannerCollapsed(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (
      !comparisonFocusSequence ||
      lastFocusedComparisonRef.current === comparisonFocusSequence ||
      loading ||
      !routes.length
    ) return;
    lastFocusedComparisonRef.current = comparisonFocusSequence;
    const frame = window.requestAnimationFrame(() => {
      resultsRef.current?.focus({ preventScroll: true });
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [comparisonFocusSequence, loading, routes.length]);

  useEffect(() => {
    fetch("/data/pilot-routes.json")
      .then((response) => {
        if (!response.ok) throw new Error("Pilot routes could not be loaded.");
        return response.json() as Promise<PilotRouteData>;
      })
      .then((pilotData) => {
        setData(pilotData);
        const initialArea = pilotData.areas[0];
        setAreaId(initialArea.id);
        setOrigin(initialArea.start);
        setDestination(initialArea.destination);
        setRoutes(initialArea.routes);
      })
      .catch(() => setError("The local pilot data could not be loaded."));
  }, []);

  const calculateScores = useCallback(async (
    activeArea: PilotArea,
    activeRoutes: WalkingRoute[],
    activeDeparture: string,
    activeProfile: Profile,
    count: number,
    interval: number,
    stepFreeRequested: boolean,
    generation: number,
  ) => {
    const date = parseLondonDateTime(activeDeparture);
    if (!date) {
      if (generation === calculationGenerationRef.current) {
        setError("Choose a valid departure date and time.");
      }
      return;
    }
    if (generation !== calculationGenerationRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const grid = await loadHeightGrid(activeArea.id);
      if (generation !== calculationGenerationRef.current) return;
      const scored = activeRoutes.map((route) =>
        scoreRouteSchedule(route, grid, date, count, interval),
      );
      const labelled = applyAccessGuard(
        labelRouteScores(scored, activeProfile),
        activeRoutes,
        stepFreeRequested,
      );
      if (generation !== calculationGenerationRef.current) return;
      setScores(labelled);
      setSelectedRouteId((current) => {
        if (current && labelled.some((score) => score.routeId === current)) return current;
        return labelled.find((score) => score.labels.includes("recommended"))?.routeId ??
          labelled[0]?.routeId ?? null;
      });
    } catch {
      if (generation !== calculationGenerationRef.current) return;
      setScores([]);
      setError("Shade coverage is unavailable. The ordinary walking routes are still shown.");
    } finally {
      if (generation === calculationGenerationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const generation = calculationGenerationRef.current + 1;
    calculationGenerationRef.current = generation;
    if (!area || !routes.length) return;
    const timer = window.setTimeout(() => {
      void calculateScores(
        area,
        routes,
        departure,
        profile,
        profile === "worker" ? journeyCount : 1,
        repeatEveryMinutes,
        avoidSteps,
        generation,
      );
    }, 80);
    return () => window.clearTimeout(timer);
  }, [area, routes, departure, profile, journeyCount, repeatEveryMinutes, avoidSteps, calculateScores]);

  useEffect(() => {
    const generation = adviceGenerationRef.current + 1;
    adviceGenerationRef.current = generation;
    const date = parseLondonDateTime(departure);
    if (!area || !departureAdviceRoutes.length || !date || shadePlaying) return;
    const timer = window.setTimeout(() => {
      void loadHeightGrid(area.id)
        .then((grid) => buildDepartureAdvice({
          routes: departureAdviceRoutes,
          grid,
          departure: date,
          profile,
          journeyCount: profile === "worker" ? journeyCount : 1,
          repeatEveryMinutes,
          minimumCoveragePercent: 90,
        }))
        .then((advice) => {
          if (generation === adviceGenerationRef.current) {
            setDepartureAdviceState({ key: departureAdviceKey, advice });
            setDepartureAdviceErrorKey(null);
          }
        })
        .catch(() => {
          if (generation === adviceGenerationRef.current) {
            setDepartureAdviceErrorKey(departureAdviceKey);
          }
        });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [area, departure, departureAdviceKey, departureAdviceRoutes, journeyCount, profile, repeatEveryMinutes, shadePlaying]);

  const chooseDepartureAdvice = useCallback((date: Date, routeId: string) => {
    setDeparture(londonDateTimeValue(date));
    setSelectedRouteId(routeId);
    setJourneyModeOpen(false);
    setFeedbackOpen(false);
    setActiveDirectionIndex(null);
    setInspectionDeparture(null);
    setNotice("Departure and route updated from the modelled two-hour comparison.");
  }, []);

  const chooseRoute = useCallback((routeId: string) => {
    setSelectedRouteId(routeId);
    setJourneyModeOpen(false);
    setFeedbackOpen(false);
    setActiveDirectionIndex(null);
    setInspectionDeparture(null);
  }, []);

  const inspectDirection = useCallback((directionIndex: number) => {
    if (!selectedRoute || !departureDate) return;
    const steps = buildJourneySteps(selectedRoute);
    const step = steps[directionIndex];
    if (!step) return;
    setActiveDirectionIndex(directionIndex);
    setInspectionDeparture(new Date(departureDate.getTime() + step.startOffsetSeconds * 1000));
  }, [departureDate, selectedRoute]);

  const clearDirectionInspection = useCallback(() => {
    setActiveDirectionIndex(null);
    setInspectionDeparture(null);
  }, []);

  const requestJourneyPosition = useCallback(() => {
    if (!navigator.geolocation) {
      setJourneyPosition(null);
      setJourneyLocationStatus("unavailable");
      return;
    }
    setJourneyLocationStatus("requesting");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coordinate: Coordinate = [position.coords.longitude, position.coords.latitude];
        if (!coordinate.every(Number.isFinite)) {
          setJourneyPosition(null);
          setJourneyLocationStatus("unavailable");
          return;
        }
        setJourneyPosition(coordinate);
        setJourneyLocationStatus("ready");
      },
      (error) => {
        setJourneyPosition(null);
        setJourneyLocationStatus(error.code === error.PERMISSION_DENIED
          ? "denied"
          : error.code === error.POSITION_UNAVAILABLE
            ? "unavailable"
            : "error");
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 30_000 },
    );
  }, []);

  const inspectRouteSegment = useCallback((routeSegmentIndex: number) => {
    const directionIndex = selectedRoute?.directions.findIndex((direction) => (
      routeSegmentIndex >= direction.beginIndex &&
      routeSegmentIndex < Math.max(direction.beginIndex + 1, direction.endIndex)
    )) ?? -1;
    if (directionIndex >= 0) inspectDirection(directionIndex);
  }, [inspectDirection, selectedRoute]);

  const loadSavedJourney = useCallback((setup: SavedJourneySetup) => {
    const declaredArea = setup.areaId
      ? data?.areas.find((candidate) => candidate.id === setup.areaId)
      : null;
    const nextArea = declaredArea &&
      pointInsideArea(setup.origin, declaredArea) &&
      pointInsideArea(setup.destination, declaredArea)
      ? declaredArea
      : data?.areas.find((candidate) => (
          pointInsideArea(setup.origin, candidate) &&
          pointInsideArea(setup.destination, candidate)
        ));
    if (!nextArea) {
      setError("This saved journey is outside the two current pilot areas.");
      return;
    }
    setAreaId(nextArea.id);
    setOrigin(setup.origin);
    setDestination(setup.destination);
    setDeparture((current) => combineLondonDateAndTime(current, setup.departureTime));
    setProfile(setup.profile);
    setJourneyCount(setup.journeyCount);
    setRepeatEveryMinutes(setup.repeatEveryMinutes);
    setAvoidSteps(setup.avoidSteps);
    const isBundledForwardJourney = pointsMatch(setup.origin, nextArea.start) && pointsMatch(setup.destination, nextArea.destination);
    setRoutes(isBundledForwardJourney ? nextArea.routes : []);
    setScores([]);
    setSelectedRouteId(isBundledForwardJourney && setup.preferredRouteId && nextArea.routes.some((route) => route.id === setup.preferredRouteId)
      ? setup.preferredRouteId
      : null);
    setJourneyModeOpen(false);
    setFeedbackOpen(false);
    setActiveDirectionIndex(null);
    setInspectionDeparture(null);
    setCustomJourney(!isBundledForwardJourney);
    setPlannerCollapsed(isBundledForwardJourney);
    setError(null);
    setNotice(isBundledForwardJourney
      ? "Saved pilot journey loaded from this device."
      : "Saved custom endpoints loaded from this device. Compare routes to request current alternatives.");
  }, [data]);

  const chooseArea = useCallback((nextAreaId: PilotArea["id"]) => {
    const nextArea = data?.areas.find((candidate) => candidate.id === nextAreaId);
    if (!nextArea) return;
    setAreaId(nextArea.id);
    setOrigin(nextArea.start);
    setDestination(nextArea.destination);
    setRoutes(nextArea.routes);
    setScores([]);
    setSelectedRouteId(null);
    setJourneyModeOpen(false);
    setFeedbackOpen(false);
    setActiveDirectionIndex(null);
    setInspectionDeparture(null);
    setPicking(null);
    setCustomJourney(false);
    setPlannerCollapsed(window.innerWidth > 760 ? false : true);
    setError(null);
    setNotice("Pilot journey loaded from the local data pack.");
  }, [data]);

  const handleMapPick = useCallback((coordinate: Coordinate) => {
    if (!area || !picking) return;
    const point: NamedPoint = {
      name: picking === "origin" ? "Custom start point" : "Custom destination",
      lon: coordinate[0],
      lat: coordinate[1],
    };
    if (!pointInsideArea(point, area)) {
      setError("Choose a point inside the outlined pilot area.");
      return;
    }
    if (picking === "origin") setOrigin(point);
    else setDestination(point);
    setPicking(null);
    setCustomJourney(true);
    setPlannerCollapsed(false);
    setRoutes([]);
    setScores([]);
    setJourneyModeOpen(false);
    setFeedbackOpen(false);
    setActiveDirectionIndex(null);
    setInspectionDeparture(null);
    setNotice("Point set. Choose the other point if needed, then compare routes.");
    setError(null);
  }, [area, picking]);

  const compareRoutes = useCallback(async () => {
    if (!area) return;
    if (haversineMetres([origin.lon, origin.lat], [destination.lon, destination.lat]) < 20) {
      setError("Start and destination need to be at least 20 metres apart.");
      return;
    }

    const isForwardPilot = pointsMatch(origin, area.start) && pointsMatch(destination, area.destination);
    const isReversePilot = pointsMatch(origin, area.destination) && pointsMatch(destination, area.start);
    if (isForwardPilot) {
      setRoutes(area.routes);
      setCustomJourney(false);
      setNotice("Using the loaded pilot routes; no live routing request was needed.");
      setPlannerCollapsed(true);
      setComparisonFocusSequence((current) => current + 1);
      return;
    }
    if (isReversePilot) {
      setRoutes(area.routes.map((route) => ({
        ...route,
        id: `${route.id}-reversed`,
        coordinates: [...route.coordinates].reverse(),
        accessReference: route.directions.map((direction) => direction.instruction).join(" "),
        directions: [],
      })));
      setCustomJourney(false);
      setNotice("Using the loaded pilot routes in reverse. Turn-by-turn steps are hidden for this direction.");
      setPlannerCollapsed(true);
      setComparisonFocusSequence((current) => current + 1);
      return;
    }

    if (!online) {
      setError("Custom routing needs a connection. Pilot data already loaded in this session remains available.");
      return;
    }

    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: { lat: origin.lat, lon: origin.lon },
          destination: { lat: destination.lat, lon: destination.lon },
        }),
      });
      const result = await response.json() as { error?: string; routes?: WalkingRoute[] };
      if (!response.ok || !result.routes?.length) {
        throw new Error(result.error ?? "No walkable route was returned.");
      }
      setRoutes(result.routes);
      setCustomJourney(true);
      setSelectedRouteId(null);
      setJourneyModeOpen(false);
      setFeedbackOpen(false);
      setActiveDirectionIndex(null);
      setInspectionDeparture(null);
      setNotice(`${result.routes.length} live walking route${result.routes.length === 1 ? "" : "s"} found.`);
      setPlannerCollapsed(true);
      setComparisonFocusSequence((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Walking routes are temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  }, [area, origin, destination, online]);

  const reverseJourney = useCallback(() => {
    setOrigin(destination);
    setDestination(origin);
    setRoutes([]);
    setScores([]);
    setCustomJourney(true);
    setJourneyModeOpen(false);
    setFeedbackOpen(false);
    setActiveDirectionIndex(null);
    setInspectionDeparture(null);
    setPlannerCollapsed(false);
    setNotice("Journey reversed. Compare routes to update the result.");
  }, [origin, destination]);

  const useLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError("Location is not supported by this browser. Choose a point on the map instead.");
      return;
    }
    setNotice("Your location is used for this journey only. If you compare custom routes, it is sent to the routing provider.");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point: NamedPoint = {
          name: "Current location",
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };
        const matchingArea = data?.areas.find((candidate) => pointInsideArea(point, candidate));
        if (!matchingArea) {
          setError("Your current location is outside both pilot areas. Choose a point on the map.");
          return;
        }
        if (matchingArea.id !== areaId) {
          setAreaId(matchingArea.id);
          setDestination(matchingArea.destination);
        }
        setOrigin(point);
        setRoutes([]);
        setScores([]);
        setJourneyModeOpen(false);
        setFeedbackOpen(false);
        setActiveDirectionIndex(null);
        setInspectionDeparture(null);
        setCustomJourney(true);
        setPlannerCollapsed(false);
        setError(null);
      },
      () => setError("Location access was not granted. Choose a point on the map instead."),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  }, [data, areaId]);

  const fastestScore = useMemo(() => {
    if (!scores.length) return null;
    return scores.reduce((best, score) =>
      score.durationSeconds < best.durationSeconds ? score : best,
    );
  }, [scores]);

  const displayedRoutes = useMemo(() => [...routes].sort((left, right) => {
    const leftScore = scores.find((score) => score.routeId === left.id);
    const rightScore = scores.find((score) => score.routeId === right.id);
    const leftSuggested = leftScore?.labels.includes("recommended") ? 1 : 0;
    const rightSuggested = rightScore?.labels.includes("recommended") ? 1 : 0;
    if (leftSuggested !== rightSuggested) return rightSuggested - leftSuggested;
    return routes.indexOf(left) - routes.indexOf(right);
  }), [routes, scores]);

  const noKnownStepFreeOption = useMemo(
    () => avoidSteps && routes.length > 0 && routes.every((route) => !routeAccessSummary(route).avoidsKnownBarriers),
    [avoidSteps, routes],
  );

  if (!data || !area) {
    return (
      <main className="boot-screen">
        <div className="boot-mark" aria-hidden="true"><span /></div>
        <p>{error ?? "Loading the ShadeRoute London data pack…"}</p>
      </main>
    );
  }

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="ShadeRoute home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>ShadeRoute</span>
        </a>
        <div className="header-meta">
          <span className="pilot-chip">London pilot</span>
          <a href="#method">How estimates work</a>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="eyebrow">Sun-aware walking</div>
            <h1>Find a walking route with less direct sun.</h1>
            <p>
              Compare journey time with potential direct sun under clear skies for hospital trips
              and repeated outdoor journeys. Saved shortcuts and field reports stay on this device;
              no ShadeRoute account is required.
            </p>
        </section>

        {!online && (
          <div className="status-banner status-banner-warning" role="status">
            You are offline. Pilot data already loaded in this session still works; custom routing needs a connection.
          </div>
        )}

        <HeatContext />

        <section className={`planner${plannerCollapsed ? " is-results-mode" : ""}`} aria-label="Plan a shaded walking route">
          <aside className={`planner-controls${plannerCollapsed ? " is-collapsed" : ""}`}>
            <div className="journey-summary">
              <div>
                <span>Current journey</span>
                <strong>{origin.name} to {destination.name}</strong>
                <small>{formatLondonDateTime(departure)} · {profile === "worker" ? `${journeyCount} journeys` : "one journey"}</small>
              </div>
              <button type="button" onClick={() => setPlannerCollapsed(false)}>Edit journey</button>
            </div>
            <div className="planner-controls-body">
            <div className="control-section">
              <div className="section-heading">
                <span>1</span>
                <div>
                  <h2>Choose a pilot area</h2>
                  <p>Two hospital corridors have local surface-data packs.</p>
                </div>
              </div>
              <div className="pilot-options" role="group" aria-label="Pilot journey">
                {data.areas.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`pilot-option${candidate.id === areaId ? " is-active" : ""}`}
                    aria-pressed={candidate.id === areaId}
                    onClick={() => chooseArea(candidate.id)}
                  >
                    <span>{candidate.id === "waterloo" ? "South Bank" : "Euston Road"}</span>
                    <strong>{candidate.start.name}</strong>
                    <small>to {candidate.destination.name}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="control-section">
              <div className="section-heading compact-heading">
                <span>2</span>
                <div><h2>Set your journey</h2></div>
              </div>
              <div className="journey-points">
                <div className="journey-point-row">
                  <span className="point-letter">A</span>
                  <div>
                    <span className="field-label">Start</span>
                    <strong>{origin.name}</strong>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    aria-pressed={picking === "origin"}
                    onClick={() => setPicking(picking === "origin" ? null : "origin")}
                  >
                    {picking === "origin" ? "Cancel" : "Map"}
                  </button>
                </div>
                <button className="reverse-button" type="button" onClick={reverseJourney} aria-label="Reverse start and destination">⇅</button>
                <div className="journey-point-row">
                  <span className="point-letter point-letter-end">B</span>
                  <div>
                    <span className="field-label">Destination</span>
                    <strong>{destination.name}</strong>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    aria-pressed={picking === "destination"}
                    onClick={() => setPicking(picking === "destination" ? null : "destination")}
                  >
                    {picking === "destination" ? "Cancel" : "Map"}
                  </button>
                </div>
              </div>
              <button type="button" className="location-button" onClick={useLocation}>
                Use my location for the start
              </button>
            </div>

            <SavedJourneys
              currentSetup={{
                areaId,
                origin,
                destination,
                departureTime: departure.slice(11, 16),
                profile,
                journeyCount,
                repeatEveryMinutes,
                avoidSteps,
                preferredRouteId: selectedRouteId ?? undefined,
              }}
              suggestedLabel={`${origin.name} to ${destination.name}`}
              onLoad={loadSavedJourney}
              onSaved={(journey) => setNotice(`Saved “${journey.label}” on this device.`)}
            />

            <div className="control-section profile-field">
              <label>
                <span className="field-label">Plan for</span>
                <select value={profile} onChange={(event) => {
                  const nextProfile = event.target.value as Profile;
                  setProfile(nextProfile);
                  setJourneyCount(nextProfile === "worker" ? 4 : 1);
                  setAvoidSteps(nextProfile === "vulnerable");
                }}>
                  <option value="vulnerable">Heat-vulnerable person or carer</option>
                  <option value="worker">Frontline or outdoor worker</option>
                </select>
              </label>
            </div>

            <label className="access-option">
              <input
                type="checkbox"
                aria-label="Avoid known stairs and escalators"
                checked={avoidSteps}
                onChange={(event) => setAvoidSteps(event.target.checked)}
              />
              <span>
                <strong>Avoid known stairs and escalators</strong>
                <small>Routes without flagged barriers are still not confirmed step-free.</small>
              </span>
            </label>

            {profile === "worker" && (
              <div className="repeat-panel">
                <p><strong>Repeated journey</strong><span>Estimate exposure across a shift.</span></p>
                <label>
                  Journeys
                  <select value={journeyCount} onChange={(event) => setJourneyCount(Number(event.target.value))}>
                    {[2, 3, 4, 5, 6, 8].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label>
                  Every
                  <select value={repeatEveryMinutes} onChange={(event) => setRepeatEveryMinutes(Number(event.target.value))}>
                    <option value={60}>1 hour</option>
                    <option value={90}>1½ hours</option>
                    <option value={120}>2 hours</option>
                    <option value={180}>3 hours</option>
                  </select>
                </label>
              </div>
            )}

            <button type="button" className="primary-button" disabled={loading || picking !== null} onClick={() => void compareRoutes()}>
              {loading ? "Calculating exposure…" : customJourney || !routes.length ? "Compare walking routes" : "Recalculate routes"}
            </button>
            <p className="privacy-line">
              Custom coordinates are sent to the routing provider and are not stored by ShadeRoute.
            </p>
            </div>
          </aside>

          <div className="planner-map-column">
            <div className="map-stage">
              <RouteMap
                area={area}
                routes={routes}
                scores={scores}
                departureDate={mapDepartureDate}
                timeLabel={mapTimeLabel}
                selectedRouteId={selectedRouteId}
                origin={origin}
                destination={destination}
                picking={picking}
                activeDirectionIndex={activeDirectionIndex}
                onMapPick={handleMapPick}
                onRouteSelect={chooseRoute}
                onRouteSegmentSelect={inspectRouteSegment}
              />
              {selectedRoute && (
                <ShadeTimeExplorer
                  departure={departure}
                  formattedDeparture={formatLondonDateTime(departure)}
                  routeName={descriptiveRouteName(
                    selectedRoute,
                    routes.findIndex((route) => route.id === selectedRoute.id),
                  )}
                  originName={origin.name}
                  destinationName={destination.name}
                  latitude={(origin.lat + destination.lat) / 2}
                  longitude={(origin.lon + destination.lon) / 2}
                  score={selectedScore}
                  onDepartureChange={(value) => {
                    clearDirectionInspection();
                    setDeparture(value);
                  }}
                  onPlaybackChange={setShadePlaying}
                />
              )}
              {activeDirectionIndex !== null && (
                <div className="map-inspection-banner" role="status">
                  <div>
                    <span>Viewing step {activeDirectionIndex + 1} at expected arrival time</span>
                    <strong>{activeDirection?.instruction}</strong>
                  </div>
                  <button type="button" onClick={clearDirectionInspection}>Back to departure</button>
                </div>
              )}
            </div>
            <div className="map-legend" aria-label="Route map key">
              {routes.map((route, index) => (
                <button
                  key={route.id}
                  type="button"
                  aria-pressed={route.id === selectedRouteId}
                  onClick={() => chooseRoute(route.id)}
                >
                  <span
                    className="route-swatch"
                    style={{
                      borderColor: ROUTE_COLOURS[index],
                      borderStyle: ROUTE_DASHES[index][1] ? "dashed" : "solid",
                    }}
                  />
                  {index + 1}. {descriptiveRouteName(route, index)}
                </button>
              ))}
            </div>
            <div className="exposure-legend" aria-label="Selected route exposure key">
              <strong>Selected route</strong>
              {MAP_EXPOSURE_LEGEND.map((item) => (
                <span key={item.category}>
                  <i className={`exposure-swatch is-${item.category}`} />
                  {item.label}
                </span>
              ))}
              <strong>Local records</strong>
              {MAP_CONTEXT_LEGEND.map((item) => (
                <span key={item.category}>
                  <i className="context-swatch" style={{ backgroundColor: item.colour }} />
                  {item.label}
                </span>
              ))}
            </div>
            {departureAdviceUnavailableForAccess ? (
              <aside className="departure-advice">
                <span className="departure-advice__label">Model estimate</span>
                <p>Departure advice is withheld because every returned route has a known stair or escalator instruction.</p>
              </aside>
            ) : (
              <DepartureAdvice
                advice={departureAdvice}
                unavailable={departureAdviceErrorKey === departureAdviceKey}
                routeName={departureAdvice?.selectedRoute
                  ? descriptiveRouteName(
                      departureAdvice.selectedRoute,
                      routes.findIndex((route) => route.id === departureAdvice.selectedRoute?.id),
                    )
                  : undefined}
                onChoose={chooseDepartureAdvice}
              />
            )}
            <aside className="model-status-panel" aria-label="Model confidence and validation status">
              <div>
                <span>Evidence status</span>
                <strong>
                  {selectedScore
                    ? `${Math.round(selectedScore.coveragePercent)}% of daylight journey modelled`
                    : "Calculating route coverage"}
                </strong>
              </div>
              <dl>
                <div><dt>Surface data</dt><dd>EA LiDAR, surveys 2000–2022</dd></div>
                <div><dt>Field checks</dt><dd>0 recorded — calibration pending</dd></div>
              </dl>
              <p>
                Suggestions are withheld for low coverage or low sun. The sensitivity band is not a statistical confidence interval.
              </p>
            </aside>
            {selectedRoute && (
              <RouteContextPanel
                areaId={area.id}
                route={selectedRoute}
                routeName={descriptiveRouteName(
                  selectedRoute,
                  routes.findIndex((route) => route.id === selectedRoute.id),
                )}
              />
            )}
          </div>
        </section>

        <div className="message-region" aria-live="polite">
          {error && <div className="status-banner status-banner-error" role="alert">{error}</div>}
          {!error && notice && <div className="status-banner">{notice}</div>}
        </div>

        {routes.length > 0 && (
          <section ref={resultsRef} className="results" aria-labelledby="results-title" tabIndex={-1}>
            <div className="results-heading">
              <div>
                <div className="eyebrow">Route comparison</div>
                <h2 id="results-title">Choose the trade-off that works for you</h2>
              </div>
              <div className="calculation-time">
                <span>Calculated for</span>
                <strong>{formatLondonDateTime(departure)}</strong>
              </div>
            </div>

            {loading && <div className="results-loading" role="status">Recalculating the sun position along each route…</div>}

            {noKnownStepFreeOption && (
              <div className="status-banner status-banner-warning" role="status">
                None of these routes avoids every known stair or escalator. No route is suggested as step-free;
                inspect the access warnings and confirm conditions before travelling.
              </div>
            )}

            <div className="route-cards">
              {displayedRoutes.map((route) => {
                const index = routes.findIndex((candidate) => candidate.id === route.id);
                const score = scores.find((candidate) => candidate.routeId === route.id);
                const active = route.id === selectedRouteId;
                const access = routeAccessSummary(route);
                const routeJourneyCount = profile === "worker" ? journeyCount : 1;
                const perJourneyDuration = route.durationSeconds;
                const expectedSun = score ? minutes(score.estimatedDirectSunSeconds) : null;
                const bestSun = score ? minutes(score.directSunRangeSeconds[0]) : null;
                const worstSun = score ? minutes(score.directSunRangeSeconds[1]) : null;
                const fastestSun = fastestScore ? minutes(fastestScore.estimatedDirectSunSeconds) : null;
                const fastestShade = fastestScore?.estimatedShadePercent ?? null;
                const timeDifference = fastestScore
                  ? minutes(perJourneyDuration - fastestScore.durationSeconds / fastestScore.journeyCount)
                  : 0;
                const sunDifference = expectedSun !== null && fastestSun !== null
                  ? fastestSun - expectedSun
                  : 0;
                return (
                  <article key={route.id} className={`route-card${active ? " is-selected" : ""}`}>
                    <button type="button" className="route-card-select" onClick={() => chooseRoute(route.id)} aria-pressed={active}>
                      <span className="route-card-number" style={{ backgroundColor: ROUTE_COLOURS[index] }}>{index + 1}</span>
                      <span className="route-card-title">
                        <strong>{descriptiveRouteName(route, index)}</strong>
                        <span>{formatDistance(route.distanceMetres)} · {minutes(perJourneyDuration)} min per journey</span>
                      </span>
                      <span className="radio-mark" aria-hidden="true" />
                    </button>

                    <div className="route-labels">
                      {score?.labels.map((label) => <span key={label}>{labelText(label)}</span>)}
                    </div>

                    <div className="access-flags" aria-label="Route access information">
                      <span className={access.avoidsKnownBarriers ? "is-neutral" : "is-warning"}>{access.label}</span>
                      {access.hasUnderground && <span className="is-warning">Includes below-ground section</span>}
                      <span className={access.surfaceEvidence === "rough-flag" ? "is-warning" : "is-neutral"}>
                        {access.surfaceEvidence === "rough-flag"
                          ? "Routing data flags one or more rough sections"
                          : access.surfaceEvidence === "not-flagged"
                            ? "No rough flag; pavement condition not surveyed"
                            : "Pavement and surface data unavailable"}
                      </span>
                      <span className="is-neutral">
                        {access.crossingEvidence === "mapped"
                          ? "Crossing instruction present"
                          : access.crossingEvidence === "not-mentioned"
                            ? "Crossing detail not established"
                            : "Crossing data unavailable"}
                      </span>
                      <span className="is-neutral">Gradient, kerbs and width not verified</span>
                    </div>

                    <div className="exposure-measure">
                      <span>{routeJourneyCount > 1 ? `Potential direct sun across ${routeJourneyCount} journeys` : "Potential direct sun under clear skies"}</span>
                      <strong>{score?.isDaylight === false ? "No direct sun at this time" : expectedSun === null ? "Unavailable" : `${expectedSun} min`}</strong>
                      {score?.isDaylight && (
                        <small>model sensitivity {bestSun}–{worstSun} min</small>
                      )}
                    </div>

                    {score?.labels.includes("recommended") && (
                      <p className="recommendation-reason">
                        {score.recommendationReason ?? "Suggested from the displayed time and direct-sun trade-off."}
                      </p>
                    )}

                    {score?.isDaylight && fastestScore && route.id !== fastestScore.routeId && (
                      <p className="tradeoff">
                        {timeDifference > 0 ? `${timeDifference} min longer per journey` : "Similar journey time"}
                        {sunDifference > 0
                          ? ` · about ${sunDifference} fewer min in direct sun${routeJourneyCount > 1 ? " across the scheduled journeys" : ""}`
                          : " · no material sun reduction"}
                      </p>
                    )}

                    {score?.isDaylight && fastestScore && route.id === selectedRouteId && (
                      <div className="decision-delta" aria-label="Comparison with the fastest route">
                        <strong>
                          {route.id === fastestScore.routeId
                            ? "This is the fastest route"
                            : sunDifference > 0
                              ? `About ${sunDifference} fewer min in direct sun`
                              : "No measured direct-sun saving"}
                        </strong>
                        <span>
                          {timeDifference > 0 ? `${timeDifference} min extra walking` : "No extra walking time"}
                          {score.estimatedShadePercent !== null && fastestShade !== null
                            ? ` · ${Math.round(score.estimatedShadePercent - fastestShade)} percentage points shade versus fastest`
                            : ""}
                          {` · ${Math.round(score.coveragePercent)}% modelled`}
                        </span>
                      </div>
                    )}

                    {score?.lowSunConfidence && (
                      <p className="confidence-note">Low sun angle: small position or data errors can materially change this estimate.</p>
                    )}

                    {score && score.coveragePercent < 99.5 && (
                      <p className="confidence-note">Only {Math.round(score.coveragePercent)}% of this route has complete model coverage.</p>
                    )}

                    {score?.limitedConfidence && !score.lowSunConfidence && score.coveragePercent >= 99.5 && (
                      <p className="confidence-note">Some sections are close to the model threshold; see the uncertain segments on the map.</p>
                    )}

                    {score && (
                      <div className="shade-bar-wrap">
                        <div className="shade-bar-label">
                          <span>Modelled shade under clear skies</span>
                          <strong>{score.estimatedShadePercent === null ? "n/a" : `${Math.round(score.estimatedShadePercent)}%`}</strong>
                        </div>
                        <div className="shade-bar" role="img" aria-label={score.estimatedShadePercent === null ? "No daylight during this journey" : `${Math.round(score.estimatedShadePercent)} percent estimated shade`}>
                          <span style={{ width: `${score.estimatedShadePercent ?? 0}%` }} />
                        </div>
                      </div>
                    )}

                    {active && (
                      <button
                        type="button"
                        className="walk-route-button"
                        disabled={!route.directions.length || !departureDate || !score}
                        onClick={() => {
                          setJourneyPosition(null);
                          setJourneyLocationStatus("idle");
                          setJourneyModeOpen(true);
                          inspectDirection(0);
                          window.requestAnimationFrame(() => document.getElementById("journey-mode-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                        }}
                      >
                        {route.directions.length ? "Walk this route" : "Walking steps unavailable"}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>

            {selectedRoute && (
              <details className="directions-panel">
                <summary>
                  <span>Walking steps for {descriptiveRouteName(selectedRoute, routes.findIndex((route) => route.id === selectedRoute.id))}</span>
                  <small>{selectedRoute.directions.length ? `${selectedRoute.directions.length} steps` : "Steps unavailable for this direction"}</small>
                </summary>
                {selectedRoute.directions.length > 0 && (
                  <ol>
                    {selectedRoute.directions.map((direction, index) => (
                      <li key={`${direction.beginIndex}-${index}`} className={activeDirectionIndex === index ? "is-active" : undefined}>
                        <button
                          type="button"
                          className="direction-inspect-button"
                          aria-pressed={activeDirectionIndex === index}
                          onClick={() => inspectDirection(index)}
                        >
                          <span>{index + 1}</span>
                          <p>
                            <strong>{direction.instruction}</strong>
                            <small>
                              {formatDistance(direction.distanceMetres)}
                              {direction.roughSurfaceFlag ? " · routing data flags a rough section" : " · surface detail not established"}
                            </small>
                          </p>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </details>
            )}

            {journeyModeOpen && selectedRoute && selectedScore && departureDate && activeDirectionIndex !== null && (
              <div id="journey-mode-anchor" className="journey-mode-shell">
                <JourneyMode
                  route={selectedRoute}
                  routeName={descriptiveRouteName(selectedRoute, routes.findIndex((route) => route.id === selectedRoute.id))}
                  score={selectedScore}
                  departure={departureDate}
                  activeDirectionIndex={activeDirectionIndex}
                  onActiveDirectionChange={inspectDirection}
                  onExit={() => {
                    setJourneyModeOpen(false);
                    setJourneyPosition(null);
                    setJourneyLocationStatus("idle");
                    clearDirectionInspection();
                  }}
                  currentPosition={journeyPosition}
                  onRequestLocation={requestJourneyPosition}
                  locationRequestStatus={journeyLocationStatus}
                  onReportSection={() => setFeedbackOpen(true)}
                />
                {feedbackOpen && (
                  <FieldFeedback
                    context={{
                      routeId: selectedRoute.id,
                      routeName: descriptiveRouteName(selectedRoute, routes.findIndex((route) => route.id === selectedRoute.id)),
                      segmentId: `direction-${activeDirectionIndex}`,
                      segmentLabel: activeDirection?.instruction,
                      predictedState: activeExposureSection?.exposure ?? "unknown",
                      predictedAt: inspectionDeparture?.toISOString() ?? departureDate.toISOString(),
                      location: activeExposureSection
                        ? { latitude: activeExposureSection.start[1], longitude: activeExposureSection.start[0] }
                        : undefined,
                    }}
                    onSubmitted={() => setNotice("Observation saved on this device for later export.")}
                  />
                )}
              </div>
            )}
          </section>
        )}

        <section className="method-section" id="method">
          <div>
            <div className="eyebrow">What the estimate means</div>
            <h2>A transparent clear-sky comparison, not a safety score.</h2>
          </div>
          <div className="method-grid">
            <article>
              <span>01</span>
              <h3>Follow the journey in time</h3>
              <p>Each route is sampled every eight metres. The sun position is recalculated as the person moves.</p>
            </article>
            <article>
              <span>02</span>
              <h3>Trace what blocks the sun</h3>
              <p>A four-metre local grid derived from Environment Agency surface and terrain models represents buildings and vegetation.</p>
            </article>
            <article>
              <span>03</span>
              <h3>Compare modelled exposure</h3>
              <p>Routes are compared by potential direct-sun minutes, with a visible sensitivity range, coverage warning and limit on detours.</p>
            </article>
          </div>
          <div className="validation-status">
            <span>Validation status</span>
            <strong>Engineering-tested prototype; field calibration pending</strong>
            <p>
              The displayed sensitivity band is not a statistical confidence interval. Before operational use,
              time-stamped observations on both corridors must be compared with predicted sun and shade sections.
            </p>
          </div>
          <div className="limitations">
            <h3>Use this as planning support, not a safety guarantee</h3>
            <p>
              ShadeRoute does not measure temperature or heat illness risk. LiDAR surveys in the composite may date from 2000–2022;
              seasonal foliage, pavement position, scaffolding, temporary closures, indoor passages and current street conditions can differ.
              Access flags come from route instructions and do not certify a step-free journey. Follow signs and real-world conditions.
              This is not emergency navigation or medical advice.
            </p>
          </div>
        </section>
      </main>

      <footer>
        <div><strong>ShadeRoute</strong><span>A Frontline London working prototype</span></div>
        <p>
          Routes and map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>.
          Contains Environment Agency data © Environment Agency copyright and/or database right 2022, licensed under the
          {" "}<a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noreferrer">Open Government Licence v3.0</a>.
          {" "}Cool-space records are from <a href="https://data.london.gov.uk/dataset/cool-space-data-2025-2z19p" target="_blank" rel="noreferrer">GLA Cool Space Data 2025</a>
          {" "}under the <a href="https://data.london.gov.uk/about/terms-and-conditions/" target="_blank" rel="noreferrer">London Datastore terms</a>.
          The GLA does not warrant their quality or accuracy and does not endorse ShadeRoute.
        </p>
      </footer>
    </div>
  );
}
