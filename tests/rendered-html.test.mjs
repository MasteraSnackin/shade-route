import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the ShadeRoute shell and production metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>ShadeRoute — less direct sun on foot<\/title>/i);
  assert.match(html, /estimated direct-sun exposure on two London hospital corridors/i);
  assert.match(html, /Loading the ShadeRoute London data pack/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("bundles both pilot corridors and removes the disposable starter", async () => {
  const [page, layout, packageJson, routeJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../public/data/pilot-routes.json", import.meta.url), "utf8"),
  ]);
  const routes = JSON.parse(routeJson);

  assert.match(page, /<ShadeRouteApp \/>/);
  assert.match(layout, /ShadeRoute — less direct sun on foot/);
  assert.match(packageJson, /"maplibre-gl"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.equal(routes.areas.length, 2);
  assert.deepEqual(routes.areas.map((area) => area.id), ["waterloo", "kings-cross"]);
  assert.ok(routes.areas.every((area) => area.routes.length === 3));

  for (const area of routes.areas) {
    await Promise.all([
      access(new URL(`../public/data/${area.id}-heights.bin`, import.meta.url)),
      access(new URL(`../public/data/${area.id}-heights.json`, import.meta.url)),
      access(new URL(`../public/data/${area.id}-terrain.bin`, import.meta.url)),
      access(new URL(`../public/data/${area.id}-surface-min.bin`, import.meta.url)),
      access(new URL(`../public/data/${area.id}-surface-max.bin`, import.meta.url)),
      access(new URL(`../public/data/${area.id}-map.json`, import.meta.url)),
    ]);
  }

  await assert.rejects(access(new URL("../app/_sites-preview/", import.meta.url)));
});
