import { compactValhallaResponse, type PilotArea } from "../../../lib/routes";

const AREAS: Array<Pick<PilotArea, "id" | "bbox">> = [
  { id: "waterloo", bbox: [-0.13, 51.4915, -0.0975, 51.5095] },
  { id: "kings-cross", bbox: [-0.145, 51.517, -0.109, 51.5365] },
];

type RoutePoint = { lat: number; lon: number };

const UPSTREAM_TIMEOUT_MS = 8_000;
const PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
};

function privateJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: PRIVATE_RESPONSE_HEADERS });
}

function validPoint(value: unknown): value is RoutePoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.lat === "number" &&
    typeof point.lon === "number" &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon)
  );
}

function areaForPoints(origin: RoutePoint, destination: RoutePoint) {
  return AREAS.find(({ bbox }) => {
    const [west, south, east, north] = bbox;
    const inside = (point: RoutePoint) =>
      point.lon >= west && point.lon <= east && point.lat >= south && point.lat <= north;
    return inside(origin) && inside(destination);
  });
}

export async function POST(request: Request) {
  let body: { origin?: unknown; destination?: unknown };
  try {
    body = await request.json();
  } catch {
    return privateJson({ error: "The route request was not valid JSON." }, 400);
  }

  if (!validPoint(body.origin) || !validPoint(body.destination)) {
    return privateJson({ error: "Choose a valid start and destination." }, 400);
  }

  const area = areaForPoints(body.origin, body.destination);
  if (!area) {
    return privateJson(
      { error: "Both points must be inside the same ShadeRoute pilot area." },
      400,
    );
  }

  const upstream = process.env.VALHALLA_URL ?? "https://valhalla1.openstreetmap.de/route";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const abortForClient = () => controller.abort();
  if (request.signal.aborted) {
    controller.abort();
  } else {
    request.signal.addEventListener("abort", abortForClient, { once: true });
  }

  try {
    const response = await fetch(upstream, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Client-Id": "shaderoute-hackathon",
      },
      body: JSON.stringify({
        locations: [body.origin, body.destination],
        costing: "pedestrian",
        alternates: 2,
        units: "kilometers",
        language: "en-GB",
      }),
    });

    if (!response.ok) {
      return privateJson(
        { error: "Walking routes are temporarily unavailable. Try a pilot journey." },
        503,
      );
    }

    const routes = compactValhallaResponse(await response.json(), area.id);
    return privateJson({ areaId: area.id, routes });
  } catch {
    return privateJson(
      { error: "Walking routes are temporarily unavailable. Try a pilot journey." },
      503,
    );
  } finally {
    clearTimeout(timeoutId);
    request.signal.removeEventListener("abort", abortForClient);
  }
}
