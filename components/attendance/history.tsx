"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { formatDuration } from "@/lib/attendance/sessions";

export type DayRow = {
  date: string;
  totalMs: number;
  sessions: {
    start: number;
    end: number | null;
    siteName: string;
    timeZone: string;
    unclosed: boolean;
    ongoing: boolean;
  }[];
};

export type EventRow = {
  _id: string;
  type: "clock_in" | "clock_out";
  at: number;
  source: "app" | "kiosk" | "reception" | "correction";
  siteId: string;
  siteName: string;
  timeZone: string;
  superseded: boolean;
  isCorrection: boolean;
  recordedByName: string | null;
};

export type CorrectionRow = {
  _id: string;
  userName: string;
  requestedByName: string;
  requestedBySelf: boolean;
  proposedType: "clock_in" | "clock_out";
  proposedAt: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  decidedByName: string | null;
  decisionNote: string | null;
  siteName: string;
  timeZone: string;
  original: { type: "clock_in" | "clock_out"; at: number } | null;
};

export const TYPE_LABEL = { clock_in: "Clock in", clock_out: "Clock out" } as const;
const SOURCE_LABEL = {
  app: "App",
  kiosk: "Kiosk",
  reception: "Recorded by reception",
  correction: "Correction",
} as const;

/** Times are shown in the site's time zone so everyone reads the same clock. */
export function fmtTime(ms: number, timeZone: string) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone });
}

export function fmtDateTime(ms: number, timeZone: string) {
  return new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone });
}

function fmtDay(key: string) {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export const RANGE_OPTIONS = [
  { days: 7, label: "Last 7 days" },
  { days: 14, label: "Last 14 days" },
  { days: 30, label: "Last 30 days" },
] as const;

/** Stable [from, to] for a "last N days" choice (computed once per choice). */
export function useRange() {
  const [now] = useState(() => Date.now());
  const [days, setDays] = useState<number>(14);
  return {
    days,
    setDays,
    from: now - days * 24 * 3_600_000,
    to: now + 24 * 3_600_000,
    picker: (
      <NativeSelect
        aria-label="Date range"
        className="w-40"
        value={days}
        onChange={(e) => setDays(Number(e.target.value))}
      >
        {RANGE_OPTIONS.map((o) => (
          <option key={o.days} value={o.days}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    ),
  };
}

export function DayList({ days }: { days: DayRow[] }) {
  if (days.length === 0) return <p className="text-sm text-muted-foreground">No attendance in this period.</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {days.map((d) => (
        <li key={d.date} className="space-y-1 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium">{fmtDay(d.date)}</p>
            <p className="text-sm font-medium tabular-nums">{formatDuration(d.totalMs)}</p>
          </div>
          <ul className="space-y-0.5 text-sm text-muted-foreground">
            {d.sessions.map((s) => (
              <li key={s.start}>
                {fmtTime(s.start, s.timeZone)} to {s.end ? fmtTime(s.end, s.timeZone) : "now"} · {s.siteName}{" "}
                {s.ongoing && <Badge>Clocked in</Badge>}
                {s.unclosed && <Badge variant="destructive">No clock-out</Badge>}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** Every recorded event, newest first. Superseded entries stay visible, struck through. */
export function EventList({
  events,
  onCorrect,
}: {
  events: EventRow[];
  onCorrect?: (event: EventRow) => void;
}) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No entries in this period.</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {events.map((e) => (
        <li key={e._id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="space-y-0.5">
            <p className={e.superseded ? "text-muted-foreground line-through" : "font-medium"}>
              {TYPE_LABEL[e.type]} · {fmtDateTime(e.at, e.timeZone)}
            </p>
            <p className="text-xs text-muted-foreground">
              {e.siteName} · {SOURCE_LABEL[e.source]}
              {e.recordedByName ? ` (${e.recordedByName})` : ""}
              {e.superseded ? " · Replaced by a correction" : ""}
            </p>
          </div>
          {onCorrect && !e.superseded && (
            <Button size="sm" variant="ghost" onClick={() => onCorrect(e)}>
              Request correction
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

const STATUS_BADGE = {
  pending: <Badge variant="secondary">Pending</Badge>,
  approved: <Badge>Approved</Badge>,
  rejected: <Badge variant="destructive">Rejected</Badge>,
} as const;

export function CorrectionList({ corrections, showPerson }: { corrections: CorrectionRow[]; showPerson?: boolean }) {
  if (corrections.length === 0) return <p className="text-sm text-muted-foreground">No correction requests.</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {corrections.map((c) => (
        <li key={c._id} className="space-y-0.5 px-4 py-3">
          <p className="font-medium">
            {showPerson ? `${c.userName}: ` : ""}
            {TYPE_LABEL[c.proposedType]} at {fmtDateTime(c.proposedAt, c.timeZone)} {STATUS_BADGE[c.status]}
          </p>
          <p className="text-sm text-muted-foreground">
            {c.reason}
            {c.original ? ` · Replaces ${TYPE_LABEL[c.original.type].toLowerCase()} at ${fmtDateTime(c.original.at, c.timeZone)}` : " · Adds a missing entry"}
            {c.requestedBySelf ? "" : ` · Requested by ${c.requestedByName}`}
          </p>
          {c.decidedByName && (
            <p className="text-xs text-muted-foreground">
              Decided by {c.decidedByName}
              {c.decisionNote ? `: ${c.decisionNote}` : ""}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
