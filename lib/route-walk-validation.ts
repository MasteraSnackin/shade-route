import { parseLondonDateTime } from "./london-time.ts";

export const ROUTE_WALK_VALIDATION_SCHEMA =
  "uk.shaderoute.route-walk-validation" as const;
export const ROUTE_WALK_VALIDATION_SCHEMA_VERSION = 1 as const;
export const ROUTE_WALK_VALIDATION_MAX_BYTES = 256 * 1024;
export const ROUTE_WALK_VALIDATION_MAX_ROWS = 600;

export const ROUTE_WALK_VALIDATION_COLUMNS = [
  "schema",
  "schema_version",
  "comparison_id",
  "pilot_area",
  "comparison_london_datetime",
  "model_version",
  "route_id",
  "walk_complete",
  "prediction_frozen_before_walk",
  "weather_visibility",
  "predicted_duration_minutes",
  "predicted_direct_sun_minutes",
  "predicted_shade_minutes",
  "predicted_unknown_minutes",
  "observed_duration_minutes",
  "observed_direct_sun_minutes",
  "observed_shade_minutes",
  "observed_unknown_minutes",
  "predicted_order",
  "observed_order",
] as const;

export type RouteWalkPilotArea = "waterloo" | "kings-cross";

export interface RouteWalkValidationRow {
  schema: typeof ROUTE_WALK_VALIDATION_SCHEMA;
  schemaVersion: typeof ROUTE_WALK_VALIDATION_SCHEMA_VERSION;
  comparisonId: string;
  pilotArea: RouteWalkPilotArea;
  comparisonLondonDateTime: string;
  modelVersion: string;
  routeId: string;
  walkComplete: true;
  predictionFrozenBeforeWalk: true;
  weatherVisibility: "clear-direct-sun";
  predictedDurationMinutes: number;
  predictedDirectSunMinutes: number;
  predictedShadeMinutes: number;
  predictedUnknownMinutes: number;
  observedDurationMinutes: number;
  observedDirectSunMinutes: number;
  observedShadeMinutes: number;
  observedUnknownMinutes: number;
  predictedOrder: number;
  observedOrder: number | null;
}

export interface RouteWalkResult {
  routeId: string;
  predictedOrder: number;
  observedOrder: number | null;
  predictedDirectSunMinutes: number;
  observedDirectSunMinutes: number;
  absoluteDirectSunErrorMinutes: number | null;
  predictedCoveragePercent: number;
  observedCoveragePercent: number;
}

export interface RouteWalkComparisonAnalysis {
  comparisonId: string;
  pilotArea: RouteWalkPilotArea;
  comparisonLondonDateTime: string;
  modelVersion: string;
  routeCount: number;
  predictedBestRouteId: string;
  observedBestRouteId: string | null;
  fullRouteOrderAgreement: boolean | null;
  regretMinutes: number | null;
  routes: RouteWalkResult[];
}

export interface RouteWalkValidationAnalysis {
  status: "empty" | "analysed";
  schema: typeof ROUTE_WALK_VALIDATION_SCHEMA;
  schemaVersion: typeof ROUTE_WALK_VALIDATION_SCHEMA_VERSION;
  completeWalkCount: number;
  comparableWalkCount: number;
  directSunMinutesMae: number | null;
  predictedCoveragePercent: number | null;
  predictedUnknownRatePercent: number | null;
  observedCoveragePercent: number | null;
  observedUnknownRatePercent: number | null;
  comparisonCount: number;
  orderComparableComparisonCount: number;
  fullRouteOrderAgreementCount: number;
  fullRouteOrderAgreementRatePercent: number | null;
  meanRegretMinutes: number | null;
  comparisons: RouteWalkComparisonAnalysis[];
}

export type RouteWalkValidationCsvAnalysis =
  | { status: "invalid"; rows: null; analysis: null }
  | {
      status: "empty" | "analysed";
      rows: RouteWalkValidationRow[];
      analysis: RouteWalkValidationAnalysis;
    };

/**
 * Returns the canonical, deliberately empty collection sheet. Keeping template
 * generation beside the parser prevents the in-app download and the committed
 * validation file from drifting onto different schemas.
 */
export function routeWalkValidationTemplateCsv() {
  return `${ROUTE_WALK_VALIDATION_COLUMNS.join(",")}\n`;
}

const OBJECT_KEYS = [
  "schema",
  "schemaVersion",
  "comparisonId",
  "pilotArea",
  "comparisonLondonDateTime",
  "modelVersion",
  "routeId",
  "walkComplete",
  "predictionFrozenBeforeWalk",
  "weatherVisibility",
  "predictedDurationMinutes",
  "predictedDirectSunMinutes",
  "predictedShadeMinutes",
  "predictedUnknownMinutes",
  "observedDurationMinutes",
  "observedDirectSunMinutes",
  "observedShadeMinutes",
  "observedUnknownMinutes",
  "predictedOrder",
  "observedOrder",
] as const satisfies readonly (keyof RouteWalkValidationRow)[];

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MODEL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,79}$/;
const DECIMAL_MINUTES = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,3})?$/;
const PILOT_AREAS = new Set<RouteWalkPilotArea>(["waterloo", "kings-cross"]);
const MAX_DURATION_MINUTES = 240;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function minuteUnits(value: number) {
  return Math.round(value * 1_000);
}

function validMinuteNumber(value: unknown, allowZero: boolean): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value <= MAX_DURATION_MINUTES &&
    (allowZero ? value >= 0 : value > 0) &&
    Math.abs(value * 1_000 - Math.round(value * 1_000)) < 1e-9;
}

function parseMinuteCell(value: string, allowZero: boolean) {
  if (!DECIMAL_MINUTES.test(value)) return null;
  const parsed = Number(value);
  return validMinuteNumber(parsed, allowZero) ? parsed : null;
}

function validOrder(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 3;
}

function rowTotalsAreConsistent(row: RouteWalkValidationRow) {
  return minuteUnits(row.predictedDurationMinutes) ===
      minuteUnits(row.predictedDirectSunMinutes) +
      minuteUnits(row.predictedShadeMinutes) +
      minuteUnits(row.predictedUnknownMinutes) &&
    minuteUnits(row.observedDurationMinutes) ===
      minuteUnits(row.observedDirectSunMinutes) +
      minuteUnits(row.observedShadeMinutes) +
      minuteUnits(row.observedUnknownMinutes);
}

function cleanObjectRow(value: unknown): RouteWalkValidationRow | null {
  if (!isPlainObject(value) || !hasExactKeys(value, OBJECT_KEYS)) return null;
  if (
    value.schema !== ROUTE_WALK_VALIDATION_SCHEMA ||
    value.schemaVersion !== ROUTE_WALK_VALIDATION_SCHEMA_VERSION ||
    typeof value.comparisonId !== "string" ||
    !SAFE_ID.test(value.comparisonId) ||
    typeof value.pilotArea !== "string" ||
    !PILOT_AREAS.has(value.pilotArea as RouteWalkPilotArea) ||
    typeof value.comparisonLondonDateTime !== "string" ||
    !parseLondonDateTime(value.comparisonLondonDateTime) ||
    typeof value.modelVersion !== "string" ||
    !MODEL_VERSION.test(value.modelVersion) ||
    typeof value.routeId !== "string" ||
    !SAFE_ID.test(value.routeId) ||
    value.walkComplete !== true ||
    value.predictionFrozenBeforeWalk !== true ||
    value.weatherVisibility !== "clear-direct-sun" ||
    !validMinuteNumber(value.predictedDurationMinutes, false) ||
    !validMinuteNumber(value.predictedDirectSunMinutes, true) ||
    !validMinuteNumber(value.predictedShadeMinutes, true) ||
    !validMinuteNumber(value.predictedUnknownMinutes, true) ||
    !validMinuteNumber(value.observedDurationMinutes, false) ||
    !validMinuteNumber(value.observedDirectSunMinutes, true) ||
    !validMinuteNumber(value.observedShadeMinutes, true) ||
    !validMinuteNumber(value.observedUnknownMinutes, true) ||
    !validOrder(value.predictedOrder) ||
    !(value.observedOrder === null || validOrder(value.observedOrder))
  ) {
    return null;
  }

  const row = value as unknown as RouteWalkValidationRow;
  return rowTotalsAreConsistent(row) ? { ...row } : null;
}

function rowFromCells(cells: string[]): RouteWalkValidationRow | null {
  if (cells.length !== ROUTE_WALK_VALIDATION_COLUMNS.length) return null;
  const [
    schema,
    schemaVersion,
    comparisonId,
    pilotArea,
    comparisonLondonDateTime,
    modelVersion,
    routeId,
    walkComplete,
    predictionFrozenBeforeWalk,
    weatherVisibility,
    predictedDuration,
    predictedDirectSun,
    predictedShade,
    predictedUnknown,
    observedDuration,
    observedDirectSun,
    observedShade,
    observedUnknown,
    predictedOrder,
    observedOrder,
  ] = cells;

  const candidate = {
    schema,
    schemaVersion: schemaVersion === "1" ? 1 : Number.NaN,
    comparisonId,
    pilotArea,
    comparisonLondonDateTime,
    modelVersion,
    routeId,
    walkComplete: walkComplete === "true",
    predictionFrozenBeforeWalk: predictionFrozenBeforeWalk === "true",
    weatherVisibility,
    predictedDurationMinutes: parseMinuteCell(predictedDuration, false),
    predictedDirectSunMinutes: parseMinuteCell(predictedDirectSun, true),
    predictedShadeMinutes: parseMinuteCell(predictedShade, true),
    predictedUnknownMinutes: parseMinuteCell(predictedUnknown, true),
    observedDurationMinutes: parseMinuteCell(observedDuration, false),
    observedDirectSunMinutes: parseMinuteCell(observedDirectSun, true),
    observedShadeMinutes: parseMinuteCell(observedShade, true),
    observedUnknownMinutes: parseMinuteCell(observedUnknown, true),
    predictedOrder: /^[1-3]$/.test(predictedOrder) ? Number(predictedOrder) : Number.NaN,
    observedOrder: observedOrder === "unknown"
      ? null
      : /^[1-3]$/.test(observedOrder)
        ? Number(observedOrder)
        : Number.NaN,
  };
  return cleanObjectRow(candidate);
}

function ranksAreComplete(rows: RouteWalkValidationRow[], key: "predictedOrder" | "observedOrder") {
  const ranks = rows.map((row) => row[key]);
  if (ranks.some((rank) => rank === null)) return false;
  return [...ranks].sort((left, right) => Number(left) - Number(right))
    .every((rank, index) => rank === index + 1);
}

function orderMatchesMinutes(
  rows: RouteWalkValidationRow[],
  orderKey: "predictedOrder" | "observedOrder",
  minutesKey: "predictedDirectSunMinutes" | "observedDirectSunMinutes",
) {
  const ordered = [...rows].sort(
    (left, right) => Number(left[orderKey]) - Number(right[orderKey]),
  );
  return ordered.every(
    (row, index) => index === 0 ||
      row[minutesKey] >= ordered[index - 1][minutesKey],
  );
}

function cleanDataset(value: unknown): RouteWalkValidationRow[] | null {
  if (!Array.isArray(value) || value.length > ROUTE_WALK_VALIDATION_MAX_ROWS) return null;
  const rows = value.map(cleanObjectRow);
  if (rows.some((row) => row === null)) return null;
  const typed = rows as RouteWalkValidationRow[];
  const comparisons = new Map<string, RouteWalkValidationRow[]>();
  for (const row of typed) {
    const group = comparisons.get(row.comparisonId) ?? [];
    group.push(row);
    comparisons.set(row.comparisonId, group);
  }

  for (const group of comparisons.values()) {
    if (group.length < 2 || group.length > 3) return null;
    const first = group[0];
    if (group.some((row) =>
      row.pilotArea !== first.pilotArea ||
      row.comparisonLondonDateTime !== first.comparisonLondonDateTime ||
      row.modelVersion !== first.modelVersion ||
      row.weatherVisibility !== first.weatherVisibility
    )) return null;
    if (new Set(group.map((row) => row.routeId)).size !== group.length) return null;
    if (!ranksAreComplete(group, "predictedOrder")) return null;
    if (!orderMatchesMinutes(group, "predictedOrder", "predictedDirectSunMinutes")) return null;

    const observationsHaveUnknowns = group.some((row) => row.observedUnknownMinutes > 0);
    if (observationsHaveUnknowns) {
      if (group.some((row) => row.observedOrder !== null)) return null;
    } else {
      if (!ranksAreComplete(group, "observedOrder")) return null;
      if (!orderMatchesMinutes(group, "observedOrder", "observedDirectSunMinutes")) return null;
    }
  }
  return typed;
}

function splitStrictCsv(raw: string) {
  if (raw.includes('"') || raw.includes("\0") || /\r(?!\n)/.test(raw)) return null;
  const normalised = raw.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const lines = normalised.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length || lines.some((line) => line === "")) return null;
  return lines.map((line) => line.split(","));
}

/**
 * Parses an untrusted header-only or populated validation CSV. It fails closed
 * with null and never repairs ranks, totals, comparison membership or unknowns.
 */
export function parseRouteWalkValidationCsv(raw: unknown): RouteWalkValidationRow[] | null {
  try {
    if (typeof raw !== "string" || !raw) return null;
    if (new TextEncoder().encode(raw).byteLength > ROUTE_WALK_VALIDATION_MAX_BYTES) return null;
    const records = splitStrictCsv(raw);
    if (!records?.length) return null;
    if (
      records[0].length !== ROUTE_WALK_VALIDATION_COLUMNS.length ||
      !ROUTE_WALK_VALIDATION_COLUMNS.every((column, index) => records[0][index] === column)
    ) return null;
    if (records.length - 1 > ROUTE_WALK_VALIDATION_MAX_ROWS) return null;
    const rows = records.slice(1).map(rowFromCells);
    if (rows.some((row) => row === null)) return null;
    return cleanDataset(rows);
  } catch {
    return null;
  }
}

function round(value: number, decimalPlaces = 3) {
  const factor = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function percentage(knownOrUnknownMinutes: number, durationMinutes: number) {
  return round((knownOrUnknownMinutes / durationMinutes) * 100);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Analyses already parsed rows. Untrusted or contradictory arrays return null. */
export function analyseRouteWalkValidation(
  value: unknown,
): RouteWalkValidationAnalysis | null {
  try {
    const rows = cleanDataset(value);
    if (!rows) return null;
    if (rows.length === 0) {
      return {
        status: "empty",
        schema: ROUTE_WALK_VALIDATION_SCHEMA,
        schemaVersion: ROUTE_WALK_VALIDATION_SCHEMA_VERSION,
        completeWalkCount: 0,
        comparableWalkCount: 0,
        directSunMinutesMae: null,
        predictedCoveragePercent: null,
        predictedUnknownRatePercent: null,
        observedCoveragePercent: null,
        observedUnknownRatePercent: null,
        comparisonCount: 0,
        orderComparableComparisonCount: 0,
        fullRouteOrderAgreementCount: 0,
        fullRouteOrderAgreementRatePercent: null,
        meanRegretMinutes: null,
        comparisons: [],
      };
    }

    const comparisonRows = new Map<string, RouteWalkValidationRow[]>();
    for (const row of rows) {
      const group = comparisonRows.get(row.comparisonId) ?? [];
      group.push(row);
      comparisonRows.set(row.comparisonId, group);
    }

    const comparisons = [...comparisonRows.values()].map((group) => {
      const first = group[0];
      const predictedOrder = [...group].sort(
        (left, right) => left.predictedOrder - right.predictedOrder,
      );
      const orderComparable = group.every((row) => row.observedOrder !== null);
      const observedOrder = orderComparable
        ? [...group].sort(
            (left, right) => Number(left.observedOrder) - Number(right.observedOrder),
          )
        : [];
      const predictedBest = predictedOrder[0];
      const observedBest = observedOrder[0] ?? null;
      const routeResults = [...group]
        .sort((left, right) => compareText(left.routeId, right.routeId))
        .map((row): RouteWalkResult => ({
          routeId: row.routeId,
          predictedOrder: row.predictedOrder,
          observedOrder: row.observedOrder,
          predictedDirectSunMinutes: row.predictedDirectSunMinutes,
          observedDirectSunMinutes: row.observedDirectSunMinutes,
          absoluteDirectSunErrorMinutes: row.observedUnknownMinutes === 0
            ? round(Math.abs(
                row.predictedDirectSunMinutes - row.observedDirectSunMinutes,
              ))
            : null,
          predictedCoveragePercent: percentage(
            row.predictedDurationMinutes - row.predictedUnknownMinutes,
            row.predictedDurationMinutes,
          ),
          observedCoveragePercent: percentage(
            row.observedDurationMinutes - row.observedUnknownMinutes,
            row.observedDurationMinutes,
          ),
        }));

      return {
        comparisonId: first.comparisonId,
        pilotArea: first.pilotArea,
        comparisonLondonDateTime: first.comparisonLondonDateTime,
        modelVersion: first.modelVersion,
        routeCount: group.length,
        predictedBestRouteId: predictedBest.routeId,
        observedBestRouteId: observedBest?.routeId ?? null,
        fullRouteOrderAgreement: orderComparable
          ? predictedOrder.every((row, index) => row.routeId === observedOrder[index].routeId)
          : null,
        regretMinutes: observedBest
          ? round(predictedBest.observedDirectSunMinutes - observedBest.observedDirectSunMinutes)
          : null,
        routes: routeResults,
      } satisfies RouteWalkComparisonAnalysis;
    }).sort((left, right) =>
      compareText(left.pilotArea, right.pilotArea) ||
      compareText(left.comparisonLondonDateTime, right.comparisonLondonDateTime) ||
      compareText(left.comparisonId, right.comparisonId)
    );

    const comparableErrors = comparisons.flatMap((comparison) =>
      comparison.routes.flatMap((route) =>
        route.absoluteDirectSunErrorMinutes === null
          ? []
          : [route.absoluteDirectSunErrorMinutes]
      )
    );
    const comparableComparisons = comparisons.filter(
      (comparison) => comparison.fullRouteOrderAgreement !== null,
    );
    const agreementCount = comparableComparisons.filter(
      (comparison) => comparison.fullRouteOrderAgreement,
    ).length;
    const regrets = comparableComparisons.map((comparison) => comparison.regretMinutes as number);
    const predictedDuration = rows.reduce(
      (sum, row) => sum + row.predictedDurationMinutes,
      0,
    );
    const predictedUnknown = rows.reduce(
      (sum, row) => sum + row.predictedUnknownMinutes,
      0,
    );
    const observedDuration = rows.reduce(
      (sum, row) => sum + row.observedDurationMinutes,
      0,
    );
    const observedUnknown = rows.reduce(
      (sum, row) => sum + row.observedUnknownMinutes,
      0,
    );

    return {
      status: "analysed",
      schema: ROUTE_WALK_VALIDATION_SCHEMA,
      schemaVersion: ROUTE_WALK_VALIDATION_SCHEMA_VERSION,
      completeWalkCount: rows.length,
      comparableWalkCount: comparableErrors.length,
      directSunMinutesMae: comparableErrors.length
        ? round(comparableErrors.reduce((sum, value) => sum + value, 0) / comparableErrors.length)
        : null,
      predictedCoveragePercent: percentage(predictedDuration - predictedUnknown, predictedDuration),
      predictedUnknownRatePercent: percentage(predictedUnknown, predictedDuration),
      observedCoveragePercent: percentage(observedDuration - observedUnknown, observedDuration),
      observedUnknownRatePercent: percentage(observedUnknown, observedDuration),
      comparisonCount: comparisons.length,
      orderComparableComparisonCount: comparableComparisons.length,
      fullRouteOrderAgreementCount: agreementCount,
      fullRouteOrderAgreementRatePercent: comparableComparisons.length
        ? round((agreementCount / comparableComparisons.length) * 100)
        : null,
      meanRegretMinutes: regrets.length
        ? round(regrets.reduce((sum, value) => sum + value, 0) / regrets.length)
        : null,
      comparisons,
    };
  } catch {
    return null;
  }
}

/** One-step, non-throwing import path for local validation tooling. */
export function analyseRouteWalkValidationCsv(raw: unknown): RouteWalkValidationCsvAnalysis {
  const rows = parseRouteWalkValidationCsv(raw);
  if (!rows) return { status: "invalid", rows: null, analysis: null };
  const analysis = analyseRouteWalkValidation(rows);
  if (!analysis) return { status: "invalid", rows: null, analysis: null };
  return { status: analysis.status, rows, analysis };
}
