export const UKHSA_HEAT_METRIC = "heat-alert_headline_matrixNumber";
export const UKHSA_HEAT_METRIC_URL =
  "https://api.ukhsa-dashboard.data.gov.uk/themes/climate_and_environment/sub_themes/seasonal_environmental/topics/Heat-alert/geography_types/Government%20Office%20Region/geographies/London/metrics/heat-alert_headline_matrixNumber?page_size=31";
export const UKHSA_HEAT_SOURCE_URL =
  "https://ukhsa-dashboard.data.gov.uk/weather-health-alerts/heat/london";

const REGION = "London" as const;
const REGION_CODE = "E12000007";
const REGION_TYPE = "Government Office Region" as const;
const SOURCE = {
  label: "UKHSA data dashboard",
  url: UKHSA_HEAT_SOURCE_URL,
} as const;

export interface HeatContextAvailable {
  status: "available";
  region: typeof REGION;
  regionType: typeof REGION_TYPE;
  metric: typeof UKHSA_HEAT_METRIC;
  riskScore: number;
  scale: { min: 1; max: 16 };
  asOf: string;
  stale: boolean;
  source: typeof SOURCE;
}

export interface HeatContextUnavailable {
  status: "unavailable";
  region: typeof REGION;
  regionType: typeof REGION_TYPE;
  message: string;
  source: typeof SOURCE;
}

export type HeatContextData = HeatContextAvailable | HeatContextUnavailable;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function recordsFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;

  const root = objectValue(payload);
  if (!root) return [];
  if (Array.isArray(root.results)) return root.results;
  if (Array.isArray(root.data)) return root.data;

  const data = objectValue(root.data);
  if (data && Array.isArray(data.results)) return data.results;

  // A future single-record response is safe to consider because every field is
  // still checked below against the requested metric and London geography.
  return [root];
}

function field(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    if (Object.hasOwn(record, name)) return record[name];
  }
  return undefined;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalisedGeographyType(value: unknown) {
  return typeof value === "string"
    ? value.replaceAll("_", " ").replace(/\s+/g, " ").trim().toLowerCase()
    : "";
}

function parseRecord(recordValue: unknown): HeatContextAvailable | null {
  const record = objectValue(recordValue);
  if (!record) return null;

  const metric = field(record, ["metric", "metric_name", "metricName"]);
  const geography = field(record, ["geography", "geography_name", "geographyName"]);
  const geographyCode = field(record, ["geography_code", "geographyCode"]);
  const geographyType = field(record, ["geography_type", "geographyType"]);
  const riskScore = field(record, ["metric_value", "metricValue"]);
  const asOf = record.date;

  if (
    metric !== UKHSA_HEAT_METRIC ||
    geography !== REGION ||
    (geographyCode !== null && geographyCode !== undefined && geographyCode !== REGION_CODE) ||
    normalisedGeographyType(geographyType) !== REGION_TYPE.toLowerCase() ||
    typeof riskScore !== "number" ||
    !Number.isInteger(riskScore) ||
    riskScore < 1 ||
    riskScore > 16 ||
    !isIsoDate(asOf)
  ) {
    return null;
  }

  return {
    status: "available",
    region: REGION,
    regionType: REGION_TYPE,
    metric: UKHSA_HEAT_METRIC,
    riskScore,
    scale: { min: 1, max: 16 },
    asOf,
    stale: false,
    source: SOURCE,
  };
}

/**
 * Parses the documented UKHSA paginated response and narrowly tolerates the
 * array/data wrappers and camel-case fields a beta API may migrate to.
 */
export function parseUkhsaHeatContext(payload: unknown): HeatContextAvailable | null {
  let latest: HeatContextAvailable | null = null;

  for (const record of recordsFromPayload(payload)) {
    const candidate = parseRecord(record);
    if (candidate && (!latest || candidate.asOf > latest.asOf)) latest = candidate;
  }

  return latest;
}

export function staleHeatContext(context: HeatContextAvailable): HeatContextAvailable {
  return { ...context, stale: true };
}

export function unavailableHeatContext(): HeatContextUnavailable {
  return {
    status: "unavailable",
    region: REGION,
    regionType: REGION_TYPE,
    message: "UKHSA London heat-health context is temporarily unavailable.",
    source: SOURCE,
  };
}
