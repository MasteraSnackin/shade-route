import type { HeightGrid } from "../lib/raster-shade";
import {
  createLatestShadowRenderQueue,
  createShadowRenderSuccess,
  SHADOW_GRID_INITIALISE,
  SHADOW_RENDER_FAILURE,
  SHADOW_RENDER_REQUEST,
  type ShadowRenderFailure,
  type ShadowRenderRequest,
  type ShadowRenderResponse,
  type ShadowWorkerRequest,
} from "../lib/shadow-worker-protocol";
import { renderGroundShadowFrame } from "../lib/shadow-raster";

interface ShadowWorkerScope {
  onmessage: ((event: MessageEvent<ShadowWorkerRequest>) => void) | null;
  postMessage(message: ShadowRenderResponse, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as ShadowWorkerScope;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Ground-shadow rendering failed.";
}

let activeGrid: HeightGrid | null = null;
let activeGridVersion = -1;

function postFailure(request: ShadowRenderRequest, error: unknown) {
  const response: ShadowRenderFailure = {
    type: SHADOW_RENDER_FAILURE,
    generation: request.generation,
    error: errorMessage(error),
  };
  workerScope.postMessage(response);
}

const renderQueue = createLatestShadowRenderQueue((request) => {
  try {
    if (!activeGrid || activeGridVersion !== request.gridVersion) {
      throw new Error("Ground-shadow coverage is not initialised.");
    }
    const frame = renderGroundShadowFrame(
      activeGrid,
      new Date(request.dateEpochMs),
      request.centre,
    );
    const { message, transfer } = createShadowRenderSuccess(request.generation, frame);
    workerScope.postMessage(message, transfer);
  } catch (error) {
    postFailure(request, error);
  }
});

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === SHADOW_GRID_INITIALISE) {
    renderQueue.clear();
    activeGrid = {
      metadata: request.grid.metadata,
      heights: new Uint8Array(request.grid.heights),
      validity: request.grid.validity ? new Uint8Array(request.grid.validity) : undefined,
    };
    activeGridVersion = request.gridVersion;
    return;
  }
  if (request.type === SHADOW_RENDER_REQUEST) renderQueue.enqueue(request);
};
