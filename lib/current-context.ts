export const CURRENT_CONTEXT_AREA_IDS = ["waterloo", "kings-cross"] as const;

export type CurrentContextAreaId = (typeof CURRENT_CONTEXT_AREA_IDS)[number];

export interface CurrentContextAreaConfig {
  id: CurrentContextAreaId;
  name: string;
  weatherPoint: { latitude: number; longitude: number };
  tflStation: { name: string; naptanId: string };
  streetManagerBounds: {
    minEasting: number;
    minNorthing: number;
    maxEasting: number;
    maxNorthing: number;
  };
}

/**
 * Fixed, non-user-specific provider lookups for the two modelled pilot areas.
 * Street Manager uses British National Grid bounding boxes (EPSG:27700).
 */
export const CURRENT_CONTEXT_AREAS: Record<CurrentContextAreaId, CurrentContextAreaConfig> = {
  waterloo: {
    id: "waterloo",
    name: "Waterloo to St Thomas' Hospital",
    weatherPoint: { latitude: 51.5014, longitude: -0.1127 },
    tflStation: { name: "Waterloo Underground Station", naptanId: "940GZZLUWLO" },
    streetManagerBounds: {
      minEasting: 529_921,
      minNorthing: 178_608,
      maxEasting: 532_126,
      maxNorthing: 180_668,
    },
  },
  "kings-cross": {
    id: "kings-cross",
    name: "King's Cross to University College Hospital",
    weatherPoint: { latitude: 51.5272, longitude: -0.1272 },
    tflStation: { name: "King's Cross St Pancras Underground Station", naptanId: "940GZZLUKSX" },
    streetManagerBounds: {
      minEasting: 528_808,
      minNorthing: 181_417,
      maxEasting: 531_250,
      maxNorthing: 183_650,
    },
  },
};

export interface CurrentContextSource {
  label: string;
  url: string;
}

interface ProviderState {
  status: "available" | "disabled" | "unavailable";
  stale: boolean;
  retrievedAt: string | null;
  sourceUpdatedAt: string | null;
  message: string;
  source: CurrentContextSource;
}

export interface TflContextIssue {
  kind: "lift" | "station-disruption";
  summary: string;
  validFrom: string | null;
  validTo: string | null;
}

export interface TflCurrentContext extends ProviderState {
  provider: "tfl";
  station: { name: string; naptanId: string };
  issues: TflContextIssue[];
}

export interface WeatherForecastContext {
  forecastAt: string;
  modelRunAt: string;
  temperatureC: number;
  feelsLikeC: number;
  uvIndex: number;
  weatherCode: number;
  condition: string;
  cloudContext: {
    signal: "clear-or-sunny" | "partly-cloudy" | "cloudy-or-overcast" | "not-separately-reported";
    label: string;
    amountPercent: null;
  };
}

export interface MetOfficeCurrentContext extends ProviderState {
  provider: "met-office";
  forecast: WeatherForecastContext | null;
}

export interface StreetManagerWork {
  reference: string;
  street: string;
  category: string;
  trafficManagement: string;
  permitStatus: string;
  startsAt: string;
  endsAt: string;
}

export const STREET_MANAGER_LOOKAHEAD_DAYS = 7;
export const STREET_MANAGER_LOOKAHEAD_MS = STREET_MANAGER_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1_000;

export interface StreetManagerContextWindow {
  startsAt: string;
  endsAt: string;
  durationDays: typeof STREET_MANAGER_LOOKAHEAD_DAYS;
}

export interface StreetManagerCurrentContext extends ProviderState {
  provider: "street-manager";
  window: StreetManagerContextWindow | null;
  works: StreetManagerWork[];
  recordsReturned: number;
  recordsLimited: boolean;
}

export interface CurrentJourneyContextData {
  contractVersion: 1;
  areaId: CurrentContextAreaId;
  areaName: string;
  generatedAt: string;
  providers: {
    tfl: TflCurrentContext;
    weather: MetOfficeCurrentContext;
    roadworks: StreetManagerCurrentContext;
  };
  limitations: [string, string, string];
}

const CURRENT_CONTEXT_TIMESTAMP_MINIMUM = Date.UTC(2000, 0, 1);
const CURRENT_CONTEXT_TIMESTAMP_MAXIMUM = Date.UTC(2100, 0, 1);
const CURRENT_CONTEXT_MAX_ISSUES = 12;
const CURRENT_CONTEXT_MAX_WORKS = 12;
const CURRENT_CONTEXT_MAX_RECORDS_RETURNED = 5_000;

const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export const CURRENT_CONTEXT_SOURCES = {
  tfl: {
    label: "Transport for London open data",
    url: "https://tfl.gov.uk/info-for/open-data-users/our-open-data",
  },
  weather: {
    label: "Met Office Weather DataHub",
    url: "https://datahub.metoffice.gov.uk/docs/f/category/site-specific/overview",
  },
  roadworks: {
    label: "Department for Transport Street Manager",
    url: "https://www.gov.uk/guidance/find-and-use-roadworks-data",
  },
} as const satisfies Record<string, CurrentContextSource>;

export function isCurrentContextAreaId(value: unknown): value is CurrentContextAreaId {
  return typeof value === "string" && CURRENT_CONTEXT_AREA_IDS.includes(value as CurrentContextAreaId);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown, maximumLength = 500): string | null {
  if (typeof value !== "string") return null;
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  const cleaned = withoutControls.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maximumLength);
}

function isoDateTime(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function contractText(value: unknown, maximumLength: number): string | null {
  const hasControlCharacter = typeof value === "string" && Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim().length === 0 ||
    hasControlCharacter
  ) {
    return null;
  }
  return value;
}

/**
 * Parse the timestamp subset emitted by this API. Unlike Date.parse, this
 * rejects incomplete dates and calendar rollovers such as 31 February.
 */
function contractIsoDateTime(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const match = ISO_DATE_TIME_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 || minute > 59 || second > 59
  ) {
    return null;
  }

  if (match[8] !== "Z") {
    const offsetHour = Number(match[8].slice(1, 3));
    const offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return null;
    }
  }

  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < CURRENT_CONTEXT_TIMESTAMP_MINIMUM ||
    timestamp > CURRENT_CONTEXT_TIMESTAMP_MAXIMUM
  ) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function nullableContractIsoDateTime(value: unknown): string | null | undefined {
  if (value === null) return null;
  return contractIsoDateTime(value) ?? undefined;
}

function parseContractSource(
  value: unknown,
  expected: CurrentContextSource,
): CurrentContextSource | null {
  const record = objectValue(value);
  if (!record) return null;
  const label = contractText(record.label, 120);
  const url = contractText(record.url, 2_048);
  if (label !== expected.label || url !== expected.url) return null;
  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.username !== "" ||
      parsedUrl.password !== "" ||
      parsedUrl.hash !== ""
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { label, url };
}

type ParsedProviderState = Pick<
  ProviderState,
  "status" | "stale" | "retrievedAt" | "sourceUpdatedAt" | "message" | "source"
>;

function parseProviderState(
  record: Record<string, unknown>,
  expectedSource: CurrentContextSource,
): ParsedProviderState | null {
  const status = record.status;
  if (status !== "available" && status !== "disabled" && status !== "unavailable") return null;
  if (typeof record.stale !== "boolean") return null;
  const retrievedAt = nullableContractIsoDateTime(record.retrievedAt);
  const sourceUpdatedAt = nullableContractIsoDateTime(record.sourceUpdatedAt);
  const message = contractText(record.message, 1_000);
  const source = parseContractSource(record.source, expectedSource);
  if (retrievedAt === undefined || sourceUpdatedAt === undefined || !message || !source) return null;

  // Only successfully retrieved provider data can be served from stale cache.
  if (status === "available") {
    if (retrievedAt === null) return null;
  } else if (record.stale || retrievedAt !== null || sourceUpdatedAt !== null) {
    return null;
  }

  return {
    status,
    stale: record.stale,
    retrievedAt,
    sourceUpdatedAt,
    message,
    source,
  };
}

function parseTflContract(
  value: unknown,
  areaId: CurrentContextAreaId,
): TflCurrentContext | null {
  const record = objectValue(value);
  if (!record || record.provider !== "tfl") return null;
  const providerState = parseProviderState(record, CURRENT_CONTEXT_SOURCES.tfl);
  const station = objectValue(record.station);
  const expectedStation = CURRENT_CONTEXT_AREAS[areaId].tflStation;
  if (
    !providerState ||
    !station ||
    station.name !== expectedStation.name ||
    station.naptanId !== expectedStation.naptanId ||
    !Array.isArray(record.issues) ||
    record.issues.length > CURRENT_CONTEXT_MAX_ISSUES
  ) {
    return null;
  }

  const issues: TflContextIssue[] = [];
  for (const value of record.issues) {
    const issue = objectValue(value);
    if (!issue || (issue.kind !== "lift" && issue.kind !== "station-disruption")) return null;
    const summary = contractText(issue.summary, 500);
    const validFrom = nullableContractIsoDateTime(issue.validFrom);
    const validTo = nullableContractIsoDateTime(issue.validTo);
    if (!summary || validFrom === undefined || validTo === undefined) return null;
    if (
      validFrom !== null &&
      validTo !== null &&
      Date.parse(validFrom) > Date.parse(validTo)
    ) {
      return null;
    }
    issues.push({ kind: issue.kind, summary, validFrom, validTo });
  }
  if (providerState.status !== "available" && issues.length !== 0) return null;

  return {
    provider: "tfl",
    ...providerState,
    station: { ...expectedStation },
    issues,
  };
}

function parseWeatherForecastContract(value: unknown): WeatherForecastContext | null {
  const record = objectValue(value);
  if (!record) return null;
  const forecastAt = contractIsoDateTime(record.forecastAt);
  const modelRunAt = contractIsoDateTime(record.modelRunAt);
  const temperatureC = finiteNumber(record.temperatureC, -80, 60);
  const feelsLikeC = finiteNumber(record.feelsLikeC, -100, 70);
  const uvIndex = finiteNumber(record.uvIndex, 0, 30);
  const weatherCode = finiteNumber(record.weatherCode, 0, 30);
  const condition = contractText(record.condition, 120);
  const cloudContext = objectValue(record.cloudContext);
  if (
    !forecastAt || !modelRunAt || temperatureC === null || feelsLikeC === null ||
    uvIndex === null || weatherCode === null || !Number.isInteger(weatherCode) ||
    !WEATHER_CONDITIONS[weatherCode] || condition !== WEATHER_CONDITIONS[weatherCode] ||
    !cloudContext
  ) {
    return null;
  }
  const expectedCloudContext = cloudContextForWeatherCode(weatherCode);
  if (
    cloudContext.signal !== expectedCloudContext.signal ||
    cloudContext.label !== expectedCloudContext.label ||
    cloudContext.amountPercent !== null
  ) {
    return null;
  }
  return {
    forecastAt,
    modelRunAt,
    temperatureC,
    feelsLikeC,
    uvIndex,
    weatherCode,
    condition,
    cloudContext: expectedCloudContext,
  };
}

function parseMetOfficeContract(value: unknown): MetOfficeCurrentContext | null {
  const record = objectValue(value);
  if (!record || record.provider !== "met-office") return null;
  const providerState = parseProviderState(record, CURRENT_CONTEXT_SOURCES.weather);
  if (!providerState) return null;
  const forecast = record.forecast === null ? null : parseWeatherForecastContract(record.forecast);
  if (
    (record.forecast !== null && !forecast) ||
    (providerState.status === "available") !== (forecast !== null)
  ) {
    return null;
  }
  return { provider: "met-office", ...providerState, forecast };
}

function parseStreetManagerWindow(value: unknown): StreetManagerContextWindow | null {
  const record = objectValue(value);
  if (!record || record.durationDays !== STREET_MANAGER_LOOKAHEAD_DAYS) return null;
  const startsAt = contractIsoDateTime(record.startsAt);
  const endsAt = contractIsoDateTime(record.endsAt);
  if (
    !startsAt ||
    !endsAt ||
    Date.parse(endsAt) - Date.parse(startsAt) !== STREET_MANAGER_LOOKAHEAD_MS
  ) {
    return null;
  }
  return { startsAt, endsAt, durationDays: STREET_MANAGER_LOOKAHEAD_DAYS };
}

function parseStreetManagerContract(value: unknown): StreetManagerCurrentContext | null {
  const record = objectValue(value);
  if (!record || record.provider !== "street-manager") return null;
  const providerState = parseProviderState(record, CURRENT_CONTEXT_SOURCES.roadworks);
  if (
    !providerState ||
    !Array.isArray(record.works) ||
    record.works.length > CURRENT_CONTEXT_MAX_WORKS ||
    typeof record.recordsReturned !== "number" ||
    !Number.isInteger(record.recordsReturned) ||
    record.recordsReturned < 0 ||
    record.recordsReturned > CURRENT_CONTEXT_MAX_RECORDS_RETURNED ||
    typeof record.recordsLimited !== "boolean"
  ) {
    return null;
  }

  const window = record.window === null ? null : parseStreetManagerWindow(record.window);
  if (record.window !== null && !window) return null;
  const works: StreetManagerWork[] = [];
  for (const value of record.works) {
    const work = objectValue(value);
    if (!work) return null;
    const reference = contractText(work.reference, 120);
    const street = contractText(work.street, 160);
    const category = contractText(work.category, 120);
    const trafficManagement = contractText(work.trafficManagement, 160);
    const permitStatus = contractText(work.permitStatus, 120);
    const startsAt = contractIsoDateTime(work.startsAt);
    const endsAt = contractIsoDateTime(work.endsAt);
    if (
      !reference || !street || !category || !trafficManagement || !permitStatus ||
      !startsAt || !endsAt || Date.parse(startsAt) > Date.parse(endsAt) ||
      (window && (Date.parse(endsAt) < Date.parse(window.startsAt) || Date.parse(startsAt) > Date.parse(window.endsAt)))
    ) {
      return null;
    }
    works.push({ reference, street, category, trafficManagement, permitStatus, startsAt, endsAt });
  }

  if (
    record.recordsReturned < works.length ||
    (record.recordsReturned > works.length && !record.recordsLimited) ||
    (providerState.status === "available") !== (window !== null) ||
    (providerState.status !== "available" &&
      (works.length !== 0 || record.recordsReturned !== 0 || record.recordsLimited))
  ) {
    return null;
  }

  return {
    provider: "street-manager",
    ...providerState,
    window,
    works,
    recordsReturned: record.recordsReturned,
    recordsLimited: record.recordsLimited,
  };
}

/**
 * Validate and normalise the complete browser-facing current-context contract.
 * It is deliberately non-throwing because its input crosses a network trust
 * boundary. A malformed optional provider response must not reach React.
 */
export function parseCurrentJourneyContextData(
  value: unknown,
  expectedAreaId: CurrentContextAreaId,
): CurrentJourneyContextData | null {
  try {
    const record = objectValue(value);
    if (
      !record ||
      record.contractVersion !== 1 ||
      record.areaId !== expectedAreaId ||
      record.areaName !== CURRENT_CONTEXT_AREAS[expectedAreaId].name
    ) {
      return null;
    }
    const generatedAt = contractIsoDateTime(record.generatedAt);
    const providers = objectValue(record.providers);
    if (!generatedAt || !providers) return null;
    const tfl = parseTflContract(providers.tfl, expectedAreaId);
    const weather = parseMetOfficeContract(providers.weather);
    const roadworks = parseStreetManagerContract(providers.roadworks);
    if (
      !tfl || !weather || !roadworks ||
      !Array.isArray(record.limitations) ||
      record.limitations.length !== 3
    ) {
      return null;
    }
    const limitations = record.limitations.map((value) => contractText(value, 400));
    if (limitations.some((value) => value === null)) return null;

    return {
      contractVersion: 1,
      areaId: expectedAreaId,
      areaName: CURRENT_CONTEXT_AREAS[expectedAreaId].name,
      generatedAt,
      providers: { tfl, weather, roadworks },
      limitations: limitations as [string, string, string],
    };
  } catch {
    return null;
  }
}

export function disabledTflContext(areaId: CurrentContextAreaId): TflCurrentContext {
  return {
    provider: "tfl",
    status: "disabled",
    stale: false,
    retrievedAt: null,
    sourceUpdatedAt: null,
    message: "TfL current context is not configured on this server.",
    source: CURRENT_CONTEXT_SOURCES.tfl,
    station: CURRENT_CONTEXT_AREAS[areaId].tflStation,
    issues: [],
  };
}

export function unavailableTflContext(areaId: CurrentContextAreaId): TflCurrentContext {
  return {
    ...disabledTflContext(areaId),
    status: "unavailable",
    message: "TfL current context is temporarily unavailable.",
  };
}

export function parseTflCurrentContext(
  areaId: CurrentContextAreaId,
  liftPayload: unknown,
  disruptionPayload: unknown,
  retrievedAt: string,
): TflCurrentContext | null {
  if (!Array.isArray(liftPayload) || !Array.isArray(disruptionPayload)) return null;
  const station = CURRENT_CONTEXT_AREAS[areaId].tflStation;
  const issues: TflContextIssue[] = [];
  const seen = new Set<string>();

  const addIssue = (issue: TflContextIssue) => {
    const key = `${issue.kind}:${issue.summary.toLowerCase()}`;
    if (seen.has(key) || issues.length >= 12) return;
    seen.add(key);
    issues.push(issue);
  };

  for (const value of liftPayload.slice(0, 5_000)) {
    const record = objectValue(value);
    if (!record || record.naptanCode !== station.naptanId) continue;
    const summary = boundedText(record.message);
    if (!summary) continue;
    addIssue({ kind: "lift", summary, validFrom: null, validTo: null });
  }

  for (const value of disruptionPayload.slice(0, 500)) {
    const record = objectValue(value);
    if (!record || (record.atcoCode !== station.naptanId && record.stationAtcoCode !== station.naptanId)) {
      continue;
    }
    const summary = boundedText(record.description);
    if (!summary) continue;
    addIssue({
      kind: "station-disruption",
      summary,
      validFrom: isoDateTime(record.fromDate),
      validTo: isoDateTime(record.toDate),
    });
  }

  return {
    provider: "tfl",
    status: "available",
    stale: false,
    retrievedAt,
    sourceUpdatedAt: null,
    message: issues.length > 0
      ? `TfL returned ${issues.length} relevant station or lift disruption record${issues.length === 1 ? "" : "s"}.`
      : "TfL returned no relevant disruption record for this station. This does not confirm step-free access.",
    source: CURRENT_CONTEXT_SOURCES.tfl,
    station,
    issues,
  };
}

export function disabledMetOfficeContext(): MetOfficeCurrentContext {
  return {
    provider: "met-office",
    status: "disabled",
    stale: false,
    retrievedAt: null,
    sourceUpdatedAt: null,
    message: "Met Office forecast context is not configured on this server.",
    source: CURRENT_CONTEXT_SOURCES.weather,
    forecast: null,
  };
}

export function unavailableMetOfficeContext(): MetOfficeCurrentContext {
  return {
    ...disabledMetOfficeContext(),
    status: "unavailable",
    message: "Met Office forecast context is temporarily unavailable.",
  };
}

const WEATHER_CONDITIONS: Record<number, string> = {
  0: "Clear night",
  1: "Sunny day",
  2: "Partly cloudy night",
  3: "Partly cloudy day",
  5: "Mist",
  6: "Fog",
  7: "Cloudy",
  8: "Overcast",
  9: "Light rain shower at night",
  10: "Light rain shower by day",
  11: "Drizzle",
  12: "Light rain",
  13: "Heavy rain shower at night",
  14: "Heavy rain shower by day",
  15: "Heavy rain",
  16: "Sleet shower at night",
  17: "Sleet shower by day",
  18: "Sleet",
  19: "Hail shower at night",
  20: "Hail shower by day",
  21: "Hail",
  22: "Light snow shower at night",
  23: "Light snow shower by day",
  24: "Light snow",
  25: "Heavy snow shower at night",
  26: "Heavy snow shower by day",
  27: "Heavy snow",
  28: "Thunder shower at night",
  29: "Thunder shower by day",
  30: "Thunder",
};

function cloudContextForWeatherCode(code: number): WeatherForecastContext["cloudContext"] {
  if (code === 0 || code === 1) {
    return {
      signal: "clear-or-sunny",
      label: "Clear or sunny weather-code signal",
      amountPercent: null,
    };
  }
  if (code === 2 || code === 3) {
    return {
      signal: "partly-cloudy",
      label: "Partly cloudy weather-code signal",
      amountPercent: null,
    };
  }
  if (code === 7 || code === 8) {
    return {
      signal: "cloudy-or-overcast",
      label: code === 7 ? "Cloudy weather-code signal" : "Overcast weather-code signal",
      amountPercent: null,
    };
  }
  return {
    signal: "not-separately-reported",
    label: "Cloud amount is not separately reported by this hourly feed",
    amountPercent: null,
  };
}

export function parseMetOfficeCurrentContext(
  payload: unknown,
  retrievedAt: string,
  now = new Date(),
): MetOfficeCurrentContext | null {
  const root = objectValue(payload);
  if (!root || root.type !== "FeatureCollection" || !Array.isArray(root.features)) return null;
  const feature = objectValue(root.features[0]);
  const properties = objectValue(feature?.properties);
  const modelRunAt = isoDateTime(properties?.modelRunDate);
  if (!properties || !modelRunAt || !Array.isArray(properties.timeSeries)) return null;

  const candidates: WeatherForecastContext[] = [];
  for (const value of properties.timeSeries.slice(0, 96)) {
    const record = objectValue(value);
    if (!record) continue;
    const forecastAt = isoDateTime(record.time);
    const temperatureC = finiteNumber(record.screenTemperature, -80, 60);
    const feelsLikeC = finiteNumber(record.feelsLikeTemperature, -100, 70);
    const uvIndex = finiteNumber(record.uvIndex, 0, 30);
    const weatherCode = finiteNumber(record.significantWeatherCode, 0, 30);
    if (
      !forecastAt || temperatureC === null || feelsLikeC === null || uvIndex === null ||
      weatherCode === null || !Number.isInteger(weatherCode) || !WEATHER_CONDITIONS[weatherCode]
    ) {
      continue;
    }
    candidates.push({
      forecastAt,
      modelRunAt,
      temperatureC: Math.round(temperatureC * 10) / 10,
      feelsLikeC: Math.round(feelsLikeC * 10) / 10,
      uvIndex: Math.round(uvIndex * 10) / 10,
      weatherCode,
      condition: WEATHER_CONDITIONS[weatherCode],
      cloudContext: cloudContextForWeatherCode(weatherCode),
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.forecastAt.localeCompare(b.forecastAt));
  const nowMs = now.getTime();
  const forecast = candidates.find((candidate) => new Date(candidate.forecastAt).getTime() >= nowMs)
    ?? candidates.at(-1);
  if (!forecast) return null;

  return {
    provider: "met-office",
    status: "available",
    stale: false,
    retrievedAt,
    sourceUpdatedAt: modelRunAt,
    message: "Met Office hourly forecast context for the fixed pilot-area point.",
    source: CURRENT_CONTEXT_SOURCES.weather,
    forecast,
  };
}

export function disabledStreetManagerContext(): StreetManagerCurrentContext {
  return {
    provider: "street-manager",
    status: "disabled",
    stale: false,
    retrievedAt: null,
    sourceUpdatedAt: null,
    message: "Street Manager works context is disabled. This public journey planner requires a separately registered Open Data notification feed and current-state ingestion service; an authorised user's GeoJSON token must not be used to re-serve works here.",
    source: CURRENT_CONTEXT_SOURCES.roadworks,
    window: null,
    works: [],
    recordsReturned: 0,
    recordsLimited: false,
  };
}

export function unavailableStreetManagerContext(): StreetManagerCurrentContext {
  return {
    ...disabledStreetManagerContext(),
    status: "unavailable",
    message: "Street Manager roadworks context is temporarily unavailable.",
  };
}

export function parseStreetManagerCurrentContext(
  payload: unknown,
  retrievedAt: string,
  now: Date,
): StreetManagerCurrentContext | null {
  const root = objectValue(payload);
  if (!root || root.type !== "FeatureCollection" || !Array.isArray(root.features)) return null;
  const windowStartsAtMs = now.getTime();
  if (!Number.isFinite(windowStartsAtMs)) return null;
  const windowEndsAtMs = windowStartsAtMs + STREET_MANAGER_LOOKAHEAD_MS;
  if (!Number.isFinite(new Date(windowEndsAtMs).getTime())) return null;
  const window: StreetManagerContextWindow = {
    startsAt: new Date(windowStartsAtMs).toISOString(),
    endsAt: new Date(windowEndsAtMs).toISOString(),
    durationDays: STREET_MANAGER_LOOKAHEAD_DAYS,
  };
  const works: StreetManagerWork[] = [];
  let sourceUpdatedAt: string | null = null;
  let validRecordCount = 0;

  for (const value of root.features.slice(0, 5_000)) {
    const feature = objectValue(value);
    const properties = objectValue(feature?.properties);
    if (!properties) continue;
    const reference = boundedText(properties.work_reference_number, 120);
    const street = boundedText(properties.street, 160);
    const category = boundedText(properties.work_category_string, 120);
    const trafficManagement = boundedText(properties.traffic_management_type_string, 160);
    const permitStatus = boundedText(properties.permit_status_string, 120);
    const startsAt = isoDateTime(properties.start_date);
    const endsAt = isoDateTime(properties.end_date);
    if (!reference || !street || !category || !trafficManagement || !permitStatus || !startsAt || !endsAt) {
      continue;
    }
    const startsAtMs = new Date(startsAt).getTime();
    const endsAtMs = new Date(endsAt).getTime();
    if (
      startsAtMs > endsAtMs ||
      endsAtMs < windowStartsAtMs ||
      startsAtMs > windowEndsAtMs
    ) {
      continue;
    }
    validRecordCount += 1;
    const updatedAt = isoDateTime(properties.current_traffic_management_update_date);
    if (updatedAt && (!sourceUpdatedAt || updatedAt > sourceUpdatedAt)) sourceUpdatedAt = updatedAt;
    if (works.length < 12) {
      works.push({ reference, street, category, trafficManagement, permitStatus, startsAt, endsAt });
    }
  }

  return {
    provider: "street-manager",
    status: "available",
    stale: false,
    retrievedAt,
    sourceUpdatedAt,
    window,
    message: validRecordCount > 0
      ? `Street Manager returned ${validRecordCount} works record${validRecordCount === 1 ? "" : "s"} in the pilot area overlapping the next ${STREET_MANAGER_LOOKAHEAD_DAYS} days (${window.startsAt} to ${window.endsAt}, inclusive). A record does not establish that a pavement is closed.`
      : `Street Manager returned no valid works records in the pilot area overlapping the next ${STREET_MANAGER_LOOKAHEAD_DAYS} days (${window.startsAt} to ${window.endsAt}, inclusive). This does not confirm that the pavement is open.`,
    source: CURRENT_CONTEXT_SOURCES.roadworks,
    works,
    recordsReturned: validRecordCount,
    recordsLimited: validRecordCount > works.length || root.features.length > 5_000,
  };
}

export function markCurrentContextStale<T extends TflCurrentContext | MetOfficeCurrentContext | StreetManagerCurrentContext>(
  context: T,
): T {
  return {
    ...context,
    stale: true,
    message: `Cached ${context.message.charAt(0).toLowerCase()}${context.message.slice(1)}`,
  };
}
