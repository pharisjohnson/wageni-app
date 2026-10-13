"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { LogIn, LogOut } from "lucide-react";
import { toast } from "sonner";
import { CorrectionForm } from "@/components/attendance/correction-form";
import {
  CorrectionList,
  DayList,
  EventList,
  fmtDateTime,
  useRange,
  type EventRow,
} from "@/components/attendance/history";
import { PinCard } from "@/components/attendance/pin-card";
import { NotificationPreferencesCard } from "@/components/messages/preferences-card"; // N1
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { formatDuration } from "@/lib/attendance/sessions";
import { useActiveOrg } from "@/lib/org/active-org";

/** Re-renders every 30 s so "clocked in for" stays current. */
function useTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export default function AttendancePage() {
  const { organizationId } = useActiveOrg();
  const status = useQuery(api.attendance.myStatus, { organizationId });
  const clockIn = useMutation(api.attendance.clockIn);
  const clockOut = useMutation(api.attendance.clockOut);
  const range = useRange();
  const history = useQuery(api.attendance.myHistory, {
    organizationId,
    from: range.from,
    to: range.to,
  });
  const now = useTick();
  const [siteChoice, setSiteChoice] = useState<Id<"sites"> | null>(null);
  const [busy, setBusy] = useState(false);
  // `null` = closed, `"new"` = add a missing entry, otherwise the entry to replace.
  const [correcting, setCorrecting] = useState<EventRow | "new" | null>(null);

  const siteId = siteChoice ?? status?.sites[0]?._id ?? null;
  const isIn = status?.status === "in";

  async function toggle() {
    if (!status) return;
    setBusy(true);
    try {
      if (isIn) {
        await clockOut({ organizationId });
        toast.success("Clocked out");
      } else if (siteId) {
        await clockIn({ organizationId, siteId });
        toast.success("Clocked in");
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const correctionSite =
    correcting && correcting !== "new" ? (correcting.siteId as Id<"sites">) : (status?.siteId as Id<"sites"> | null) ?? siteId;

  return (
    <>
      <PageHeader title="Attendance" description="Clock in and out, see your hours and ask for corrections." />

      <Card>
        <CardContent className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          {status === undefined ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <>
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-lg font-semibold">
                  {isIn ? "You are clocked in" : "You are clocked out"}
                  <Badge variant={isIn ? "default" : "secondary"}>{isIn ? "In" : "Out"}</Badge>
                </p>
                {isIn && status.since && (
                  <p className="text-sm text-muted-foreground">
                    Since {fmtDateTime(status.since, status.sites.find((s) => s._id === status.siteId)?.timeZone ?? "UTC")}
                    {status.siteName ? ` at ${status.siteName}` : ""} · {formatDuration(now - status.since)} so far
                  </p>
                )}
                {!isIn && status.sites.length > 1 && (
                  <NativeSelect
                    aria-label="Site"
                    className="w-48"
                    value={siteId ?? ""}
                    onChange={(e) => setSiteChoice(e.target.value as Id<"sites">)}
                  >
                    {status.sites.map((s) => (
                      <option key={s._id} value={s._id}>
                        {s.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
                {!isIn && status.sites.length === 0 && (
                  <p className="text-sm text-muted-foreground">You have no active site to clock in at.</p>
                )}
              </div>
              {status.canClock && (
                <Button
                  size="lg"
                  className="h-16 w-full px-10 text-lg sm:w-auto"
                  variant={isIn ? "secondary" : "default"}
                  disabled={busy || (!isIn && !siteId)}
                  onClick={toggle}
                >
                  {isIn ? <LogOut aria-hidden /> : <LogIn aria-hidden />}
                  {isIn ? "Clock out" : "Clock in"}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {correcting && correctionSite && (
        <CorrectionForm
          key={correcting === "new" ? "new" : correcting._id}
          siteId={correctionSite}
          original={correcting === "new" ? undefined : correcting}
          onDone={() => setCorrecting(null)}
        />
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">My hours</h2>
          <div className="flex gap-2">
            {range.picker}
            {!correcting && correctionSite && (
              <Button variant="outline" onClick={() => setCorrecting("new")}>
                Add a missing entry
              </Button>
            )}
          </div>
        </div>
        {history === undefined ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            {history.hasUnclosed && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                Some days have a clock-in with no clock-out and are not counted. Use &quot;Add a missing entry&quot;
                to request the clock-out time.
              </p>
            )}
            <DayList days={history.days} />
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Entries</h2>
        {history === undefined ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <EventList events={history.events} onCorrect={(e) => setCorrecting(e)} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">My correction requests</h2>
        {history === undefined ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <CorrectionList corrections={history.corrections} />
        )}
      </section>

      <PinCard />
      <NotificationPreferencesCard /> {/* N1 */}
    </>
  );
}
