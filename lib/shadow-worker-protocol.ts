import type { HeightGrid, HeightGridMetadata } from "./raster-shade";
import type { Coordinate } from "./routes";
import type { GroundShadowFrame } from "./shadow-raster";

export const SHADOW_GRID_INITIALISE = "initialise-shadow-grid" as const;
export const SHADOW_RENDER_REQUEST = "render-ground-shadow" as const;
export const SHADOW_RENDER_SUCCESS = "ground-shadow-rendered" as const;
export const SHADOW_RENDER_FAILURE = "ground-shadow-failed" as const;

interface TransferableHeightGrid {
  metadata: HeightGridMetadata;
  heights: ArrayBuffer;
  validity?: ArrayBuffer;
}

export interface ShadowGridInitialiseRequest {
  type: typeof SHADOW_GRID_INITIALISE;
  gridVersion: number;
  grid: TransferableHeightGrid;
}

export interface ShadowRenderRequest {
  type: typeof SHADOW_RENDER_REQUEST;
  generation: number;
  gridVersion: number;
  dateEpochMs: number;
  centre: Coordinate;
}

export type ShadowWorkerRequest = ShadowGridInitialiseRequest | ShadowRenderRequest;

export interface TransferableGroundShadowFrame
  extends Omit<GroundShadowFrame, "pixels"> {
  pixels: ArrayBuffer;
}

export interface ShadowRenderSuccess {
  type: typeof SHADOW_RENDER_SUCCESS;
  generation: number;
  frame: TransferableGroundShadowFrame;
}

export interface ShadowRenderFailure {
  type: typeof SHADOW_RENDER_FAILURE;
  generation: number;
  error: string;
}

export type ShadowRenderResponse = ShadowRenderSuccess | ShadowRenderFailure;

/**
 * Copy the cached grid before transferring it. Transferring the cache's own
 * buffer would detach it and break route exposure scoring elsewhere.
 */
export function createShadowGridInitialisation(
  gridVersion: number,
  grid: HeightGrid,
): { message: ShadowGridInitialiseRequest; transfer: Transferable[] } {
  const heights = Uint8Array.from(grid.heights).buffer;
  const validity = grid.validity ? Uint8Array.from(grid.validity).buffer : undefined;
  return {
    message: {
      type: SHADOW_GRID_INITIALISE,
      gridVersion,
      grid: { metadata: grid.metadata, heights, validity },
    },
    transfer: validity ? [heights, validity] : [heights],
  };
}

/** Create the lightweight message sent for each time change. */
export function createShadowRenderRequest(
  generation: number,
  gridVersion: number,
  date: Date,
  centre: Coordinate,
): ShadowRenderRequest {
  return {
    type: SHADOW_RENDER_REQUEST,
    generation,
    gridVersion,
    dateEpochMs: date.getTime(),
    centre,
  };
}

export interface LatestShadowRenderQueue {
  enqueue(request: ShadowRenderRequest): void;
  clear(): void;
}

/**
 * Defer rendering by one task so a burst of already-posted time changes can
 * collapse to its latest request before the expensive synchronous raster pass.
 */
export function createLatestShadowRenderQueue(
  render: (request: ShadowRenderRequest) => void,
  schedule: (flush: () => void) => void = (flush) => {
    globalThis.setTimeout(flush, 0);
  },
): LatestShadowRenderQueue {
  let pending: ShadowRenderRequest | null = null;
  let scheduled = false;

  return {
    enqueue(request) {
      pending = request;
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        const latest = pending;
        pending = null;
        if (latest) render(latest);
      });
    },
    clear() {
      pending = null;
    },
  };
}

export function createShadowRenderSuccess(
  generation: number,
  frame: GroundShadowFrame,
): { message: ShadowRenderSuccess; transfer: Transferable[] } {
  // renderGroundShadowFrame creates this array, so it owns the entire buffer.
  const pixels = frame.pixels.buffer as ArrayBuffer;
  return {
    message: {
      type: SHADOW_RENDER_SUCCESS,
      generation,
      frame: {
        width: frame.width,
        height: frame.height,
        pixels,
        isDaylight: frame.isDaylight,
        azimuthDeg: frame.azimuthDeg,
        altitudeDeg: frame.altitudeDeg,
        shadowPercent: frame.shadowPercent,
      },
    },
    transfer: [pixels],
  };
}

export function isShadowRenderResponse(value: unknown): value is ShadowRenderResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<ShadowRenderResponse>;
  if (!Number.isSafeInteger(response.generation)) return false;
  if (response.type === SHADOW_RENDER_FAILURE) return typeof response.error === "string";
  if (response.type !== SHADOW_RENDER_SUCCESS || !response.frame) return false;
  return (
    Number.isSafeInteger(response.frame.width) &&
    Number.isSafeInteger(response.frame.height) &&
    response.frame.pixels instanceof ArrayBuffer &&
    typeof response.frame.isDaylight === "boolean" &&
    Number.isFinite(response.frame.azimuthDeg) &&
    Number.isFinite(response.frame.altitudeDeg) &&
    Number.isFinite(response.frame.shadowPercent)
  );
}

export function isShadowRenderResponseForGeneration(
  value: unknown,
  generation: number,
): value is ShadowRenderResponse {
  return isShadowRenderResponse(value) && value.generation === generation;
}

export function groundShadowFrameFromResponse(
  response: ShadowRenderSuccess,
): GroundShadowFrame {
  return {
    ...response.frame,
    pixels: new Uint8ClampedArray(response.frame.pixels),
  };
}
