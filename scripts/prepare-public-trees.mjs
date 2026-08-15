#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  bufferRouteContextBbox,
  GLA_PUBLIC_REALM_TREE_BUFFER_METRES,
  GLA_PUBLIC_REALM_TREES_DATASET_URL,
  GLA_PUBLIC_REALM_TREES_RESOURCE_URL,
  parseRouteContextData,
} from "../lib/route-context.ts";

export const PUBLIC_TREE_CSV_HEADER = [
  "borough",
  "lat",
  "lon",
  "uniqueid",
  "taxon_species",
  "common_name",
  "taxon_genus",
  "common_genus",
  "gla_name",
  "taxon_family",
  "maintainer",
  "location",
  "climate_suitability",
  "cs_confidence",
  "age_cat",
  "canopy_m",
  "height_m",
  "girth_dbh",
];

const AREA_IDS = ["waterloo", "kings-cross"];
const MAX_SOURCE_BYTES = 230_000_000;
const MIN_SOURCE_ROWS = 1_000_000;
const MAX_SOURCE_ROWS = 1_250_000;
const MAX_FIELD_CHARACTERS = 2_000;
const MAX_TREES_PER_AREA = 20_000;
const MAX_OUTPUT_BYTES_PER_AREA = 15_000_000;
const TREE_LOCATION_TYPES = new Set(["Highways", "Housing", "Other", "Outside London", "Parks"]);
const TREE_SOURCE_METHOD =
  `Build-time extract of records classified Highways in the source inventory, clipped to each ` +
  `pilot bounding box plus a ${GLA_PUBLIC_REALM_TREE_BUFFER_METRES} metre buffer. ` +
  "Records are inventory points, not field-verified current trees, canopy extents or shade polygons.";

function fail(message) {
  throw new Error(message);
}

function boundedText(value, maximumLength = 160) {
  if (
    typeof value !== "string" ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    })
  ) {
    fail("The source contains invalid control characters.");
  }
  const normalised = value.trim().replace(/\s+/g, " ");
  if (normalised.length > maximumLength) fail("A source text field exceeds its permitted length.");
  return normalised;
}

function validIsoDateTime(value) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? parsed.toISOString()
    : null;
}

function insideBbox(longitude, latitude, [west, south, east, north]) {
  return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
}

function publicTreeFeature(row, columns) {
  const recordIdText = row[columns.uniqueid];
  if (!/^[1-9]\d*$/.test(recordIdText)) fail(`Invalid public-tree uniqueid: ${recordIdText || "(empty)"}.`);
  const recordId = Number(recordIdText);
  if (!Number.isSafeInteger(recordId)) fail(`Public-tree uniqueid is outside the safe integer range: ${recordIdText}.`);

  const latitude = Number(row[columns.lat]);
  const longitude = Number(row[columns.lon]);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    fail(`Invalid latitude for public-tree record ${recordId}.`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    fail(`Invalid longitude for public-tree record ${recordId}.`);
  }

  const candidates = [
    row[columns.gla_name],
    row[columns.common_name],
    row[columns.common_genus],
    row[columns.taxon_species],
  ].map((value) => boundedText(value)).filter((value) => (
    value && !/^(?:not provided|unknown|n\/a)$/i.test(value)
  ));
  const treeSpecies = candidates[0];
  const treeMaintainer = boundedText(row[columns.maintainer]);
  const details = {
    ...(treeSpecies ? { treeSpecies } : {}),
    ...(treeMaintainer && !/^(?:not provided|unknown|n\/a)$/i.test(treeMaintainer)
      ? { treeMaintainer }
      : {}),
    treeInventoryLocation: "Highways",
  };
  return {
    id: `gla-public-tree-${recordId}`,
    category: "tree",
    subtype: "public-realm-street-tree",
    name: treeSpecies ? `GLA street-tree point - ${treeSpecies}` : "GLA street-tree inventory point",
    coordinate: [longitude, latitude],
    sourceRef: {
      dataset: "gla-public-realm-trees-2025",
      recordId,
      url: GLA_PUBLIC_REALM_TREES_DATASET_URL,
    },
    details,
  };
}

/**
 * Parses RFC 4180-style CSV incrementally, including quoted commas/newlines and
 * escaped quotes. Byte, row, field and column limits make malformed downloads
 * fail before any output can be written.
 */
export async function parsePublicTreeCsv(readable, onRecord, options = {}) {
  const maximumBytes = options.maximumBytes ?? MAX_SOURCE_BYTES;
  const minimumRows = options.minimumRows ?? MIN_SOURCE_ROWS;
  const maximumRows = options.maximumRows ?? MAX_SOURCE_ROWS;
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let rowCount = 0;
  let field = "";
  let row = [];
  let inQuotes = false;
  let afterQuote = false;
  let skipLineFeed = false;
  let header = null;

  const append = (character) => {
    field += character;
    if (field.length > MAX_FIELD_CHARACTERS) fail("A CSV field exceeds the bounded character limit.");
  };
  const finishField = () => {
    row.push(field);
    if (row.length > PUBLIC_TREE_CSV_HEADER.length) fail("A CSV row has too many columns.");
    field = "";
    afterQuote = false;
  };
  const finishRow = () => {
    finishField();
    if (row.length !== PUBLIC_TREE_CSV_HEADER.length) {
      fail(`CSV row ${rowCount + 1} has ${row.length} columns; expected ${PUBLIC_TREE_CSV_HEADER.length}.`);
    }
    if (!header) {
      row[0] = row[0].replace(/^\uFEFF/, "");
      if (row.some((value, index) => value !== PUBLIC_TREE_CSV_HEADER[index])) {
        fail("The public-tree CSV header does not match the expected November 2025 schema.");
      }
      header = [...row];
    } else {
      rowCount += 1;
      if (rowCount > maximumRows) fail(`The public-tree source exceeds ${maximumRows} data rows.`);
      onRecord(row, rowCount);
    }
    row = [];
  };

  const consume = (text) => {
    for (const character of text) {
      if (skipLineFeed) {
        skipLineFeed = false;
        if (character === "\n") continue;
      }
      if (inQuotes) {
        if (character === '"') {
          inQuotes = false;
          afterQuote = true;
        } else {
          append(character);
        }
        continue;
      }
      if (afterQuote) {
        if (character === '"') {
          append('"');
          inQuotes = true;
          afterQuote = false;
        } else if (character === ",") {
          finishField();
        } else if (character === "\n" || character === "\r") {
          finishRow();
          if (character === "\r") skipLineFeed = true;
        } else {
          fail("Unexpected characters follow a quoted CSV field.");
        }
        continue;
      }
      if (character === '"') {
        if (field.length) fail("A quote appears inside an unquoted CSV field.");
        inQuotes = true;
      } else if (character === ",") {
        finishField();
      } else if (character === "\n" || character === "\r") {
        finishRow();
        if (character === "\r") skipLineFeed = true;
      } else {
        append(character);
      }
    }
  };

  for await (const value of readable) {
    const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) fail(`The public-tree source exceeds ${maximumBytes} bytes.`);
    hash.update(chunk);
    consume(decoder.decode(chunk, { stream: true }));
  }
  consume(decoder.decode());
  if (inQuotes) fail("The public-tree CSV ends inside a quoted field.");
  if (field.length || row.length || afterQuote) finishRow();
  if (!header) fail("The public-tree CSV is empty.");
  if (rowCount < minimumRows) fail(`The public-tree source has only ${rowCount} rows; expected at least ${minimumRows}.`);

  return { byteLength: bytes, rowCount, sha256: hash.digest("hex") };
}

function withoutGeneratedPublicTrees(context) {
  return {
    ...context,
    additionalSources: (context.additionalSources ?? []).filter((source) => (
      source.url !== GLA_PUBLIC_REALM_TREES_DATASET_URL
    )),
    features: context.features.filter((feature) => !(
      "dataset" in feature.sourceRef &&
      feature.sourceRef.dataset === "gla-public-realm-trees-2025"
    )),
  };
}

function treeSource(sourceMetadata) {
  return {
    label: "Greater London Authority Public Realm Trees, November 2025",
    url: GLA_PUBLIC_REALM_TREES_DATASET_URL,
    licence: "Open Government Licence v3",
    snapshotAt: sourceMetadata.lastModified,
    method: TREE_SOURCE_METHOD,
    resourceUrl: GLA_PUBLIC_REALM_TREES_RESOURCE_URL,
    sha256: sourceMetadata.sha256,
  };
}

function generatedContext(context, trees, sourceMetadata) {
  const base = withoutGeneratedPublicTrees(context);
  return {
    schemaVersion: 1,
    areaId: base.areaId,
    bbox: base.bbox,
    source: base.source,
    additionalSources: [...(base.additionalSources ?? []), treeSource(sourceMetadata)],
    completeness: {
      ...base.completeness,
      tree: {
        status: "partial",
        note:
          `Includes GLA November 2025 inventory points classified as Highways within the pilot ` +
          `bounding box plus a ${GLA_PUBLIC_REALM_TREE_BUFFER_METRES} metre data-selection buffer, ` +
          "alongside the existing named OpenStreetMap tree points. The GLA inventory can be dated or incomplete; a point does not establish a current tree, canopy extent or usable shade.",
      },
    },
    features: [...base.features, ...trees],
  };
}

export async function generatePublicTreeContexts({
  readable,
  baseContexts,
  lastModified,
  minimumRows = MIN_SOURCE_ROWS,
  maximumRows = MAX_SOURCE_ROWS,
  maximumBytes = MAX_SOURCE_BYTES,
  expectedByteLength,
}) {
  const normalisedLastModified = validIsoDateTime(lastModified);
  if (!normalisedLastModified) fail("A valid source Last-Modified date is required for provenance.");
  const parsedContexts = Object.fromEntries(AREA_IDS.map((areaId) => {
    const parsed = parseRouteContextData(baseContexts[areaId]);
    if (!parsed || parsed.areaId !== areaId) fail(`Existing ${areaId} route context is invalid.`);
    return [areaId, parsed];
  }));
  const bufferedBounds = Object.fromEntries(AREA_IDS.map((areaId) => (
    [areaId, bufferRouteContextBbox(parsedContexts[areaId].bbox)]
  )));
  const trees = { waterloo: [], "kings-cross": [] };
  const columns = Object.fromEntries(PUBLIC_TREE_CSV_HEADER.map((name, index) => [name, index]));
  const selectedRecordIds = { waterloo: new Set(), "kings-cross": new Set() };

  const sourceMetadata = await parsePublicTreeCsv(readable, (row) => {
    const location = boundedText(row[columns.location], 80);
    if (!TREE_LOCATION_TYPES.has(location)) fail(`Unexpected public-tree location type: ${location || "(empty)"}.`);
    const recordId = row[columns.uniqueid];
    if (!/^[1-9]\d*$/.test(recordId) || !Number.isSafeInteger(Number(recordId))) {
      fail(`Invalid public-tree uniqueid: ${recordId || "(empty)"}.`);
    }
    const latitude = Number(row[columns.lat]);
    const longitude = Number(row[columns.lon]);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      fail(`Invalid latitude for public-tree record ${recordId}.`);
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      fail(`Invalid longitude for public-tree record ${recordId}.`);
    }
    if (location !== "Highways") return;
    const feature = publicTreeFeature(row, columns);
    for (const areaId of AREA_IDS) {
      if (!insideBbox(feature.coordinate[0], feature.coordinate[1], bufferedBounds[areaId])) continue;
      if (selectedRecordIds[areaId].has(feature.sourceRef.recordId)) {
        fail(`Duplicate public-tree uniqueid ${feature.sourceRef.recordId} in the ${areaId} extract.`);
      }
      selectedRecordIds[areaId].add(feature.sourceRef.recordId);
      trees[areaId].push(feature);
      if (trees[areaId].length > MAX_TREES_PER_AREA) {
        fail(`The ${areaId} public-tree extract exceeds ${MAX_TREES_PER_AREA} records.`);
      }
    }
  }, { minimumRows, maximumRows, maximumBytes });
  if (expectedByteLength !== undefined && sourceMetadata.byteLength !== expectedByteLength) {
    fail(
      `The public-tree source ended at ${sourceMetadata.byteLength} bytes; ` +
      `the server or file declared ${expectedByteLength}.`,
    );
  }

  const outputs = {};
  for (const areaId of AREA_IDS) {
    trees[areaId].sort((left, right) => left.sourceRef.recordId - right.sourceRef.recordId);
    const output = generatedContext(parsedContexts[areaId], trees[areaId], {
      ...sourceMetadata,
      lastModified: normalisedLastModified,
    });
    if (!parseRouteContextData(output)) fail(`Generated ${areaId} route context failed strict validation.`);
    // Generated pilot packs are runtime artefacts. Compact JSON avoids several
    // megabytes of indentation while remaining deterministic and inspectable.
    const json = `${JSON.stringify(output)}\n`;
    if (Buffer.byteLength(json) > MAX_OUTPUT_BYTES_PER_AREA) {
      fail(`Generated ${areaId} route context exceeds ${MAX_OUTPUT_BYTES_PER_AREA} bytes.`);
    }
    outputs[areaId] = { data: output, json, treeCount: trees[areaId].length };
  }
  return { outputs, source: { ...sourceMetadata, lastModified: normalisedLastModified } };
}

async function localSource(path, lastModified) {
  const details = await stat(path);
  if (!details.isFile()) fail("The requested public-tree input is not a file.");
  if (details.size <= 0 || details.size > MAX_SOURCE_BYTES) {
    fail(`The public-tree input must be between 1 and ${MAX_SOURCE_BYTES} bytes.`);
  }
  const normalisedLastModified = validIsoDateTime(lastModified);
  if (!normalisedLastModified) fail("--input requires --source-last-modified for reproducible provenance.");
  return {
    readable: createReadStream(path),
    lastModified: normalisedLastModified,
    expectedByteLength: details.size,
  };
}

async function officialSource() {
  const response = await fetch(GLA_PUBLIC_REALM_TREES_RESOURCE_URL, {
    headers: { Accept: "text/csv" },
    redirect: "follow",
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok || !response.body) fail(`Official GLA tree download failed with HTTP ${response.status}.`);
  const finalUrl = new URL(response.url);
  if (
    finalUrl.protocol !== "https:" ||
    finalUrl.hostname !== "data.london.gov.uk" ||
    finalUrl.pathname !== new URL(GLA_PUBLIC_REALM_TREES_RESOURCE_URL).pathname
  ) fail("The official GLA tree download redirected to an unexpected location.");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "text/csv" && contentType !== "text/plain" && contentType !== "application/octet-stream") {
    fail(`The official GLA tree download returned unexpected content type ${contentType ?? "(missing)"}.`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_SOURCE_BYTES) {
    fail("The official GLA tree download has an invalid or excessive Content-Length.");
  }
  const lastModified = validIsoDateTime(response.headers.get("last-modified"));
  if (!lastModified) fail("The official GLA tree download has no valid Last-Modified provenance.");
  return { readable: Readable.fromWeb(response.body), lastModified, expectedByteLength: contentLength };
}

function parseArguments(argumentsList) {
  const result = { mode: null, input: null, sourceLastModified: null, contextDir: null, outputDir: null };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index];
    if (value === "--check" || value === "--update") {
      if (result.mode) fail("Choose exactly one of --check or --update.");
      result.mode = value.slice(2);
    } else if (["--input", "--source-last-modified", "--context-dir", "--output-dir"].includes(value)) {
      const next = argumentsList[index + 1];
      if (!next || next.startsWith("--")) fail(`${value} requires a value.`);
      index += 1;
      if (value === "--input") result.input = resolve(next);
      else if (value === "--source-last-modified") result.sourceLastModified = next;
      else if (value === "--context-dir") result.contextDir = resolve(next);
      else result.outputDir = resolve(next);
    } else {
      fail(`Unknown argument: ${value}.`);
    }
  }
  if (!result.mode) fail("Choose exactly one of --check or --update.");
  if (result.sourceLastModified && !result.input) {
    fail("--source-last-modified is only valid with --input.");
  }
  return result;
}

async function atomicWriteOutputs(changes) {
  const temporaryPaths = [];
  const originals = new Map();
  const replaced = [];
  try {
    for (const change of changes) {
      originals.set(change.path, await readFile(change.path));
      const temporaryPath = `${change.path}.public-trees-${process.pid}.tmp`;
      temporaryPaths.push(temporaryPath);
      await writeFile(temporaryPath, change.json, { encoding: "utf8", flag: "wx" });
    }
    for (let index = 0; index < changes.length; index += 1) {
      await rename(temporaryPaths[index], changes[index].path);
      replaced.push(changes[index].path);
    }
  } catch (error) {
    for (const path of replaced) {
      const original = originals.get(path);
      if (original) await writeFile(path, original);
    }
    throw error;
  } finally {
    await Promise.all(temporaryPaths.map((path) => unlink(path).catch(() => undefined)));
  }
}

export async function runPublicTreeCli(argumentsList = process.argv.slice(2)) {
  const args = parseArguments(argumentsList);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const contextDir = args.contextDir ?? join(projectRoot, "public", "data");
  const outputDir = args.outputDir ?? contextDir;
  const baseContexts = {};
  for (const areaId of AREA_IDS) {
    baseContexts[areaId] = JSON.parse(await readFile(join(contextDir, `context-${areaId}.json`), "utf8"));
  }
  const source = args.input
    ? await localSource(args.input, args.sourceLastModified)
    : await officialSource();
  const generated = await generatePublicTreeContexts({
    readable: source.readable,
    baseContexts,
    lastModified: source.lastModified,
    expectedByteLength: source.expectedByteLength,
  });
  const changes = [];
  for (const areaId of AREA_IDS) {
    const path = join(outputDir, `context-${areaId}.json`);
    const current = await readFile(path, "utf8").catch(() => null);
    if (current !== generated.outputs[areaId].json) {
      changes.push({ areaId, path, json: generated.outputs[areaId].json });
    }
  }
  const summary = AREA_IDS.map((areaId) => (
    `${areaId}: ${generated.outputs[areaId].treeCount} Highways tree points`
  )).join("; ");
  if (args.mode === "check") {
    if (changes.length) fail(`Generated public-tree contexts differ (${summary}). Run with --update after reviewing the source.`);
    process.stdout.write(`Public-tree contexts are current (${summary}; source SHA-256 ${generated.source.sha256}).\n`);
    return generated;
  }
  if (changes.length) await atomicWriteOutputs(changes);
  process.stdout.write(
    `${changes.length ? `Updated ${changes.length} context files` : "No context files changed"} ` +
    `(${summary}; source SHA-256 ${generated.source.sha256}).\n`,
  );
  return generated;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runPublicTreeCli().catch((error) => {
    process.stderr.write(`Public-tree refresh failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
