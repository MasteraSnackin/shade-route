import { buildDepartureAdvice, type DepartureAdviceResult } from "./departure-advice.ts";
import {
  labelRouteScores,
  scoreRouteSchedule,
  type HeightGrid,
  type LabelledRasterScore,
} from "./raster-shade.ts";
import type { WalkingRoute } from "./routes.ts";
import type { WalkingPace } from "./walking-pace.ts";
import {
  createDepartureAdviceRequest,
  createScheduleScoreRequest,
  createScoringGridInitialisation,
  DEPARTURE_ADVICE_SUCCESS,
  isScoringWorkerResponse,
  SCORING_CANCEL_REQUEST,
  SCORING_FAILURE,
  SCHEDULE_SCORE_SUCCESS,
  type DepartureAdviceRequest,
  type ScheduleScoreRequest,
  type ScoringTask,
  type ScoringWorkerResponse,
} from "./scoring-worker-protocol.ts";

interface BaseRouteScoringInput {
  areaId: string;
  grid: HeightGrid;
  routes: WalkingRoute[];
  departure: Date;
  profile: "vulnerable" | "worker";
  journeyCount: number;
  repeatEveryMinutes: number;
  walkingPace?: WalkingPace;
}

export type RouteScheduleScoringInput = BaseRouteScoringInput;

export interface RouteDepartureAdviceInput extends BaseRouteScoringInput {
  windowMinutes?: number;
  stepMinutes?: number;
  minimumSavingSeconds?: number;
  minimumCoveragePercent?: number;
}

type WorkerRequestWithoutGrid = ScheduleScoreRequest | DepartureAdviceRequest;
type TaskResult = LabelledRasterScore[] | DepartureAdviceResult;

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(type: "messageerror", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: "messageerror", listener: () => void): void;
}

interface PendingRequest<T extends TaskResult = TaskResult> {
  generation: number;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  runFallback: () => T;
}

export class RouteScoringCancelledError extends Error {
  constructor() {
    super("A newer route exposure calculation replaced this request.");
    this.name = "RouteScoringCancelledError";
  }
}

export function isRouteScoringCancelledError(error: unknown): error is RouteScoringCancelledError {
  return error instanceof RouteScoringCancelledError;
}

function validDeparture(date: Date) {
  if (Number.isNaN(date.getTime())) throw new RangeError("departure must be a valid Date.");
}

function scoreSynchronously(input: RouteScheduleScoringInput) {
  validDeparture(input.departure);
  return labelRouteScores(
    input.routes.map((route) =>
      scoreRouteSchedule(
        route,
        input.grid,
        input.departure,
        input.journeyCount,
        input.repeatEveryMinutes,
        input.walkingPace,
      ),
    ),
    input.profile,
  );
}

function adviceSynchronously(input: RouteDepartureAdviceInput) {
  validDeparture(input.departure);
  return buildDepartureAdvice({
    routes: input.routes,
    grid: input.grid,
    departure: input.departure,
    profile: input.profile,
    journeyCount: input.journeyCount,
    repeatEveryMinutes: input.repeatEveryMinutes,
    walkingPace: input.walkingPace,
    windowMinutes: input.windowMinutes,
    stepMinutes: input.stepMinutes,
    minimumSavingSeconds: input.minimumSavingSeconds,
    minimumCoveragePercent: input.minimumCoveragePercent,
  });
}

/**
 * Owns one long-lived worker and one copied grid. Requests contain routes and
 * times only; switching grids cancels work tied to the previous coverage.
 */
export class RouteScoringClient {
  private readonly workerFactory: () => WorkerLike;
  private worker: WorkerLike | null = null;
  private workerUnavailable = false;
  private activeGrid: { areaId: string; grid: HeightGrid; version: number } | null = null;
  private nextGeneration = 0;
  private nextGridVersion = 0;
  private readonly pending = new Map<ScoringTask, PendingRequest>();

  constructor(workerFactory: () => WorkerLike) {
    this.workerFactory = workerFactory;
  }

  scoreRoutes(input: RouteScheduleScoringInput): Promise<LabelledRasterScore[]> {
    validDeparture(input.departure);
    const worker = this.prepareWorker(input.areaId, input.grid);
    const generation = this.nextRequestGeneration();
    const gridVersion = this.activeGrid?.version ?? 0;
    const request = createScheduleScoreRequest(generation, gridVersion, {
      routes: input.routes,
      departureEpochMs: input.departure.getTime(),
      profile: input.profile,
      journeyCount: input.journeyCount,
      repeatEveryMinutes: input.repeatEveryMinutes,
      walkingPace: input.walkingPace ?? "standard",
    });
    return this.dispatch<LabelledRasterScore[]>(
      "scores",
      generation,
      request,
      () => scoreSynchronously(input),
      worker,
    );
  }

  buildDepartureAdvice(input: RouteDepartureAdviceInput): Promise<DepartureAdviceResult> {
    validDeparture(input.departure);
    const worker = this.prepareWorker(input.areaId, input.grid);
    const generation = this.nextRequestGeneration();
    const gridVersion = this.activeGrid?.version ?? 0;
    const request = createDepartureAdviceRequest(generation, gridVersion, {
      routes: input.routes,
      departureEpochMs: input.departure.getTime(),
      profile: input.profile,
      journeyCount: input.journeyCount,
      repeatEveryMinutes: input.repeatEveryMinutes,
      walkingPace: input.walkingPace ?? "standard",
      windowMinutes: input.windowMinutes,
      stepMinutes: input.stepMinutes,
      minimumSavingSeconds: input.minimumSavingSeconds,
      minimumCoveragePercent: input.minimumCoveragePercent,
    });
    return this.dispatch<DepartureAdviceResult>(
      "advice",
      generation,
      request,
      () => adviceSynchronously(input),
      worker,
    );
  }

  cancelScores() {
    this.cancel("scores");
  }

  cancelDepartureAdvice() {
    this.cancel("advice");
  }

  dispose() {
    this.cancel("scores");
    this.cancel("advice");
    this.detachWorker();
    this.activeGrid = null;
  }

  private nextRequestGeneration() {
    this.nextGeneration += 1;
    return this.nextGeneration;
  }

  private prepareWorker(areaId: string, grid: HeightGrid) {
    if (this.workerUnavailable) return null;
    if (!this.worker) {
      try {
        this.worker = this.workerFactory();
        this.worker.addEventListener("message", this.handleMessage);
        this.worker.addEventListener("error", this.handleError);
        this.worker.addEventListener("messageerror", this.handleMessageError);
      } catch {
        this.workerUnavailable = true;
        this.worker = null;
        return null;
      }
    }

    if (this.activeGrid?.areaId === areaId && this.activeGrid.grid === grid) {
      return this.worker;
    }

    this.cancel("scores");
    this.cancel("advice");
    const version = this.nextGridVersion + 1;
    this.nextGridVersion = version;
    const initialisation = createScoringGridInitialisation(version, areaId, grid);
    try {
      this.worker.postMessage(initialisation.message, initialisation.transfer);
      this.activeGrid = { areaId, grid, version };
      return this.worker;
    } catch {
      this.handleWorkerFailure();
      return null;
    }
  }

  private dispatch<T extends TaskResult>(
    task: ScoringTask,
    generation: number,
    request: WorkerRequestWithoutGrid,
    runFallback: () => T,
    worker: WorkerLike | null,
  ): Promise<T> {
    this.cancel(task);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(task, {
        generation,
        resolve: resolve as (value: TaskResult) => void,
        reject,
        runFallback,
      });
      if (!worker) {
        this.scheduleFallback(task, generation);
        return;
      }
      try {
        worker.postMessage(request);
      } catch {
        this.handleWorkerFailure();
      }
    });
  }

  private scheduleFallback(task: ScoringTask, generation: number) {
    globalThis.setTimeout(() => {
      const pending = this.pending.get(task);
      if (!pending || pending.generation !== generation) return;
      try {
        const result = pending.runFallback();
        if (this.pending.get(task) !== pending) return;
        this.pending.delete(task);
        pending.resolve(result);
      } catch (error) {
        if (this.pending.get(task) !== pending) return;
        this.pending.delete(task);
        pending.reject(error);
      }
    }, 0);
  }

  private cancel(task: ScoringTask) {
    const pending = this.pending.get(task);
    if (!pending) return;
    this.pending.delete(task);
    pending.reject(new RouteScoringCancelledError());
    try {
      this.worker?.postMessage({
        type: SCORING_CANCEL_REQUEST,
        task,
        generation: pending.generation,
      });
    } catch {
      this.handleWorkerFailure();
    }
  }

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    if (!isScoringWorkerResponse(event.data)) return;
    this.settleWorkerResponse(event.data);
  };

  private settleWorkerResponse(response: ScoringWorkerResponse) {
    const pending = this.pending.get(response.task);
    if (!pending || pending.generation !== response.generation) return;
    this.pending.delete(response.task);
    if (response.type === SCORING_FAILURE) {
      pending.reject(new Error(response.error));
      return;
    }
    if (response.type === SCHEDULE_SCORE_SUCCESS) {
      pending.resolve(response.scores);
      return;
    }
    if (response.type === DEPARTURE_ADVICE_SUCCESS) pending.resolve(response.advice);
  }

  private readonly handleError = (event: ErrorEvent) => {
    event.preventDefault();
    this.handleWorkerFailure();
  };

  private readonly handleMessageError = () => this.handleWorkerFailure();

  private handleWorkerFailure() {
    this.workerUnavailable = true;
    this.detachWorker();
    this.activeGrid = null;
    for (const [task, pending] of this.pending) {
      this.scheduleFallback(task, pending.generation);
    }
  }

  private detachWorker() {
    if (!this.worker) return;
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.removeEventListener("messageerror", this.handleMessageError);
    this.worker.terminate();
    this.worker = null;
  }
}
