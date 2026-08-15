import { readBoundedJson } from "./bounded-json.ts";
import {
  PLACE_SEARCH_RESULT_LIMIT,
  pointInsidePlaceSearchArea,
  type OnlinePlaceResult,
  type OnlinePlaceSearchResponse,
} from "./place-search-contract.ts";
import type { PilotArea } from "./routes.ts";

const MAX_API_RESPONSE_BYTES = 64_000;

function validResult(value: unknown, area: PilotArea): value is OnlinePlaceResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.id === "string" &&
    /^[a-z0-9-]{1,80}$/.test(result.id) &&
    typeof result.name === "string" &&
    result.name.trim().length > 0 &&
    result.name.length <= 180 &&
    typeof result.kind === "string" &&
    result.kind.trim().length > 0 &&
    result.kind.length <= 100 &&
    typeof result.lon === "number" &&
    Number.isFinite(result.lon) &&
    typeof result.lat === "number" &&
    Number.isFinite(result.lat) &&
    pointInsidePlaceSearchArea(result.lon, result.lat, area)
  );
}

export function parseOnlinePlaceSearchResponse(
  payload: unknown,
  area: PilotArea,
): OnlinePlaceSearchResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Online place search returned an invalid response.");
  }
  const response = payload as Record<string, unknown>;
  if (
    (response.status !== "available" && response.status !== "unavailable") ||
    !Array.isArray(response.results) ||
    response.results.length > PLACE_SEARCH_RESULT_LIMIT ||
    !response.results.every((result) => validResult(result, area)) ||
    (response.status === "unavailable" && response.results.length > 0)
  ) {
    throw new Error("Online place search returned an invalid response.");
  }
  return {
    status: response.status,
    results: response.results,
  };
}

export async function fetchOnlinePlaceSearch(
  area: PilotArea,
  query: string,
  options: { signal?: AbortSignal; fetchImplementation?: typeof fetch } = {},
) {
  const response = await (options.fetchImplementation ?? fetch)("/api/place-search", {
    method: "POST",
    cache: "no-store",
    signal: options.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ areaId: area.id, query }),
  });
  if (!response.ok) throw new Error("Online place search is unavailable.");
  return parseOnlinePlaceSearchResponse(
    await readBoundedJson(response, MAX_API_RESPONSE_BYTES),
    area,
  );
}
