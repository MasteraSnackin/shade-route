import type { DepartureAdviceResult } from "./departure-advice.ts";
import type {
  HeightGrid,
  HeightGridMetadata,
  LabelledRasterScore,
} from "./raster-shade.ts";
import type { WalkingRoute } from "./routes.ts";
import type { WalkingPace } from "./walking-pace.ts";

export const SCORING_GRID_INITIALISE = "initialise-scoring-grid" as const;
export const SCHEDULE_SCORE_REQUEST = "score-route-schedules" as const;
export const DEPARTURE_ADVICE_REQUEST = "build-departure-advice" as const;
export const SCORING_CANCEL_REQUEST = "cancel-scoring-request" as const;
export const SCHEDULE_SCORE_SUCCESS = "route-schedules-scored" as const;
export const DEPARTURE_ADVICE_SUCCESS = "departure-advice-built" as const;
export const SCORING_FAILURE = "scoring-request-failed" as const;

export type ScoringTask = "scores" | "advice";

interface TransferableHeightGrid {
  metadata: HeightGridMetadata;
  heights: ArrayBuffer;
  validity?: ArrayBuffer;
  terrainElevations?: ArrayBuffer;
  minimumSurfaceElevations?: ArrayBuffer;
  maximumSurfaceElevations?: ArrayBuffer;
}

export interface ScoringGridInitialiseRequest {
  type: typeof SCORING_GRID_INITIALISE;
  gridVersion: number;
  areaId: string;
  grid: TransferableHeightGrid;
}

interface BaseScoringRequest {
  generation: number;
  gridVersion: number;
  routes: WalkingRoute[];
  departureEpochMs: number;
  profile: "vulnerable" | "worker";
  journeyCount: number;
  repeatEveryMinutes: number;
  /** Optional for compatibility with requests produced before pace presets existed. */
  walkingPace?: WalkingPace;
}

export interface ScheduleScoreRequest extends BaseScoringRequest {
  type: typeof SCHEDULE_SCORE_REQUEST;
  task: "scores";
}

export interface DepartureAdviceRequest extends BaseScoringRequest {
  type: typeof DEPARTURE_ADVICE_REQUEST;
  task: "advice";
  windowMinutes?: number;
  stepMinutes?: number;
  minimumSavingSeconds?: number;
  minimumCoveragePercent?: number;
}

export type ScoringCalculationRequest = ScheduleScoreRequest | DepartureAdviceRequest;

export interface ScoringCancelRequest {
  type: typeof SCORING_CANCEL_REQUEST;
  task: ScoringTask;
  generation?: number;
}

export type ScoringWorkerRequest =
  | ScoringGridInitialiseRequest
  | ScoringCalculationRequest
  | ScoringCancelRequest;

export interface ScheduleScoreSuccess {
  type: typeof SCHEDULE_SCORE_SUCCESS;
  task: "scores";
  generation: number;
  scores: LabelledRasterScore[];
}

export interface DepartureAdviceSuccess {
  type: typeof DEPARTURE_ADVICE_SUCCESS;
  task: "advice";
  generation: number;
  advice: DepartureAdviceResult;
}

export interface ScoringFailure {
  type: typeof SCORING_FAILURE;
  task: ScoringTask;
  generation: number;
  error: string;
}

export type ScoringWorkerResponse =
  | ScheduleScoreSuccess
  | DepartureAdviceSuccess
  | ScoringFailure;

function copiedBuffer(view: Uint8Array | Float32Array | undefined) {
  if (!view) return undefined;
  return view instanceof Uint8Array
    ? Uint8Array.from(view).buffer
    : Float32Array.from(view).buffer;
}

/** Copy the shared cache before transfer so scoring elsewhere cannot detach it. */
export function createScoringGridInitialisation(
  gridVersion: number,
  areaId: string,
  grid: HeightGrid,
): { message: ScoringGridInitialiseRequest; transfer: Transferable[] } {
  const heights = copiedBuffer(grid.heights) as ArrayBuffer;
  const validity = copiedBuffer(grid.validity);
  const terrainElevations = copiedBuffer(grid.terrainElevations);
  const minimumSurfaceElevations = copiedBuffer(grid.minimumSurfaceElevations);
  const maximumSurfaceElevations = copiedBuffer(grid.maximumSurfaceElevations);
  const transfer = [
    heights,
    validity,
    terrainElevations,
    minimumSurfaceElevations,
    maximumSurfaceElevations,
  ].filter((buffer): buffer is ArrayBuffer => Boolean(buffer));
  return {
    message: {
      type: SCORING_GRID_INITIALISE,
      gridVersion,
      areaId,
      grid: {
        metadata: grid.metadata,
        heights,
        validity,
        terrainElevations,
        minimumSurfaceElevations,
        maximumSurfaceElevations,
      },
    },
    transfer,
  };
}

export function heightGridFromInitialisation(request: ScoringGridInitialiseRequest): HeightGrid {
  return {
    metadata: request.grid.metadata,
    heights: new Uint8Array(request.grid.heights),
    validity: request.grid.validity ? new Uint8Array(request.grid.validity) : undefined,
    terrainElevations: request.grid.terrainElevations
      ? new Float32Array(request.grid.terrainElevations)
      : undefined,
    minimumSurfaceElevations: request.grid.minimumSurfaceElevations
      ? new Float32Array(request.grid.minimumSurfaceElevations)
      : undefined,
    maximumSurfaceElevations: request.grid.maximumSurfaceElevations
      ? new Float32Array(request.grid.maximumSurfaceElevations)
      : undefined,
  };
}

export function createScheduleScoreRequest(
  generation: number,
  gridVersion: number,
  input: Omit<ScheduleScoreRequest, "type" | "task" | "generation" | "gridVersion">,
): ScheduleScoreRequest {
  return {
    type: SCHEDULE_SCORE_REQUEST,
    task: "scores",
    generation,
    gridVersion,
    ...input,
  };
}

export function createDepartureAdviceRequest(
  generation: number,
  gridVersion: number,
  input: Omit<DepartureAdviceRequest, "type" | "task" | "generation" | "gridVersion">,
): DepartureAdviceRequest {
  return {
    type: DEPARTURE_ADVICE_REQUEST,
    task: "advice",
    generation,
    gridVersion,
    ...input,
  };
}

export interface LatestScoringRequestQueue {
  enqueue(request: ScoringCalculationRequest): void;
  cancel(task: ScoringTask, generation?: number): void;
  clear(): void;
}

/**
 * Keep only the latest queued request for each result stream. One calculation
 * runs per task turn so newer messages can replace work that has not started.
 */
export function createLatestScoringRequestQueue(
  run: (request: ScoringCalculationRequest) => void,
  schedule: (flush: () => void) => void = (flush) => {
    globalThis.setTimeout(flush, 0);
  },
): LatestScoringRequestQueue {
  const pending = new Map<ScoringTask, ScoringCalculationRequest>();
  let scheduled = false;

  const scheduleNext = () => {
    if (scheduled || !pending.size) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      const next = pending.values().next().value;
      if (!next) return;
      pending.delete(next.task);
      run(next);
      scheduleNext();
    });
  };

  return {
    enqueue(request) {
      // Reinsert so a replacement becomes the most recently queued task.
      pending.delete(request.task);
      pending.set(request.task, request);
      scheduleNext();
    },
    cancel(task, generation) {
      const request = pending.get(task);
      if (request && (generation === undefined || request.generation === generation)) {
        pending.delete(task);
      }
    },
    clear() {
      pending.clear();
    },
  };
}

export function isScoringWorkerResponse(value: unknown): value is ScoringWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<ScoringWorkerResponse>;
  if (!Number.isSafeInteger(response.generation)) return false;
  if (response.task !== "scores" && response.task !== "advice") return false;
  if (response.type === SCORING_FAILURE) return typeof response.error === "string";
  if (response.type === SCHEDULE_SCORE_SUCCESS) {
    return response.task === "scores" && Array.isArray(response.scores);
  }
  if (response.type === DEPARTURE_ADVICE_SUCCESS) {
    return response.task === "advice" && Boolean(response.advice);
  }
  return false;
}

export function isScoringWorkerResponseFor(
  value: unknown,
  task: ScoringTask,
  generation: number,
): value is ScoringWorkerResponse {
  return isScoringWorkerResponse(value) &&
    value.task === task &&
    value.generation === generation;
}
