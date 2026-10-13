/** Minutes after local midnight for `at` in `timeZone`. */
export function localMinutes(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/**
 * Whether `at` falls in the quiet window [start, end) in `timeZone`. Windows
 * may wrap midnight (22:00 to 06:00). Equal start and end means "no quiet hours".
 */
export function inQuietHours(at: number, timeZone: string, startMin?: number, endMin?: number): boolean {
  if (startMin === undefined || endMin === undefined || startMin === endMin) return false;
  const now = localMinutes(at, timeZone);
  return startMin < endMin ? now >= startMin && now < endMin : now >= startMin || now < endMin;
}
