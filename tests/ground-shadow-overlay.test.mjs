import assert from "node:assert/strict";
import test from "node:test";

import {
  concealGroundShadowOverlay,
  groundShadowUnavailableMessage,
  GROUND_SHADOW_LAYER_ID,
  GROUND_SHADOW_SOURCE_ID,
} from "../lib/ground-shadow-overlay.ts";

test("concealing a stale frame only hides and pauses the ground-shadow overlay", () => {
  const calls = [];
  const map = {
    getLayer(id) {
      calls.push(["get-layer", id]);
      return { id };
    },
    setPaintProperty(...args) {
      calls.push(["set-paint", ...args]);
    },
    getSource(id) {
      calls.push(["get-source", id]);
      return { pause: () => calls.push(["pause"]) };
    },
    triggerRepaint() {
      calls.push(["repaint"]);
    },
  };

  concealGroundShadowOverlay(map);

  assert.deepEqual(calls, [
    ["get-layer", GROUND_SHADOW_LAYER_ID],
    ["set-paint", GROUND_SHADOW_LAYER_ID, "raster-opacity", 0],
    ["get-source", GROUND_SHADOW_SOURCE_ID],
    ["pause"],
    ["repaint"],
  ]);
});

test("concealing before the shadow layer exists is safe and still repaints", () => {
  const calls = [];
  concealGroundShadowOverlay({
    getLayer: () => undefined,
    setPaintProperty: () => calls.push("unexpected-paint"),
    getSource: () => undefined,
    triggerRepaint: () => calls.push("repaint"),
  });
  assert.deepEqual(calls, ["repaint"]);
});

test("unavailable messages are fixed, bounded and never include raw failures", () => {
  const rawFailure = "private-path /Users/example/height.bin";
  const reasons = [
    "height-data",
    "render",
    "worker-start",
    "worker-timeout",
    "worker-failure",
    "worker-message",
  ];
  for (const reason of reasons) {
    const message = groundShadowUnavailableMessage(reason, Number.MAX_SAFE_INTEGER);
    assert.ok(message.length > 20 && message.length < 180);
    assert.match(message, /Routes remain available\.$/);
    assert.doesNotMatch(message, new RegExp(rawFailure));
  }
  assert.match(
    groundShadowUnavailableMessage("worker-timeout", Number.MAX_SAFE_INTEGER),
    /within 30 seconds/,
  );
});
