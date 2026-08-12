const LONDON_TIME_ZONE = "Europe/London";

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const londonPartsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const londonDisplayFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON_TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

function partsFromDate(date: Date): LocalDateTimeParts {
  const parts = Object.fromEntries(
    londonPartsFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

function parseValueParts(value: string): LocalDateTimeParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const parts = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
  };
  const validationDate = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );
  const valid =
    validationDate.getUTCFullYear() === parts.year &&
    validationDate.getUTCMonth() === parts.month - 1 &&
    validationDate.getUTCDate() === parts.day &&
    validationDate.getUTCHours() === parts.hour &&
    validationDate.getUTCMinutes() === parts.minute;
  return valid ? parts : null;
}

function equalParts(left: LocalDateTimeParts, right: LocalDateTimeParts) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function serialiseParts(parts: LocalDateTimeParts) {
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * Parses a datetime-local value as civil time in Europe/London, independent of
 * the device time zone. A spring-forward time which never occurs returns null.
 * During the repeated autumn hour, the earlier of the two instants is used.
 */
export function parseLondonDateTime(value: string): Date | null {
  const desired = parseValueParts(value);
  if (!desired) return null;
  const nominalUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  );

  // Modern London civil time is at most two hours from UTC. Minute-by-minute
  // matching also makes DST gaps and repeated wall times explicit.
  const matches: Date[] = [];
  for (let deltaMinutes = -120; deltaMinutes <= 120; deltaMinutes += 1) {
    const candidate = new Date(nominalUtc + deltaMinutes * 60_000);
    if (equalParts(partsFromDate(candidate), desired)) matches.push(candidate);
  }
  return matches.length ? matches[0] : null;
}

export function formatLondonDateTime(value: string): string {
  const date = parseLondonDateTime(value);
  return date ? londonDisplayFormatter.format(date) : "Choose a valid date and time";
}

/** Serialises an instant as an exact minute in Europe/London for datetime-local controls. */
export function londonDateTimeValue(date = new Date()): string {
  return serialiseParts(partsFromDate(date));
}

export function initialLondonDateTimeValue(now = new Date()): string {
  const londonNow = partsFromDate(now);
  const wallClock = new Date(
    Date.UTC(
      londonNow.year,
      londonNow.month - 1,
      londonNow.day,
      londonNow.hour,
      londonNow.minute,
    ),
  );
  if (londonNow.hour < 7 || londonNow.hour >= 19) {
    wallClock.setUTCHours(14, 30, 0, 0);
  } else {
    wallClock.setUTCMinutes(Math.ceil(londonNow.minute / 15) * 15, 0, 0);
  }
  return serialiseParts({
    year: wallClock.getUTCFullYear(),
    month: wallClock.getUTCMonth() + 1,
    day: wallClock.getUTCDate(),
    hour: wallClock.getUTCHours(),
    minute: wallClock.getUTCMinutes(),
  });
}

export function setLondonLocalHour(value: string, hour: number): string {
  const parts = parseValueParts(value);
  if (!parts || !Number.isInteger(hour) || hour < 0 || hour > 23) return value;
  return serialiseParts({ ...parts, hour, minute: 0 });
}
