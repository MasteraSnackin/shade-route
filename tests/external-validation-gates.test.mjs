import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedColumns = [
  "schema",
  "schema_version",
  "evidence_id",
  "gate_id",
  "build_commit",
  "device_model",
  "os_version",
  "browser_version",
  "network_state",
  "storage_state",
  "assistive_technology",
  "participant_group",
  "task_id",
  "outcome",
  "measurement_value",
  "measurement_unit",
  "evidence_reference",
  "recorded_utc",
  "notes",
];

test("external field-readiness evidence is explicitly pending and never fabricated", async () => {
  const [register, protocol, validationReadme] = await Promise.all([
    readFile(new URL("../validation/device-and-user-evidence.csv", import.meta.url), "utf8"),
    readFile(new URL("../validation/EXTERNAL-GATES.md", import.meta.url), "utf8"),
    readFile(new URL("../validation/README.md", import.meta.url), "utf8"),
  ]);

  assert.equal(register, `${expectedColumns.join(",")}\n`);
  assert.match(protocol, /currently pending/i);
  assert.match(protocol, /cannot be completed by unit tests, browser emulation or synthetic\s+records/i);
  for (const gate of [
    "ios-offline-reload",
    "android-offline-reload",
    "storage-eviction",
    "service-worker-update",
    "field-runtime",
    "voiceover-critical-path",
    "talkback-critical-path",
    "magnification-reflow",
    "heat-vulnerable-walkthrough",
    "frontline-worker-walkthrough",
  ]) assert.match(protocol, new RegExp(`\\b${gate}\\b`));
  assert.match(protocol, /battery falls by no more than 10 percentage points/i);
  assert.match(protocol, /no critical or serious issue remains open/i);
  assert.match(protocol, /never omit a failed run/i);
  assert.match(validationReadme, /none of those\s+external checks has been completed/i);
  assert.match(validationReadme, /cannot\s+pass these gates/i);
});
