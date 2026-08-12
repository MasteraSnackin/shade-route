import { buildDepartureAdvice } from "../lib/departure-advice.ts";
import { labelRouteScores, scoreRouteSchedule, type HeightGrid } from "../lib/raster-shade.ts";
import {
  createLatestScoringRequestQueue,
  DEPARTURE_ADVICE_REQUEST,
  DEPARTURE_ADVICE_SUCCESS,
  heightGridFromInitialisation,
  SCORING_CANCEL_REQUEST,
  SCORING_FAILURE,
  SCORING_GRID_INITIALISE,
  SCHEDULE_SCORE_REQUEST,
  SCHEDULE_SCORE_SUCCESS,
  type ScoringCalculationRequest,
  type ScoringWorkerRequest,
  type ScoringWorkerResponse,
} from "../lib/scoring-worker-protocol.ts";

interface ScoringWorkerScope {
  onmessage: ((event: MessageEvent<ScoringWorkerRequest>) => void) | null;
  postMessage(message: ScoringWorkerResponse): void;
}

const workerScope = globalThis as unknown as ScoringWorkerScope;
let activeGrid: HeightGrid | null = null;
let activeGridVersion = -1;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Route exposure calculation failed.";
}

function postFailure(request: ScoringCalculationRequest, error: unknown) {
  workerScope.postMessage({
    type: SCORING_FAILURE,
    task: request.task,
    generation: request.generation,
    error: errorMessage(error),
  });
}

const queue = createLatestScoringRequestQueue((request) => {
  try {
    if (!activeGrid || activeGridVersion !== request.gridVersion) {
      throw new Error("Route exposure coverage is not initialised.");
    }
    const departure = new Date(request.departureEpochMs);
    if (Number.isNaN(departure.getTime())) throw new Error("Departure time is invalid.");

    if (request.type === SCHEDULE_SCORE_REQUEST) {
      const scores = labelRouteScores(
        request.routes.map((route) =>
          scoreRouteSchedule(
            route,
            activeGrid as HeightGrid,
            departure,
            request.journeyCount,
            request.repeatEveryMinutes,
            request.walkingPace,
          ),
        ),
        request.profile,
      );
      workerScope.postMessage({
        type: SCHEDULE_SCORE_SUCCESS,
        task: "scores",
        generation: request.generation,
        scores,
      });
      return;
    }

    if (request.type === DEPARTURE_ADVICE_REQUEST) {
      const advice = buildDepartureAdvice({
        routes: request.routes,
        grid: activeGrid,
        departure,
        profile: request.profile,
        journeyCount: request.journeyCount,
        repeatEveryMinutes: request.repeatEveryMinutes,
        walkingPace: request.walkingPace,
        windowMinutes: request.windowMinutes,
        stepMinutes: request.stepMinutes,
        minimumSavingSeconds: request.minimumSavingSeconds,
        minimumCoveragePercent: request.minimumCoveragePercent,
      });
      workerScope.postMessage({
        type: DEPARTURE_ADVICE_SUCCESS,
        task: "advice",
        generation: request.generation,
        advice,
      });
    }
  } catch (error) {
    postFailure(request, error);
  }
});

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === SCORING_GRID_INITIALISE) {
    queue.clear();
    activeGrid = heightGridFromInitialisation(request);
    activeGridVersion = request.gridVersion;
    return;
  }
  if (request.type === SCORING_CANCEL_REQUEST) {
    queue.cancel(request.task, request.generation);
    return;
  }
  queue.enqueue(request);
};
