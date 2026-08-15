import { getCurrentJourneyContext } from "../../../lib/current-context-server.ts";
import { isCurrentContextAreaId } from "../../../lib/current-context.ts";

const RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=900",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(request: Request) {
  const areaId = new URL(request.url).searchParams.get("area");
  if (!isCurrentContextAreaId(areaId)) {
    return Response.json(
      {
        error: "Choose one of the two ShadeRoute pilot areas.",
        code: "INVALID_PILOT_AREA",
        allowedAreaIds: ["waterloo", "kings-cross"],
      },
      { status: 400, headers: { ...RESPONSE_HEADERS, "Cache-Control": "no-store" } },
    );
  }

  return Response.json(await getCurrentJourneyContext(areaId), { headers: RESPONSE_HEADERS });
}
