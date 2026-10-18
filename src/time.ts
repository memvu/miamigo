import { parse } from "chrono-node";

const DATE_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${timeZone}:${JSON.stringify(options)}`;
  const cached = DATE_FORMATTER_CACHE.get(key);
  if (cached) {
    return cached;
  }
  const created = new Intl.DateTimeFormat("en-US", {
    ...options,
    timeZone,
  });
  DATE_FORMATTER_CACHE.set(key, created);
  return created;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone, { year: "numeric" }).format(0);
    return true;
  } catch {
    return false;
  }
}

function timezoneOffset(timestamp: number, timeZone: string): number {
  const parts = Object.fromEntries(
    formatter(timeZone, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(timestamp)
      .map((part) => [part.type, part.value]),
  );
  const wallTime = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (wallTime - Math.floor(timestamp / 1000) * 1000) / 60_000;
}

/** Parse a natural-language date using the chat's timezone, never the host timezone. */
export function parseDateTime(
  value: unknown,
  now: number,
  timeZone: string,
): number | null {
  if (!Number.isFinite(now) || !isValidTimeZone(timeZone)) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const offset = timezoneOffset(now, timeZone);
  const parsed = parse(
    value.trim(),
    { instant: new Date(now), timezone: offset },
    { forwardDate: true },
  )[0];
  if (!parsed) {
    return null;
  }
  let timestamp = parsed.date().getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  if (parsed.start.isCertain("timezoneOffset")) {
    return timestamp;
  }
  // Chrono fixes the reference offset. Resolve the target's offset for DST.
  const wallTime = timestamp + offset * 60_000;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const adjusted = wallTime - timezoneOffset(timestamp, timeZone) * 60_000;
    if (adjusted === timestamp) {
      return timestamp;
    }
    timestamp = adjusted;
  }
  // A nonexistent local time oscillates across the spring-forward gap.
  return null;
}

function dateParts(
  timestamp: number,
  timeZone: string,
): Record<string, string> {
  return Object.fromEntries(
    formatter(timeZone, {
      year: "numeric",
      weekday: "short",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

/** Render the absolute short date form used in every plan/poll template. */
export function formatAbsolute(timestamp: number, timeZone: string): string {
  const parts = dateParts(timestamp, timeZone);
  return `${parts.weekday ?? ""} ${parts.month ?? ""}/${parts.day ?? ""}, ${parts.hour ?? ""}:${parts.minute ?? ""} ${parts.dayPeriod ?? ""}`.trim();
}

export function formatPollClose(timestamp: number, timeZone: string): string {
  return formatAbsolute(timestamp, timeZone);
}

export function formatReminderTime(
  timestamp: number,
  timeZone: string,
): string {
  const parts = dateParts(timestamp, timeZone);
  return `${parts.weekday ?? ""} ${parts.hour ?? ""}:${parts.minute ?? ""} ${parts.dayPeriod ?? ""}`.trim();
}

export function formatDateOnly(timestamp: number, timeZone: string): string {
  const parts = dateParts(timestamp, timeZone);
  return `${parts.weekday ?? ""} ${parts.month ?? ""}/${parts.day ?? ""}`.trim();
}

export function sameCalendarDay(
  left: number,
  right: number,
  timeZone: string,
): boolean {
  const leftParts = dateParts(left, timeZone);
  const rightParts = dateParts(right, timeZone);
  return (
    leftParts.year === rightParts.year &&
    leftParts.month === rightParts.month &&
    leftParts.day === rightParts.day
  );
}
