import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bufferRouteContextBbox,
  GLA_PUBLIC_REALM_TREE_BUFFER_METRES,
  GLA_PUBLIC_REALM_TREES_DATASET_URL,
  GLA_PUBLIC_REALM_TREES_RESOURCE_URL,
  parseRouteContextData,
} from "../lib/route-context.ts";
import {
  generatePublicTreeContexts,
  parsePublicTreeCsv,
  PUBLIC_TREE_CSV_HEADER,
} from "../scripts/prepare-public-trees.mjs";

const SOURCE_LAST_MODIFIED = "2025-12-01T14:12:23.000Z";

async function contextFixture(areaId) {
  return JSON.parse(await readFile(
    new URL(`../public/data/context-${areaId}.json`, import.meta.url),
    "utf8",
  ));
}

function csvRow(overrides = {}) {
  const values = {
    borough: "Lambeth",
    lat: "51.5000",
    lon: "-0.1100",
    uniqueid: "9000001",
    taxon_species: "Platanus × hispanica",
    common_name: "London plane",
    taxon_genus: "Platanus",
    common_genus: "Plane",
    gla_name: "London plane",
    taxon_family: "Platanaceae",
    maintainer: "LB Lambeth",
    location: "Highways",
    climate_suitability: "High",
    cs_confidence: "High",
    age_cat: "Not provided",
    canopy_m: "8 m",
    height_m: "10 m",
    girth_dbh: "40 cm",
    ...overrides,
  };
  return PUBLIC_TREE_CSV_HEADER.map((column) => {
    const value = values[column];
    return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join(",");
}

function csv(rows, header = PUBLIC_TREE_CSV_HEADER) {
  return `\uFEFF${header.join(",")}\r\n${rows.join("\r\n")}\r\n`;
}

async function generate(rows) {
  return generatePublicTreeContexts({
    readable: Readable.from([csv(rows)]),
    baseContexts: {
      waterloo: await contextFixture("waterloo"),
      "kings-cross": await contextFixture("kings-cross"),
    },
    lastModified: SOURCE_LAST_MODIFIED,
    minimumRows: 0,
    maximumRows: 100,
    maximumBytes: 100_000,
  });
}

test("official public-tree provenance and the data-selection buffer are explicit and bounded", () => {
  assert.equal(GLA_PUBLIC_REALM_TREE_BUFFER_METRES, 250);
  assert.equal(GLA_PUBLIC_REALM_TREES_DATASET_URL, "https://data.london.gov.uk/dataset/london-public-realm-trees-2r45m");
  assert.match(GLA_PUBLIC_REALM_TREES_RESOURCE_URL, /^https:\/\/data\.london\.gov\.uk\/download\/2r45m\//);
  const buffered = bufferRouteContextBbox([-0.13, 51.4915, -0.0975, 51.5095]);
  assert.ok(buffered[0] < -0.13 && buffered[1] < 51.4915);
  assert.ok(buffered[2] > -0.0975 && buffered[3] > 51.5095);
  assert.throws(() => bufferRouteContextBbox([-0.13, 51.49, -0.09, 51.51], 1_001), /1,000 metres/);
});

test("committed pilot extracts validate and contain only bounded Highways inventory points", async () => {
  const expectedCounts = { waterloo: 3_997, "kings-cross": 6_203 };
  for (const areaId of ["waterloo", "kings-cross"]) {
    const parsed = parseRouteContextData(await contextFixture(areaId));
    assert.ok(parsed);
    const bounds = bufferRouteContextBbox(parsed.bbox);
    const trees = parsed.features.filter((feature) => (
      "dataset" in feature.sourceRef && feature.sourceRef.dataset === "gla-public-realm-trees-2025"
    ));
    assert.equal(trees.length, expectedCounts[areaId]);
    assert.ok(trees.every((feature) => (
      feature.category === "tree" &&
      feature.subtype === "public-realm-street-tree" &&
      feature.id === `gla-public-tree-${feature.sourceRef.recordId}` &&
      feature.details?.treeInventoryLocation === "Highways" &&
      feature.coordinate[0] >= bounds[0] &&
      feature.coordinate[0] <= bounds[2] &&
      feature.coordinate[1] >= bounds[1] &&
      feature.coordinate[1] <= bounds[3]
    )));
    assert.ok(trees.every((feature) => !(
      "canopyMetres" in (feature.details ?? {}) || "shade" in (feature.details ?? {})
    )));
  }
});

test("streaming CSV parser handles quoted fields and rejects schema drift", async () => {
  const seen = [];
  const content = csv([csvRow({ gla_name: "Plane, London", maintainer: "GLA \"Trees\"" })]);
  const metadata = await parsePublicTreeCsv(Readable.from([content]), (row) => seen.push(row), {
    minimumRows: 1,
    maximumRows: 2,
    maximumBytes: 10_000,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][PUBLIC_TREE_CSV_HEADER.indexOf("gla_name")], "Plane, London");
  assert.equal(seen[0][PUBLIC_TREE_CSV_HEADER.indexOf("maintainer")], 'GLA "Trees"');
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);

  const changedHeader = [...PUBLIC_TREE_CSV_HEADER];
  changedHeader[3] = "tree_id";
  await assert.rejects(
    parsePublicTreeCsv(Readable.from([csv([csvRow()], changedHeader)]), () => {}, {
      minimumRows: 0,
      maximumRows: 2,
      maximumBytes: 10_000,
    }),
    /header does not match/i,
  );
});

test("generator keeps only Highways points in pilot bounds plus the 250 metre buffer", async () => {
  const waterloo = await contextFixture("waterloo");
  const buffered = bufferRouteContextBbox(waterloo.bbox);
  const insideBufferOutsidePilot = (waterloo.bbox[0] + buffered[0]) / 2;
  const outsideBuffer = buffered[0] - 0.0001;
  const generated = await generate([
    csvRow({ uniqueid: "9000001", lon: String(insideBufferOutsidePilot), lat: "51.5000" }),
    csvRow({ uniqueid: "9000002", lon: String(outsideBuffer), lat: "51.5000" }),
    csvRow({ uniqueid: "9000003", lon: "-0.1100", lat: "51.5000", location: "Parks" }),
    csvRow({ uniqueid: "9000004", lon: "-0.1260", lat: "51.5280", borough: "Camden" }),
  ]);
  assert.equal(generated.outputs.waterloo.treeCount, 1);
  assert.equal(generated.outputs["kings-cross"].treeCount, 1);
  const waterlooTree = generated.outputs.waterloo.data.features.find((feature) => (
    "dataset" in feature.sourceRef && feature.sourceRef.dataset === "gla-public-realm-trees-2025"
  ));
  assert.equal(waterlooTree.sourceRef.recordId, 9000001);
  assert.equal(waterlooTree.details.treeInventoryLocation, "Highways");
  assert.equal(waterlooTree.details.treeSpecies, "London plane");
});

test("generation is byte-stable, preserves prior records and binds exact source provenance", async () => {
  const rows = [
    csvRow({ uniqueid: "9000004", lon: "-0.1260", lat: "51.5280", borough: "Camden" }),
    csvRow({ uniqueid: "9000001", lon: "-0.1100", lat: "51.5000" }),
  ];
  const first = await generate(rows);
  const second = await generate(rows);
  assert.equal(first.outputs.waterloo.json, second.outputs.waterloo.json);
  assert.equal(first.outputs["kings-cross"].json, second.outputs["kings-cross"].json);
  for (const areaId of ["waterloo", "kings-cross"]) {
    const original = await contextFixture(areaId);
    const originalNonGeneratedIds = original.features
      .filter((feature) => !("dataset" in feature.sourceRef && feature.sourceRef.dataset === "gla-public-realm-trees-2025"))
      .map((feature) => feature.id);
    const generatedNonTreeIds = first.outputs[areaId].data.features
      .filter((feature) => !("dataset" in feature.sourceRef && feature.sourceRef.dataset === "gla-public-realm-trees-2025"))
      .map((feature) => feature.id);
    assert.deepEqual(generatedNonTreeIds, originalNonGeneratedIds);
    const source = first.outputs[areaId].data.additionalSources.find((item) => (
      item.url === GLA_PUBLIC_REALM_TREES_DATASET_URL
    ));
    assert.equal(source.licence, "Open Government Licence v3");
    assert.equal(source.resourceUrl, GLA_PUBLIC_REALM_TREES_RESOURCE_URL);
    assert.equal(source.snapshotAt, SOURCE_LAST_MODIFIED);
    assert.equal(source.sha256, first.source.sha256);
    assert.match(source.method, /inventory points, not field-verified current trees, canopy extents or shade polygons/i);
    assert.ok(parseRouteContextData(first.outputs[areaId].data));
  }
});

test("duplicate selected IDs and malformed coordinates fail before generation", async () => {
  await assert.rejects(
    generate([
      csvRow({ uniqueid: "9000001", lon: "-0.1100", lat: "51.5000" }),
      csvRow({ uniqueid: "9000001", lon: "-0.1110", lat: "51.5010" }),
      csvRow({ uniqueid: "9000004", lon: "-0.1260", lat: "51.5280", borough: "Camden" }),
    ]),
    /duplicate public-tree uniqueid/i,
  );
  await assert.rejects(
    generate([csvRow({ lat: "not-a-number" })]),
    /invalid latitude/i,
  );
});

test("update mode leaves existing files untouched when the upstream schema is invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shaderoute-public-trees-"));
  await cp(new URL("../public/data/context-waterloo.json", import.meta.url), join(directory, "context-waterloo.json"));
  await cp(new URL("../public/data/context-kings-cross.json", import.meta.url), join(directory, "context-kings-cross.json"));
  const before = await readFile(join(directory, "context-waterloo.json"), "utf8");
  const input = join(directory, "bad.csv");
  await writeFile(input, "unexpected,columns\n1,2\n", "utf8");
  const script = fileURLToPath(new URL("../scripts/prepare-public-trees.mjs", import.meta.url));
  const exitCode = await new Promise((resolveExit) => {
    const child = spawn(process.execPath, [
      script,
      "--update",
      "--input",
      input,
      "--source-last-modified",
      SOURCE_LAST_MODIFIED,
      "--context-dir",
      directory,
      "--output-dir",
      directory,
    ], { stdio: "ignore" });
    child.once("exit", resolveExit);
  });
  assert.notEqual(exitCode, 0);
  assert.equal(await readFile(join(directory, "context-waterloo.json"), "utf8"), before);
});
