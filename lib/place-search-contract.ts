import type { PilotArea } from "./routes.ts";

export const PLACE_SEARCH_MIN_QUERY_LENGTH = 3;
export const PLACE_SEARCH_MAX_QUERY_LENGTH = 80;
export const PLACE_SEARCH_RESULT_LIMIT = 8;

export type PlaceSearchAreaId = PilotArea["id"];

export interface OnlinePlaceResult {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lon: number;
}

export interface OnlinePlaceSearchResponse {
  status: "available" | "unavailable";
  results: OnlinePlaceResult[];
}

export const PLACE_SEARCH_AREAS: Readonly<Record<PlaceSearchAreaId, {
  id: PlaceSearchAreaId;
  bbox: PilotArea["bbox"];
}>> = {
  waterloo: {
    id: "waterloo",
    bbox: [-0.13, 51.4915, -0.0975, 51.5095],
  },
  "kings-cross": {
    id: "kings-cross",
    bbox: [-0.145, 51.517, -0.109, 51.5365],
  },
};

export function placeSearchArea(value: unknown) {
  return typeof value === "string" && Object.hasOwn(PLACE_SEARCH_AREAS, value)
    ? PLACE_SEARCH_AREAS[value as PlaceSearchAreaId]
    : null;
}

export function pointInsidePlaceSearchArea(
  lon: number,
  lat: number,
  area: Pick<PilotArea, "bbox">,
) {
  const [west, south, east, north] = area.bbox;
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

function replaceUnsafeControls(value: string) {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
      ? " "
      : character;
  }).join("");
}

/**
 * Keep autocomplete queries small and predictable before they reach any
 * provider. NFKC also prevents visually equivalent cache keys multiplying.
 */
export function normalisePlaceSearchQuery(value: unknown) {
  if (typeof value !== "string") return null;
  const query = replaceUnsafeControls(value.normalize("NFKC"))
    .replace(/\s+/g, " ")
    .trim();
  if (
    query.length < PLACE_SEARCH_MIN_QUERY_LENGTH ||
    query.length > PLACE_SEARCH_MAX_QUERY_LENGTH
  ) return null;
  return query;
}
