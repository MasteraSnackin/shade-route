export const GROUND_SHADOW_SOURCE_ID = "ground-shadows";
export const GROUND_SHADOW_LAYER_ID = "ground-shadows-layer";

export interface GroundShadowOverlayMap {
  getLayer(id: string): unknown;
  setPaintProperty(layerId: string, property: string, value: unknown): unknown;
  getSource(id: string): unknown;
  triggerRepaint(): void;
}

/**
 * Conceal a previous frame synchronously before another generation starts.
 * Route, building and map geometry layers are intentionally left untouched.
 */
export function concealGroundShadowOverlay(map: GroundShadowOverlayMap) {
  if (map.getLayer(GROUND_SHADOW_LAYER_ID)) {
    map.setPaintProperty(GROUND_SHADOW_LAYER_ID, "raster-opacity", 0);
  }
  const source = map.getSource(GROUND_SHADOW_SOURCE_ID) as
    | { pause?: () => void }
    | undefined;
  source?.pause?.();
  map.triggerRepaint();
}

export type GroundShadowUnavailableReason =
  | "height-data"
  | "render"
  | "worker-start"
  | "worker-timeout"
  | "worker-failure"
  | "worker-message";

/** Fixed, user-safe messages avoid leaking raw worker or data-loader errors. */
export function groundShadowUnavailableMessage(
  reason: GroundShadowUnavailableReason,
  timeoutMilliseconds = 8_000,
) {
  switch (reason) {
    case "height-data":
      return "3D ground shade is unavailable because local height coverage could not be loaded. Routes remain available.";
    case "render":
      return "3D ground shade is unavailable because this frame could not be rendered. Routes remain available.";
    case "worker-start":
      return "3D ground shade is unavailable because the background renderer could not start. Routes remain available.";
    case "worker-timeout": {
      const boundedSeconds = Math.max(
        1,
        Math.min(30, Math.ceil(timeoutMilliseconds / 1_000)),
      );
      return `3D ground shade is unavailable because rendering did not finish within ${boundedSeconds} seconds. Routes remain available.`;
    }
    case "worker-message":
      return "3D ground shade is unavailable because the renderer returned unreadable data. Routes remain available.";
    case "worker-failure":
      return "3D ground shade is unavailable because the background renderer failed. Routes remain available.";
  }
}
