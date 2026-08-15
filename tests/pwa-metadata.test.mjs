import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import manifest from "../app/manifest.ts";

function pngDimensions(bytes) {
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    "expected a PNG signature",
  );
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("the install manifest has a stable identity, useful shortcuts and complete icons", async () => {
  const value = manifest();
  assert.equal(value.id, "/");
  assert.equal(value.start_url, "/");
  assert.equal(value.scope, "/");
  assert.equal(value.lang, "en-GB");
  assert.equal(value.dir, "ltr");
  assert.equal(value.display, "standalone");
  assert.equal(value.orientation, "any");
  assert.equal(value.prefer_related_applications, false);
  assert.deepEqual(value.categories, ["navigation", "utilities"]);
  assert.deepEqual(
    value.shortcuts?.map((shortcut) => shortcut.url),
    ["/#route-planner", "/#method"],
  );

  const declaredIcons = new Map(value.icons?.map((icon) => [icon.src, icon]));
  const expected = [
    ["/app-icon-192.png", 192, "any"],
    ["/app-icon-512.png", 512, "any"],
    ["/app-icon-maskable-512.png", 512, "maskable"],
  ];
  for (const [path, size, purpose] of expected) {
    const icon = declaredIcons.get(path);
    assert.ok(icon, `${path} is not declared`);
    assert.equal(icon.sizes, `${size}x${size}`);
    assert.equal(icon.type, "image/png");
    assert.equal(icon.purpose, purpose);
    const bytes = await readFile(new URL(`../public${path}`, import.meta.url));
    assert.deepEqual(pngDimensions(bytes), [size, size]);
  }

  const appleIcon = await readFile(
    new URL("../public/apple-touch-icon.png", import.meta.url),
  );
  assert.deepEqual(pngDimensions(appleIcon), [180, 180]);
});
