import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PILOT_DATA_VERSION,
  SHADE_MODEL_VERSION,
} from "../lib/release-identity.ts";

export const RELEASE_MANIFEST_FILE = "release-manifest.json";
export const RELEASE_MANIFEST_SCHEMA_VERSION = 2;
export const MODEL_VERSION = SHADE_MODEL_VERSION;

const MODEL_BASIS = "absolute-elevation-clear-sky";
const PINNED_NODE_VERSION = "24.14.0";
const PINNED_NPM_VERSION = "11.9.0";
const DATA_DIRECTORY = "public/data";
const PUBLIC_DIRECTORY = "public";
const PACKAGE_LOCK_FILE = "package-lock.json";
const PILOT_ROUTES_FILE = `${DATA_DIRECTORY}/pilot-routes.json`;
const APPLICATION_SOURCE_DIRECTORIES = [
  "app",
  "build",
  "components",
  "lib",
  "worker",
  "workers",
];
const APPLICATION_SOURCE_ROOT_FILES = [
  ".openai/hosting.json",
  "next.config.ts",
  "ops/valhalla/compose.yml",
  "package.json",
  "postcss.config.mjs",
  "tsconfig.json",
  "vite.config.ts",
];
const MODEL_SOURCE_FILES = [
  "lib/departure-advice.ts",
  "lib/london-time.ts",
  "lib/raster-shade.ts",
  "lib/shade-profile.ts",
  "lib/shade.ts",
  "lib/shadow-raster.ts",
  "lib/walking-pace.ts",
  "workers/scoring-worker.ts",
  "workers/shadow-worker.ts",
];
const FIXED_POINT_VALIDATION_FILES = [
  "lib/field-calibration.ts",
  "lib/fixed-point-analysis.ts",
  "validation/fixed-point-thresholds.json",
];
const ROUTE_WALK_VALIDATION_FILES = [
  "lib/route-walk-validation.ts",
];
const FIXED_POINT_OBSERVATIONS_FILE = "validation/observations.csv";
const ROUTE_WALK_TEMPLATE_FILE = "validation/route-walks.csv";

function fail(message) {
  throw new Error(`Release manifest: ${message}`);
}

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normaliseRelativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

async function regularFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => comparePaths(left.name, right.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await regularFiles(target));
    } else if (entry.isFile()) {
      files.push(target);
    } else {
      fail(`unsupported filesystem entry ${target}`);
    }
  }

  return files;
}

async function deployedPublicPaths(root) {
  const publicRoot = path.join(root, PUBLIC_DIRECTORY);
  const entries = await fs.readdir(publicRoot, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => comparePaths(left.name, right.name))) {
    if (entry.name === "data") continue;
    const target = path.join(publicRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...await regularFiles(target));
    } else if (entry.isFile()) {
      files.push(target);
    } else {
      fail(`unsupported filesystem entry ${target}`);
    }
  }

  return files.map((file) => normaliseRelativePath(root, file));
}

async function applicationFilePaths(root) {
  const directoryFiles = await Promise.all(
    APPLICATION_SOURCE_DIRECTORIES.map(async (directory) =>
      (await regularFiles(path.join(root, directory)))
        .map((file) => normaliseRelativePath(root, file))),
  );
  const publicFiles = await deployedPublicPaths(root);
  return [...new Set([
    ...APPLICATION_SOURCE_ROOT_FILES,
    ...directoryFiles.flat(),
    ...publicFiles,
  ])]
    .sort(comparePaths);
}

async function fingerprint(root, relativePath) {
  const contents = await fs.readFile(path.join(root, relativePath));
  return {
    path: relativePath,
    bytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function csvTemplateFingerprint(root, relativePath) {
  const contents = await fs.readFile(path.join(root, relativePath), "utf8");
  const lines = contents.replaceAll("\r\n", "\n").split("\n");
  const header = lines.shift();
  if (!header) fail(`${relativePath} has no CSV header`);
  return {
    path: relativePath,
    headerColumns: header.split(",").length,
    headerBytes: Buffer.byteLength(header, "utf8"),
    headerSha256: createHash("sha256").update(header, "utf8").digest("hex"),
    evidenceRows: lines.filter((line) => line.trim().length > 0).length,
  };
}

async function readJson(root, relativePath) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    fail(`could not read valid JSON from ${relativePath}: ${error.message}`);
  }
}

function sortedUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
    fail(`${label} must contain non-empty strings`);
  }
  const sorted = [...new Set(values)].sort(comparePaths);
  if (sorted.length !== values.length) fail(`${label} contains duplicate values`);
  return sorted;
}

export async function buildReleaseManifest(root) {
  const packageJson = await readJson(root, "package.json");
  const routes = await readJson(root, PILOT_ROUTES_FILE);
  const fixedPointThresholds = await readJson(root, "validation/fixed-point-thresholds.json");
  const nvmVersion = (await fs.readFile(path.join(root, ".nvmrc"), "utf8")).trim();

  if (packageJson.version !== "0.1.0") fail("package version must remain 0.1.0 for this baseline");
  if (packageJson.private !== true) fail("the pilot package must remain private to npm");
  if (packageJson.license !== "UNLICENSED") {
    fail("package licence metadata must remain UNLICENSED until the owner records a licence decision");
  }
  if (packageJson.packageManager !== `npm@${PINNED_NPM_VERSION}`) {
    fail(`packageManager must be npm@${PINNED_NPM_VERSION}`);
  }
  if (packageJson.engines?.node !== PINNED_NODE_VERSION || packageJson.engines?.npm !== PINNED_NPM_VERSION) {
    fail("package engines do not match the pinned Node.js and npm versions");
  }
  if (nvmVersion !== PINNED_NODE_VERSION) fail(".nvmrc does not match the release runtime");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(routes.generated)) {
    fail(`${PILOT_ROUTES_FILE} does not contain a stable YYYY-MM-DD generated date`);
  }
  if (
    fixedPointThresholds.model_version !== SHADE_MODEL_VERSION ||
    fixedPointThresholds.data_pack_version !== PILOT_DATA_VERSION
  ) {
    fail("fixed-point thresholds do not match the canonical model and data identifiers");
  }

  const areaIds = sortedUniqueStrings(
    routes.areas?.map((area) => area?.id),
    `${PILOT_ROUTES_FILE} area IDs`,
  );
  if (areaIds.length === 0) fail("the pilot route pack contains no areas");

  const dataPaths = (await regularFiles(path.join(root, DATA_DIRECTORY)))
    .map((file) => normaliseRelativePath(root, file))
    .sort(comparePaths);
  const applicationPaths = await applicationFilePaths(root);

  const [
    lockfile,
    applicationFiles,
    modelFiles,
    dataFiles,
    fixedPointFiles,
    fixedPointObservations,
    routeWalkFiles,
    routeWalkTemplate,
  ] = await Promise.all([
    fingerprint(root, PACKAGE_LOCK_FILE),
    Promise.all(applicationPaths.map((file) => fingerprint(root, file))),
    Promise.all(MODEL_SOURCE_FILES.map((file) => fingerprint(root, file))),
    Promise.all(dataPaths.map((file) => fingerprint(root, file))),
    Promise.all(FIXED_POINT_VALIDATION_FILES.map((file) => fingerprint(root, file))),
    csvTemplateFingerprint(root, FIXED_POINT_OBSERVATIONS_FILE),
    Promise.all(ROUTE_WALK_VALIDATION_FILES.map((file) => fingerprint(root, file))),
    csvTemplateFingerprint(root, ROUTE_WALK_TEMPLATE_FILE),
  ]);

  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    release: {
      name: "ShadeRoute",
      version: packageJson.version,
      channel: "pre-release",
      runtime: {
        node: PINNED_NODE_VERSION,
        npm: PINNED_NPM_VERSION,
      },
      dependencyLock: lockfile,
    },
    application: {
      inventoryVersion: 1,
      files: applicationFiles,
    },
    model: {
      name: "ShadeRoute absolute-elevation clear-sky model",
      version: MODEL_VERSION,
      basis: MODEL_BASIS,
      files: modelFiles,
    },
    dataPack: {
      version: PILOT_DATA_VERSION,
      generated: routes.generated,
      areas: areaIds,
      files: dataFiles,
    },
    validationProtocol: {
      fixedPoint: {
        protocolVersion: fixedPointThresholds.protocol_version,
        registrationStatus: fixedPointThresholds.registration_status,
        observations: fixedPointObservations,
        files: fixedPointFiles,
      },
      routeWalkComparison: {
        template: routeWalkTemplate,
        files: routeWalkFiles,
      },
    },
  };
}

export function serialiseReleaseManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function writeOrCheckReleaseManifest({ root, check }) {
  const expected = serialiseReleaseManifest(await buildReleaseManifest(root));
  const target = path.join(root, RELEASE_MANIFEST_FILE);

  if (check) {
    let actual;
    try {
      actual = await fs.readFile(target, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") fail(`${RELEASE_MANIFEST_FILE} is missing; run npm run release:manifest`);
      throw error;
    }
    if (actual !== expected) {
      fail(`${RELEASE_MANIFEST_FILE} is stale; run npm run release:manifest and review the changes`);
    }
    return { changed: false, target };
  }

  let actual = null;
  try {
    actual = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (actual !== expected) await fs.writeFile(target, expected, "utf8");
  return { changed: actual !== expected, target };
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const unknown = argumentsList.filter((argument) => argument !== "--check");
  if (unknown.length > 0) fail(`unknown argument ${unknown[0]}`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const check = argumentsList.includes("--check");
  const result = await writeOrCheckReleaseManifest({ root, check });
  const verb = check ? "verified" : result.changed ? "updated" : "already current";
  process.stdout.write(`Release manifest ${verb}: ${normaliseRelativePath(root, result.target)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
