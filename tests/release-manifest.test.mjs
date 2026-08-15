import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PILOT_DATA_VERSION,
  SHADE_MODEL_VERSION,
} from "../lib/release-identity.ts";
import {
  buildReleaseManifest,
  RELEASE_MANIFEST_FILE,
  serialiseReleaseManifest,
  writeOrCheckReleaseManifest,
} from "../scripts/release-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const comparePaths = (left, right) => left < right ? -1 : left > right ? 1 : 0;

test("the checked-in release manifest exactly matches its deterministic inputs", async () => {
  const manifest = await buildReleaseManifest(root);
  const checkedIn = await fs.readFile(path.join(root, RELEASE_MANIFEST_FILE), "utf8");
  const packageMetadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

  assert.equal(checkedIn, serialiseReleaseManifest(manifest));
  assert.equal(packageMetadata.private, true);
  assert.equal(packageMetadata.license, "UNLICENSED");
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.release.version, "0.1.0");
  assert.equal(manifest.release.channel, "pre-release");
  assert.equal(manifest.model.version, SHADE_MODEL_VERSION);
  assert.equal(manifest.dataPack.version, PILOT_DATA_VERSION);
  assert.deepEqual(manifest.dataPack.areas, ["kings-cross", "waterloo"]);
  assert.equal(manifest.validationProtocol.fixedPoint.observations.evidenceRows, 0);
  assert.equal(manifest.validationProtocol.routeWalkComparison.template.evidenceRows, 0);
  assert.equal(
    manifest.validationProtocol.fixedPoint.registrationStatus,
    "pre-specified-template-no-observations",
  );
});

test("manifest file lists are sorted, unique and content-addressed", async () => {
  const manifest = await buildReleaseManifest(root);

  for (const files of [
    manifest.application.files,
    manifest.model.files,
    manifest.dataPack.files,
    manifest.validationProtocol.fixedPoint.files,
    manifest.validationProtocol.routeWalkComparison.files,
  ]) {
    const paths = files.map((file) => file.path);
    assert.deepEqual(paths, [...paths].sort(comparePaths));
    assert.equal(new Set(paths).size, paths.length);
    for (const file of files) {
      assert.ok(file.bytes > 0, `${file.path} is empty`);
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
    }
  }

  for (const template of [
    manifest.validationProtocol.fixedPoint.observations,
    manifest.validationProtocol.routeWalkComparison.template,
  ]) {
    assert.ok(template.headerColumns > 1);
    assert.ok(template.headerBytes > 0);
    assert.match(template.headerSha256, /^[0-9a-f]{64}$/);
  }
});

test("release checks bind the planner, 3D map and route API to exact source bytes", async () => {
  const manifest = await buildReleaseManifest(root);
  const applicationFiles = new Map(
    manifest.application.files.map((file) => [file.path, file]),
  );

  for (const requiredPath of [
    "components/ShadeRouteApp.tsx",
    "components/RouteMap.tsx",
    "app/api/route/route.ts",
    "workers/scoring-worker.ts",
    "workers/shadow-worker.ts",
    "public/shade-route-sw.js",
    "public/app-icon-512.png",
    "ops/valhalla/compose.yml",
  ]) {
    const fingerprint = applicationFiles.get(requiredPath);
    assert.ok(fingerprint, `${requiredPath} is absent from the release source inventory`);
    const contents = await fs.readFile(path.join(root, requiredPath));
    assert.equal(fingerprint.bytes, contents.byteLength);
    assert.equal(
      fingerprint.sha256,
      createHash("sha256").update(contents).digest("hex"),
    );
  }

  for (const sourcePath of applicationFiles.keys()) {
    assert.doesNotMatch(
      sourcePath,
      /^(?:\.git|\.next|\.tmp|data|docs|node_modules|public\/data|tests|validation)\//,
    );
  }
});

test("release check rejects a changed executable source without blessing a dirty commit", async (t) => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "shaderoute-release-manifest-"));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));

  for (const directory of [
    ".openai",
    "app",
    "build",
    "lib",
    "ops",
    "validation",
    "worker",
    "workers",
  ]) {
    await fs.symlink(path.join(root, directory), path.join(sandbox, directory), "dir");
  }
  await fs.cp(path.join(root, "components"), path.join(sandbox, "components"), {
    recursive: true,
  });
  await fs.mkdir(path.join(sandbox, "public"));
  await fs.symlink(
    path.join(root, "public/data"),
    path.join(sandbox, "public/data"),
    "dir",
  );
  await fs.copyFile(
    path.join(root, "public/shade-route-sw.js"),
    path.join(sandbox, "public/shade-route-sw.js"),
  );

  for (const file of [
    ".nvmrc",
    "next.config.ts",
    "package-lock.json",
    "package.json",
    "postcss.config.mjs",
    "tsconfig.json",
    "vite.config.ts",
  ]) {
    const target = path.join(sandbox, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(path.join(root, file), target, "file");
  }

  await writeOrCheckReleaseManifest({ root: sandbox, check: false });
  await writeOrCheckReleaseManifest({ root: sandbox, check: true });
  await fs.appendFile(
    path.join(sandbox, "components/ShadeRouteApp.tsx"),
    "\n// release-manifest regression mutation\n",
  );

  await assert.rejects(
    writeOrCheckReleaseManifest({ root: sandbox, check: true }),
    /release-manifest\.json is stale/,
  );
});
