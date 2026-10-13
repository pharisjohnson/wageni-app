/** Offset (ms) of `timeZone` from UTC at instant `ts`. */
function zoneOffsetMs(ts: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Midnight at the start of the given calendar day in `timeZone`, as a UTC timestamp. */
function startOfZoneDay(year: number, month: number, day: number, timeZone: string) {
  const guess = Date.UTC(year, month, day);
  return guess - zoneOffsetMs(guess - zoneOffsetMs(guess, timeZone), timeZone);
}

/** [start, end) of the calendar day containing `now` in `timeZone` (falls back to UTC for an invalid zone). */
export function dayBoundsInZone(now: number, timeZone: string): { start: number; end: number } {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const [y, m, d] = [get("year"), get("month") - 1, get("day")];
  return { start: startOfZoneDay(y, m, d, zone), end: startOfZoneDay(y, m, d + 1, zone) };
}
