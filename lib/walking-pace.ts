export type WalkingPace = "slow" | "standard" | "brisk";

export interface WalkingPacePreset {
  id: WalkingPace;
  label: string;
  /** Multiplies the routing provider's standard walking duration. */
  durationMultiplier: number;
  description: string;
}

export const WALKING_PACE_PRESETS: Readonly<Record<WalkingPace, WalkingPacePreset>> = {
  slow: {
    id: "slow",
    label: "Slow",
    durationMultiplier: 1.5,
    description: "Allows 50% more time than the standard route estimate.",
  },
  standard: {
    id: "standard",
    label: "Standard",
    durationMultiplier: 1,
    description: "Uses the routing provider's standard walking-time estimate.",
  },
  brisk: {
    id: "brisk",
    label: "Brisk",
    durationMultiplier: 0.8,
    description: "Allows 20% less time than the standard route estimate.",
  },
};

export function isWalkingPace(value: unknown): value is WalkingPace {
  return value === "slow" || value === "standard" || value === "brisk";
}

export function resolveWalkingPace(value: unknown): WalkingPace {
  return isWalkingPace(value) ? value : "standard";
}

export function walkingDurationSeconds(
  route: { durationSeconds: number },
  walkingPace: WalkingPace = "standard",
) {
  return route.durationSeconds * WALKING_PACE_PRESETS[walkingPace].durationMultiplier;
}
