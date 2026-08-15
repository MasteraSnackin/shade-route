const HEALTH_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

/** Lightweight liveness only: it discloses no configuration or dependency data. */
export async function GET() {
  return Response.json(
    {
      status: "ok",
      service: "shade-route",
      check: "liveness",
    },
    { headers: HEALTH_HEADERS },
  );
}
