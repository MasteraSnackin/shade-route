const applicationOrigin = process.env.SHADE_ROUTE_BASE_URL ?? "http://localhost:3000";
const valhallaStatusUrl = process.env.VALHALLA_STATUS_URL ?? "http://127.0.0.1:8002/status";
const REQUEST_TIMEOUT_MS = 12_000;

const checks = [
  {
    areaId: "waterloo",
    origin: { lat: 51.50225, lon: -0.11316 },
    destination: { lat: 51.49906, lon: -0.1187 },
    accessPreference: "standard",
  },
  {
    areaId: "kings-cross",
    origin: { lat: 51.53049, lon: -0.12329 },
    destination: { lat: 51.52486, lon: -0.13651 },
    accessPreference: "avoid-known-steps",
  },
];

function requireObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value;
}

async function boundedFetch(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function checkHealth() {
  const response = await boundedFetch(new URL("/api/health", applicationOrigin));
  const body = requireObject(await response.json(), "The health response was not an object.");
  if (!response.ok || body.status !== "ok" || body.check !== "liveness") {
    throw new Error(`Application health check failed with HTTP ${response.status}.`);
  }
}

async function checkValhalla() {
  const response = await boundedFetch(valhallaStatusUrl);
  const body = requireObject(await response.json(), "The Valhalla status response was not an object.");
  if (!response.ok || !Array.isArray(body.available_actions) || !body.available_actions.includes("route")) {
    throw new Error(`Valhalla readiness check failed with HTTP ${response.status}.`);
  }
}

async function checkRoute(check) {
  const startedAt = performance.now();
  const response = await boundedFetch(new URL("/api/route", applicationOrigin), {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      origin: check.origin,
      destination: check.destination,
      accessPreference: check.accessPreference,
    }),
  });
  const body = requireObject(await response.json(), "The route response was not an object.");
  const delivery = response.headers.get("x-shaderoute-route-delivery");
  const provider = response.headers.get("x-shaderoute-route-provider");
  if (
    !response.ok ||
    delivery !== "primary" ||
    provider !== "local-loopback" ||
    body.areaId !== check.areaId ||
    !Array.isArray(body.routes) ||
    body.routes.length < 1 ||
    body.routes.length > 3 ||
    body.routes.some((route) => {
      const candidate = requireObject(route, "A route was not an object.");
      return !Number.isFinite(candidate.distanceMetres) || candidate.distanceMetres <= 0 ||
        !Number.isFinite(candidate.durationSeconds) || candidate.durationSeconds <= 0 ||
        !Array.isArray(candidate.coordinates) || candidate.coordinates.length < 2;
    })
  ) {
    throw new Error(
      `${check.areaId} route check failed with HTTP ${response.status}; expected local controlled-primary delivery, received ${delivery ?? "no delivery marker"}/${provider ?? "no provider marker"}.`,
    );
  }
  return {
    areaId: check.areaId,
    accessPreference: check.accessPreference,
    delivery,
    provider,
    routeCount: body.routes.length,
    latencyMs: Math.round(performance.now() - startedAt),
  };
}

await checkValhalla();
await checkHealth();
const outcomes = [];
for (const check of checks) outcomes.push(await checkRoute(check));

console.log(JSON.stringify({ status: "ok", checks: outcomes }, null, 2));
