"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { fmtDateTime, fmtTime, TYPE_LABEL } from "@/components/attendance/history";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { formatDuration } from "@/lib/attendance/sessions";
import { useActiveOrg } from "@/lib/org/active-org";

type View = "roster" | "corrections";

function CorrectionQueue({ siteId }: { siteId: Id<"sites"> | null }) {
  const { organizationId } = useActiveOrg();
  const pending = useQuery(api.attendance.pendingCorrections, { organizationId, ...(siteId ? { siteId } : {}) });
  const decide = useMutation(api.attendance.decideCorrection);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function act(correctionId: Id<"attendanceCorrections">, decision: "approved" | "rejected") {
    try {
      await decide({ organizationId, correctionId, decision, note: notes[correctionId] });
      toast.success(decision === "approved" ? "Correction approved" : "Correction rejected");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  if (pending === undefined) return <Skeleton className="h-32 w-full" />;
  if (pending.length === 0) return <p className="text-muted-foreground">No corrections are waiting for a decision.</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {pending.map((c) => (
        <li key={c._id} className="space-y-3 px-4 py-3">
          <div className="space-y-0.5">
            <p className="font-medium">
              <Link href={`/app/staff/${c.userId}`} className="hover:underline">
                {c.userName}
              </Link>
              : {TYPE_LABEL[c.proposedType]} at {fmtDateTime(c.proposedAt, c.timeZone)}
            </p>
            <p className="text-sm text-muted-foreground">
              {c.reason} · {c.siteName}
              {c.original
                ? ` · Replaces ${TYPE_LABEL[c.original.type].toLowerCase()} at ${fmtDateTime(c.original.at, c.timeZone)}`
                : " · Adds a missing entry"}
              {c.requestedBySelf ? "" : ` · Requested by ${c.requestedByName}`}
            </p>
            <p className="text-xs text-muted-foreground">
              Approving adds a new entry. The original stays in the history.
            </p>
          </div>
          {c.isOwn ? (
            <p className="text-sm text-muted-foreground">This is your own attendance, so someone else must decide it.</p>
          ) : (
            <div className="flex flex-wrap items-start gap-2">
              <Textarea
                aria-label={`Note for ${c.userName}`}
                placeholder="Note (required to reject)"
                rows={1}
                className="min-w-56 flex-1"
                value={notes[c._id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [c._id]: e.target.value }))}
              />
              <Button size="sm" onClick={() => act(c._id, "approved")}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!(notes[c._id] ?? "").trim()}
                onClick={() => act(c._id, "rejected")}
              >
                Reject
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function StaffPage() {
  const { organizationId, can } = useActiveOrg();
  const sites = useQuery(api.sites.list, can("sites:read") ? { organizationId } : "skip");
  const [chosen, setChosen] = useState<Id<"sites"> | null>(null);
  const [date, setDate] = useState("");
  const [view, setView] = useState<View>("roster");
  const siteId = chosen ?? sites?.find((s) => s.status === "active")?._id ?? null;
  const roster = useQuery(
    api.attendance.siteRoster,
    siteId ? { organizationId, siteId, ...(date ? { date } : {}) } : "skip",
  );
  const record = useMutation(api.attendance.recordOnBehalf);
  const canCorrect = can("staff_attendance:correct");
  const canRecord = can("staff_attendance:record_on_behalf");
  const pendingCount = useQuery(
    api.attendance.pendingCorrections,
    canCorrect ? { organizationId } : "skip",
  )?.length;

  async function recordFor(userId: Id<"users">, type: "clock_in" | "clock_out") {
    if (!siteId) return;
    try {
      await record({ organizationId, siteId, userId, type });
      toast.success(type === "clock_in" ? "Clocked in" : "Clocked out");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader title="Staff attendance" description="Who is in, hours worked and corrections for your sites." />

      <div className="flex flex-wrap items-center gap-3">
        {sites && sites.length > 1 && (
          <NativeSelect
            aria-label="Site"
            className="w-48"
            value={siteId ?? ""}
            onChange={(e) => setChosen(e.target.value as Id<"sites">)}
          >
            {sites.map((s) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        )}
        <div className="flex items-center gap-2">
          <label htmlFor="roster-date" className="text-sm text-muted-foreground">
            Date
          </label>
          <Input
            id="roster-date"
            type="date"
            className="w-44"
            value={date}
            max={new Date().toLocaleDateString("en-CA")}
            onChange={(e) => setDate(e.target.value)}
          />
          {date && (
            <Button variant="ghost" size="sm" onClick={() => setDate("")}>
              Today
            </Button>
          )}
        </div>
        <div className="ml-auto flex gap-2" role="group" aria-label="View">
          <Button variant={view === "roster" ? "default" : "outline"} onClick={() => setView("roster")}>
            Roster
          </Button>
          {canCorrect && (
            <Button variant={view === "corrections" ? "default" : "outline"} onClick={() => setView("corrections")}>
              Corrections{pendingCount ? ` (${pendingCount})` : ""}
            </Button>
          )}
        </div>
      </div>

      {view === "corrections" && canCorrect ? (
        <CorrectionQueue siteId={siteId} />
      ) : !siteId ? (
        <p className="text-muted-foreground">No active site to show.</p>
      ) : roster === undefined ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {roster.siteName} · {roster.date}
            {roster.isToday ? ` · ${roster.inNowCount} in now` : ""} · times in {roster.timeZone}
          </p>
          {roster.rows.length === 0 ? (
            <p className="text-muted-foreground">No staff are assigned to this site.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {roster.rows.map((r) => (
                <li key={r.userId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="space-y-0.5">
                    <p className="font-medium">
                      <Link href={`/app/staff/${r.userId}`} className="hover:underline">
                        {r.name}
                      </Link>{" "}
                      <Badge variant={r.status === "in" ? "default" : "secondary"}>
                        {r.status === "in" ? "In" : r.status === "out" ? "Out" : "Not in"}
                      </Badge>{" "}
                      {r.needsAttention && <Badge variant="destructive">No clock-out</Badge>}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {r.staffNumber ? `#${r.staffNumber} · ` : ""}
                      {r.status === "in" && r.inSince
                        ? `Since ${fmtTime(r.inSince, roster.timeZone)}`
                        : r.firstIn
                          ? `${fmtTime(r.firstIn, roster.timeZone)} to ${r.lastOut ? fmtTime(r.lastOut, roster.timeZone) : "..."}`
                          : "No entries"}
                      {r.totalMs > 0 ? ` · ${formatDuration(r.totalMs)}` : ""}
                      {r.pinSet === false ? " · No kiosk PIN" : ""}
                    </p>
                  </div>
                  {canRecord && roster.isToday && (
                    <Button
                      size="sm"
                      variant={r.status === "in" ? "secondary" : "default"}
                      onClick={() => recordFor(r.userId, r.status === "in" ? "clock_out" : "clock_in")}
                    >
                      {r.status === "in" ? "Clock out for them" : "Clock in for them"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
