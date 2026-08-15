import {
  validateWalkingRoute,
  type NamedPoint,
  type PilotArea,
  type RouteDirection,
  type WalkingRoute,
} from "./routes.ts";
import {
  isRouteApiErrorCode,
  type RouteApiErrorCode,
} from "./route-api-contract.ts";
import type { RouteAccessPreference } from "./route-preferences.ts";

type RoutePoint = Pick<NamedPoint, "lat" | "lon">;
type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface LiveRouteRequestInput {
  area: Pick<PilotArea, "id" | "bbox">;
  origin: RoutePoint;
  destination: RoutePoint;
  accessPreference?: RouteAccessPreference;
}

export interface LiveRouteRequestResult {
  areaId: PilotArea["id"];
  routes: WalkingRoute[];
  /** Monotonically increasing identifier for the request that produced this result. */
  generation: number;
}

export type LiveRouteCancellationReason = "superseded" | "cancelled" | "disposed";

export interface LiveRouteRequestClientOptions {
  endpoint?: string;
  fetchImplementation?: FetchImplementation;
  requestTimeoutMs?: number;
}

interface ActiveRequest {
  generation: number;
  controller: AbortController;
  cancellationReason: LiveRouteCancellationReason | null;
  timedOut: boolean;
}

const MAX_ROUTES = 3;
const MAX_ROUTE_COORDINATES = 10_000;
const MAX_ROUTE_DIRECTIONS = 512;
const MAX_ROUTE_DISTANCE_METRES = 10_000;
const MAX_ROUTE_DURATION_SECONDS = 4 * 60 * 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type LiveRouteRequestErrorCode =
  | RouteApiErrorCode
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "NETWORK_FAILURE"
  | "REQUEST_TIMEOUT";

interface LiveRouteRequestErrorOptions {
  status?: number;
  code: LiveRouteRequestErrorCode;
  retryable: boolean;
  cause?: unknown;
}

export class LiveRouteRequestCancelledError extends Error {
  readonly reason: LiveRouteCancellationReason;

  constructor(reason: LiveRouteCancellationReason) {
    const messages: Record<LiveRouteCancellationReason, string> = {
      superseded: "A newer walking-route request replaced this one.",
      cancelled: "The walking-route request was cancelled.",
      disposed: "The walking-route requester was closed.",
    };
    super(messages[reason]);
    this.name = "LiveRouteRequestCancelledError";
    this.reason = reason;
  }
}

export class LiveRouteRequestError extends Error {
  readonly status: number | undefined;
  readonly code: LiveRouteRequestErrorCode;
  readonly retryable: boolean;

  constructor(message: string, options: LiveRouteRequestErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LiveRouteRequestError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export function isLiveRouteRequestCancelledError(
  error: unknown,
): error is LiveRouteRequestCancelledError {
  return error instanceof LiveRouteRequestCancelledError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    Math.abs(value[0]) <= 180 &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1]) &&
    Math.abs(value[1]) <= 90;
}

function isOptionalFiniteNumber(value: unknown) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalBoundedString(value: unknown, maximumLength: number) {
  return value === undefined || (typeof value === "string" && value.length <= maximumLength);
}

function isRouteDirection(value: unknown, coordinateCount: number): value is RouteDirection {
  if (!isRecord(value)) return false;
  return typeof value.instruction === "string" &&
    value.instruction.length <= 500 &&
    typeof value.distanceMetres === "number" &&
    Number.isFinite(value.distanceMetres) &&
    value.distanceMetres >= 0 &&
    typeof value.durationSeconds === "number" &&
    Number.isFinite(value.durationSeconds) &&
    value.durationSeconds >= 0 &&
    Number.isSafeInteger(value.beginIndex) &&
    (value.beginIndex as number) >= 0 &&
    Number.isSafeInteger(value.endIndex) &&
    (value.endIndex as number) >= (value.beginIndex as number) &&
    (value.endIndex as number) < coordinateCount &&
    isOptionalFiniteNumber(value.maneuverType) &&
    isOptionalFiniteNumber(value.bearingAfter) &&
    isOptionalBoundedString(value.succinctInstruction, 500) &&
    (value.roughSurfaceFlag === undefined || typeof value.roughSurfaceFlag === "boolean") &&
    isOptionalBoundedString(value.travelType, 40);
}

function isWalkingRoute(
  value: unknown,
  input: LiveRouteRequestInput,
): value is WalkingRoute {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 200 ||
    !Array.isArray(value.coordinates) ||
    value.coordinates.length < 2 ||
    value.coordinates.length > MAX_ROUTE_COORDINATES ||
    !Array.isArray(value.directions)
  ) {
    return false;
  }
  const coordinates = value.coordinates;
  const directions = value.directions;
  if (
    !coordinates.every(isFiniteCoordinate) ||
    typeof value.distanceMetres !== "number" ||
    !Number.isFinite(value.distanceMetres) ||
    value.distanceMetres <= 0 ||
    value.distanceMetres > MAX_ROUTE_DISTANCE_METRES ||
    typeof value.durationSeconds !== "number" ||
    !Number.isFinite(value.durationSeconds) ||
    value.durationSeconds <= 0 ||
    value.durationSeconds > MAX_ROUTE_DURATION_SECONDS ||
    directions.length > MAX_ROUTE_DIRECTIONS ||
    !directions.every((direction) =>
      isRouteDirection(direction, coordinates.length)
    ) ||
    !isOptionalBoundedString(value.accessReference, 10_000)
  ) {
    return false;
  }

  return validateWalkingRoute(value as unknown as WalkingRoute, {
    origin: input.origin,
    destination: input.destination,
    bbox: input.area.bbox,
  });
}

function parseSuccessfulResponse(
  payload: unknown,
  input: LiveRouteRequestInput,
): Pick<LiveRouteRequestResult, "areaId" | "routes"> {
  if (!isRecord(payload) || payload.areaId !== input.area.id) {
    throw new LiveRouteRequestError(
      "The routing response did not match the requested pilot area.",
      { code: "INVALID_RESPONSE", retryable: false },
    );
  }
  if (
    !Array.isArray(payload.routes) ||
    payload.routes.length === 0 ||
    payload.routes.length > MAX_ROUTES ||
    !payload.routes.every((route) => isWalkingRoute(route, input))
  ) {
    throw new LiveRouteRequestError(
      "The routing response did not include valid walking routes.",
      { code: "INVALID_RESPONSE", retryable: false },
    );
  }
  const routes = payload.routes as WalkingRoute[];
  if (new Set(routes.map((route) => route.id)).size !== routes.length) {
    throw new LiveRouteRequestError(
      "The routing response included duplicate walking routes.",
      { code: "INVALID_RESPONSE", retryable: false },
    );
  }
  return { areaId: input.area.id, routes };
}

function responseErrorDetails(payload: unknown, status: number) {
  const defaultMessage = "Walking routes are temporarily unavailable.";
  if (isRecord(payload) && typeof payload.error === "string") {
    const safeMessage = payload.error.trim();
    if (safeMessage && safeMessage.length <= 500) {
      return {
        message: safeMessage,
        code: isRouteApiErrorCode(payload.code) ? payload.code : "HTTP_ERROR",
        retryable: payload.retryable === true || status === 408 || status === 429 || status >= 500,
      } as const;
    }
  }
  return {
    message: defaultMessage,
    code: isRecord(payload) && isRouteApiErrorCode(payload.code)
      ? payload.code
      : "HTTP_ERROR",
    retryable: status === 408 || status === 429 || status >= 500,
  } as const;
}

/**
 * Owns the single current live-route request. Starting another request aborts
 * its predecessor, while the generation check also rejects a stale response
 * from a fetch implementation that does not honour AbortSignal.
 */
export class LiveRouteRequestClient {
  private readonly endpoint: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly requestTimeoutMs: number;
  private nextGeneration = 0;
  private activeRequest: ActiveRequest | null = null;
  private disposed = false;

  constructor(options: LiveRouteRequestClientOptions = {}) {
    this.endpoint = options.endpoint ?? "/api/route";
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new RangeError("requestTimeoutMs must be a positive safe integer.");
    }
  }

  get activeGeneration() {
    return this.activeRequest?.generation ?? null;
  }

  get hasActiveRequest() {
    return this.activeRequest !== null;
  }

  async request(input: LiveRouteRequestInput): Promise<LiveRouteRequestResult> {
    if (this.disposed) {
      throw new LiveRouteRequestCancelledError("disposed");
    }

    this.cancelRequest("superseded");
    const request: ActiveRequest = {
      generation: ++this.nextGeneration,
      controller: new AbortController(),
      cancellationReason: null,
      timedOut: false,
    };
    this.activeRequest = request;
    let rejectForAbort: () => void = () => undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectForAbort = () => reject(
        request.controller.signal.reason ??
          new DOMException("The route request was aborted.", "AbortError"),
      );
      if (request.controller.signal.aborted) rejectForAbort();
      else request.controller.signal.addEventListener("abort", rejectForAbort, { once: true });
    });
    const timeoutId = setTimeout(() => {
      if (this.activeRequest !== request) return;
      request.timedOut = true;
      request.controller.abort(new DOMException("The route request timed out.", "TimeoutError"));
    }, this.requestTimeoutMs);

    try {
      const response = await Promise.race([
        this.fetchImplementation(this.endpoint, {
          method: "POST",
          cache: "no-store",
          signal: request.controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            origin: input.origin,
            destination: input.destination,
            accessPreference: input.accessPreference ?? "standard",
          }),
        }),
        abortPromise,
      ]);
      this.assertCurrent(request);

      let payload: unknown;
      try {
        payload = await Promise.race([response.json(), abortPromise]);
      } catch {
        this.assertCurrent(request);
        throw new LiveRouteRequestError(
          response.ok
            ? "The routing service returned an unreadable response."
            : "Walking routes are temporarily unavailable.",
          {
            status: response.status,
            code: response.ok ? "INVALID_RESPONSE" : "HTTP_ERROR",
            retryable: true,
          },
        );
      }
      this.assertCurrent(request);

      if (!response.ok) {
        const details = responseErrorDetails(payload, response.status);
        throw new LiveRouteRequestError(details.message, {
          status: response.status,
          code: details.code,
          retryable: details.retryable,
        });
      }
      return {
        ...parseSuccessfulResponse(payload, input),
        generation: request.generation,
      };
    } catch (error) {
      if (request.timedOut) {
        throw new LiveRouteRequestError(
          "Walking-route lookup took too long. Check your connection and try again, or use a pilot journey.",
          {
            code: "REQUEST_TIMEOUT",
            retryable: true,
            cause: error,
          },
        );
      }
      if (error instanceof LiveRouteRequestCancelledError) throw error;
      if (!this.isCurrent(request) || request.controller.signal.aborted) {
        throw this.cancellationError(request);
      }
      if (error instanceof LiveRouteRequestError) throw error;
      throw new LiveRouteRequestError(
        "Could not reach walking routing. Check your connection and try again, or use a pilot journey.",
        {
          code: "NETWORK_FAILURE",
          retryable: true,
          cause: error,
        },
      );
    } finally {
      clearTimeout(timeoutId);
      request.controller.signal.removeEventListener("abort", rejectForAbort);
      if (this.activeRequest === request) this.activeRequest = null;
    }
  }

  cancel() {
    this.cancelRequest("cancelled");
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRequest("disposed");
  }

  private isCurrent(request: ActiveRequest) {
    return this.activeRequest === request &&
      request.generation === this.nextGeneration &&
      !request.controller.signal.aborted;
  }

  private assertCurrent(request: ActiveRequest) {
    if (!this.isCurrent(request)) throw this.cancellationError(request);
  }

  private cancellationError(request: ActiveRequest) {
    return new LiveRouteRequestCancelledError(
      request.cancellationReason ?? (this.disposed ? "disposed" : "superseded"),
    );
  }

  private cancelRequest(reason: LiveRouteCancellationReason) {
    const active = this.activeRequest;
    if (!active) return;
    active.cancellationReason = reason;
    this.activeRequest = null;
    active.controller.abort();
  }
}
