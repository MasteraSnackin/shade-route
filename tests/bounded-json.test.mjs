import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedJsonError,
  readBoundedJson,
} from "../lib/bounded-json.ts";

test("bounded JSON accepts a valid body within its byte limit", async () => {
  const response = Response.json({ area: "waterloo", routes: 3 });
  assert.deepEqual(await readBoundedJson(response, 1_024), {
    area: "waterloo",
    routes: 3,
  });
});

test("bounded JSON rejects declared and streamed oversize bodies with a typed error", async (t) => {
  await t.test("declared length", async () => {
    const response = new Response("{}", {
      headers: { "Content-Length": "5000" },
    });
    await assert.rejects(
      readBoundedJson(response, 128),
      (error) => error instanceof BoundedJsonError && error.code === "payload_too_large",
    );
  });

  await t.test("streamed length", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"padding":"'));
        controller.enqueue(new TextEncoder().encode("x".repeat(256)));
      },
      cancel() {
        cancelled = true;
      },
    }));
    await assert.rejects(
      readBoundedJson(response, 64),
      (error) => error instanceof BoundedJsonError && error.code === "payload_too_large",
    );
    assert.equal(cancelled, true);
  });
});

test("bounded JSON distinguishes empty, invalid and unreadable bodies", async (t) => {
  await t.test("empty", async () => {
    await assert.rejects(
      readBoundedJson(new Response(null), 32),
      (error) => error instanceof BoundedJsonError && error.code === "empty_body",
    );
  });

  await t.test("invalid UTF-8 or JSON", async () => {
    for (const body of ["{", new Uint8Array([0xff])]) {
      await assert.rejects(
        readBoundedJson(new Response(body), 32),
        (error) => error instanceof BoundedJsonError && error.code === "invalid_json",
      );
    }
  });

  await t.test("locked stream", async () => {
    const response = new Response("{}");
    const lock = response.body.getReader();
    await assert.rejects(
      readBoundedJson(response, 32),
      (error) => error instanceof BoundedJsonError && error.code === "unreadable_body",
    );
    lock.releaseLock();
  });
});

test("bounded JSON fails fast when its configured limit is invalid", async () => {
  await assert.rejects(
    readBoundedJson(Response.json({}), 0),
    RangeError,
  );
});
