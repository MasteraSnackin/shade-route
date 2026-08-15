import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GET } from "../app/api/health/route.ts";

test("health endpoint exposes only a fixed liveness result", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "shade-route",
    check: "liveness",
  });
});

test("health endpoint does not inspect requests, configuration or dependencies", async () => {
  const source = await readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /request|headers\.get|process\.env|fetch\(|latitude|longitude|coordinates|geometry|query|user-agent|x-forwarded-for/i,
  );
});
