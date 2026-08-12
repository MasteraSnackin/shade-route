import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DECISION_EVIDENCE_LIMITATIONS,
  DECISION_EVIDENCE_MAX_BYTES,
  createDecisionEvidence,
  decisionEvidenceFilename,
  parseDecisionEvidence,
  serialiseDecisionEvidence,
} from "../lib/decision-evidence.ts";

function journeyScore(directSun, range, shade, coverage, confidenceReasons = []) {
  return {
    routeId: "waterloo-2",
    distanceMetres: 1_200,
    durationSeconds: 900,
    estimatedDirectSunSeconds: directSun,
    directSunRangeSeconds: range,
    estimatedShadePercent: shade,
    daylightSeconds: 900,
    modelledDaylightSeconds: Math.round(900 * coverage / 100),
    unknownDaylightSeconds: 900 - Math.round(900 * coverage / 100),
    isDaylight: true,
    lowSunConfidence: false,
    limitedConfidence: confidenceReasons.length > 0,
    confidenceReasons,
    coveragePercent: coverage,
    sections: [],
  };
}

function scheduledJourneys() {
  const firstDeparture = Date.parse("2026-08-12T13:30:00.000Z");
  return [
    {
      index: 0,
      departureEpochMs: firstDeparture,
      arrivalEpochMs: firstDeparture + 900_000,
      score: journeyScore(180, [120, 240], 70, 95),
    },
    {
      index: 1,
      departureEpochMs: firstDeparture + 7_200_000,
      arrivalEpochMs: firstDeparture + 8_100_000,
      score: journeyScore(240, [180, 300], 55, 85, [
        "near-clearance-threshold",
        "incomplete-height-coverage",
      ]),
    },
  ];
}

function score(overrides = {}) {
  return {
    routeId: "waterloo-2",
    distanceMetres: 2_400,
    durationSeconds: 1_800,
    estimatedDirectSunSeconds: 420,
    directSunRangeSeconds: [300, 540],
    estimatedShadePercent: 62.45,
    daylightSeconds: 1_800,
    modelledDaylightSeconds: 1_620,
    unknownDaylightSeconds: 180,
    isDaylight: true,
    lowSunConfidence: false,
    limitedConfidence: true,
    confidenceReasons: ["near-clearance-threshold", "incomplete-height-coverage"],
    coveragePercent: 90,
    sections: [],
    journeyCount: 2,
    walkingPace: "standard",
    journeys: scheduledJourneys(),
    labels: ["recommended", "least-sun"],
    recommendationReason: "Not exported free text",
    ...overrides,
  };
}

function route(id, distanceMetres, durationSeconds) {
  return { id, distanceMetres, durationSeconds, coordinates: [[-0.11, 51.5]], directions: [] };
}

function input(overrides = {}) {
  return {
    createdAt: new Date("2026-08-12T12:00:00.000Z"),
    area: { id: "waterloo", name: "Waterloo pilot area" },
    endpoints: {
      origin: { name: "Waterloo Station", lat: 51.5031, lon: -0.1132 },
      destination: { name: "St Thomas’ Hospital", lat: 51.4989, lon: -0.1187 },
    },
    selectedRoute: route("waterloo-2", 1_200, 900),
    selectedScore: score(),
    fastestRoute: route("waterloo-1", 1_100, 840),
    departure: "2026-08-12T13:30:00.000Z",
    profile: "worker",
    walkingPace: "standard",
    schedule: { journeyCount: 2, repeatEveryMinutes: 120 },
    access: {
      avoidKnownStepsRequested: true,
      evidenceStatus: "no-known-barrier-identified",
      crossingEvidence: "mapped",
      surfaceEvidence: "not-flagged",
    },
    provenance: {
      routeData: { source: "OpenStreetMap via Valhalla", sourceDate: "2026-08-12" },
      heightData: {
        source: "Environment Agency LIDAR Composite 1m DSM and DTM",
        sourceDate: "Composite surveys 2000–2022",
        processedDate: "2026-08-12",
      },
      model: { name: "ShadeRoute raster shade model", version: "prototype-1" },
    },
    ...overrides,
  };
}

test("creates a deterministic, versioned and privacy-bounded evidence record", () => {
  const record = createDecisionEvidence(input());
  assert.ok(record);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.assurance.validationStatus, "uncalibrated");
  assert.deepEqual(record.modelOutput.potentialDirectSunRangeSeconds, {
    bestCase: 300,
    worstCase: 540,
  });
  assert.equal(record.modelOutput.estimatedPotentialDirectSunSeconds, 420);
  assert.equal(record.modelOutput.modelledCoveragePercent, 90);
  assert.deepEqual(record.decision.selectedVsFastest, {
    additionalDurationSecondsPerJourney: 60,
    distanceDifferenceMetresPerJourney: 100,
  });
  assert.deepEqual(record.decision.selectedRoute.labels, ["least-sun", "recommended"]);
  assert.deepEqual(record.modelOutput.confidence.reasons, [
    "incomplete-height-coverage",
    "near-clearance-threshold",
  ]);
  assert.equal(record.modelOutput.journeys.length, 2);
  assert.deepEqual(record.modelOutput.journeys[1], {
    index: 1,
    departure: "2026-08-12T15:30:00.000Z",
    arrival: "2026-08-12T15:45:00.000Z",
    estimatedPotentialDirectSunSeconds: 240,
    potentialDirectSunRangeSeconds: { bestCase: 180, worstCase: 300 },
    estimatedShadePercent: 55,
    modelledCoveragePercent: 85,
    confidence: {
      limited: true,
      reasons: ["incomplete-height-coverage", "near-clearance-threshold"],
    },
  });
  assert.equal(
    record.assurance.limitations.includes(DECISION_EVIDENCE_LIMITATIONS[4]),
    true,
  );

  const raw = serialiseDecisionEvidence(record);
  assert.ok(raw);
  assert.equal(new TextEncoder().encode(raw).byteLength < DECISION_EVIDENCE_MAX_BYTES, true);
  assert.deepEqual(parseDecisionEvidence(raw), record);
  assert.equal(serialiseDecisionEvidence(createDecisionEvidence(input())), raw);
  assert.equal(decisionEvidenceFilename(record), "shaderoute-evidence-waterloo-waterloo-2-2026-08-12.json");
});

test("exports bounded endpoint names but omits exact coordinates, route geometry, notes and history", () => {
  const record = createDecisionEvidence(input());
  const raw = serialiseDecisionEvidence(record);
  assert.ok(raw);
  const decoded = JSON.parse(raw);
  assert.deepEqual(Object.keys(decoded.journey.plannedEndpoints), ["origin", "destination"]);
  assert.deepEqual(decoded.journey.plannedEndpoints.origin, { name: "Waterloo Station" });
  assert.deepEqual(decoded.journey.plannedEndpoints.destination, { name: "St Thomas’ Hospital" });
  assert.equal(decoded.privacy.plannedEndpointCoordinatesIncluded, false);
  assert.equal(decoded.privacy.deviceLocationIncluded, false);
  assert.equal(decoded.privacy.freeTextNotesIncluded, false);
  assert.equal(decoded.privacy.savedHistoryIncluded, false);
  assert.equal(decoded.privacy.inferredHealthDataIncluded, false);
  assert.equal("coordinates" in decoded.decision.selectedRoute, false);
  assert.equal("directions" in decoded.decision.selectedRoute, false);
  assert.equal("recommendationReason" in decoded.decision.selectedRoute, false);
  assert.equal("note" in decoded, false);
  assert.equal("history" in decoded, false);
  assert.equal(raw.includes("51.5031"), false);
  assert.equal(raw.includes("-0.1132"), false);
});

test("rejects inconsistent trusted inputs instead of creating misleading evidence", () => {
  assert.equal(createDecisionEvidence(input({
    selectedScore: score({ routeId: "different-route" }),
  })), null);
  assert.equal(createDecisionEvidence(input({
    fastestRoute: route("not-fastest", 1_100, 1_000),
  })), null);
  assert.equal(createDecisionEvidence(input({
    departure: "2026-08-12T13:30",
  })), null);
  assert.equal(createDecisionEvidence(input({
    selectedScore: score({ modelledDaylightSeconds: 1_500 }),
  })), null);
});

test("untrusted parsing fails closed and never throws", () => {
  const valid = serialiseDecisionEvidence(createDecisionEvidence(input()));
  assert.ok(valid);
  const extraField = JSON.parse(valid);
  extraField.deviceLocation = { latitude: 51.5, longitude: -0.1 };
  const wrongVersion = JSON.parse(valid);
  wrongVersion.schemaVersion = 2;
  const weakenedPrivacy = JSON.parse(valid);
  weakenedPrivacy.privacy.deviceLocationIncluded = true;
  const inconsistentTradeOff = JSON.parse(valid);
  inconsistentTradeOff.decision.selectedVsFastest.additionalDurationSecondsPerJourney = 999;
  const damagedSchedule = JSON.parse(valid);
  damagedSchedule.modelOutput.journeys[1].departure = "2026-08-12T15:31:00.000Z";
  const inputs = [
    null,
    undefined,
    {},
    "not-json",
    JSON.stringify(extraField),
    JSON.stringify(wrongVersion),
    JSON.stringify(weakenedPrivacy),
    JSON.stringify(inconsistentTradeOff),
    JSON.stringify(damagedSchedule),
    "x".repeat(DECISION_EVIDENCE_MAX_BYTES + 1),
  ];
  for (const candidate of inputs) {
    assert.doesNotThrow(() => parseDecisionEvidence(candidate));
    assert.equal(parseDecisionEvidence(candidate), null);
  }

  const hostile = {};
  Object.defineProperty(hostile, "toString", { get() { throw new Error("hostile getter"); } });
  assert.doesNotThrow(() => parseDecisionEvidence(hostile));
  assert.equal(parseDecisionEvidence(hostile), null);
});

test("download component states the local-only boundary and model status", async () => {
  const source = await readFile(
    new URL("../components/DecisionEvidenceDownload.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /Exact endpoint coordinates, device location, route\s*geometry, free-text notes, saved history and inferred health information are excluded/i);
  assert.match(source, /created locally and is not uploaded/i);
  assert.match(source, /Endpoint names can still reveal a routine or care\s+journey/i);
  assert.match(source, /uncalibrated clear-sky model record/i);
  assert.match(source, /not proof that a route will be shaded/i);
  assert.match(source, /application\/json/);
  assert.match(source, /URL\.revokeObjectURL/);
});

test("the bounded eight-journey schedule remains below the strict byte cap", () => {
  const firstDeparture = Date.parse("2026-08-12T13:30:00.000Z");
  const journeys = Array.from({ length: 8 }, (_, index) => ({
    index,
    departureEpochMs: firstDeparture + index * 3_600_000,
    arrivalEpochMs: firstDeparture + index * 3_600_000 + 900_000,
    score: journeyScore(210, [150, 270], 60, 90),
  }));
  const record = createDecisionEvidence(input({
    schedule: { journeyCount: 8, repeatEveryMinutes: 60 },
    selectedScore: score({
      journeyCount: 8,
      distanceMetres: 9_600,
      durationSeconds: 7_200,
      estimatedDirectSunSeconds: 1_680,
      directSunRangeSeconds: [1_200, 2_160],
      daylightSeconds: 7_200,
      modelledDaylightSeconds: 6_480,
      unknownDaylightSeconds: 720,
      journeys,
    }),
  }));
  const raw = serialiseDecisionEvidence(record);
  assert.ok(raw);
  assert.equal(new TextEncoder().encode(raw).byteLength < DECISION_EVIDENCE_MAX_BYTES, true);
  assert.equal(parseDecisionEvidence(raw)?.modelOutput.journeys.length, 8);
});
