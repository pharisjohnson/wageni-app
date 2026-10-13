"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useActiveOrg } from "@/lib/org/active-org";
import { BarChart, BarList } from "./charts";
import {
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtTime,
  METHOD_LABELS,
  OUTCOME_LABELS,
  STATUS_LABELS,
} from "./format";
import { EmptyState, ExportButton, ReportSkeleton, ShowMore, StatCard, StatGrid, TruncatedNotice } from "./parts";

export type TabProps = {
  fromDate: string;
  toDate: string;
  siteId?: Id<"sites">;
  personId?: string;
};

const hostArg = (personId?: string) => (personId ? { hostUserId: personId as Id<"users"> } : {});

function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2">{children}</div>;
}

function useRowLimit() {
  const [limit, setLimit] = useState(100);
  return { limit, more: () => setLimit((l) => Math.min(500, l + 100)) };
}

// --- Visits -----------------------------------------------------------------

export function VisitsTab({ fromDate, toDate, siteId, personId }: TabProps) {
  const { organizationId } = useActiveOrg();
  const { limit, more } = useRowLimit();
  const data = useQuery(api.reports.visits, {
    organizationId,
    fromDate,
    toDate,
    ...(siteId ? { siteId } : {}),
    ...hostArg(personId),
    rowLimit: limit,
  });
  if (data === undefined) return <ReportSkeleton />;
  const s = data.summary;
  const manyDays = data.byDay.length > 31;
  return (
    <div className="space-y-5">
      <Toolbar>
        <ExportButton
          args={{ report: "visits", fromDate, toDate, siteId, hostUserId: personId as Id<"users"> | undefined }}
          disabled={s.total === 0}
        />
      </Toolbar>
      <TruncatedNotice truncated={data.truncated} cap={data.cap} />
      <StatGrid>
        <StatCard label="Visits" value={s.total} hint={`${s.arrived} arrived`} />
        <StatCard label="Average visit" value={fmtDuration(s.avgDurationMs)} hint={s.medianDurationMs !== null ? `Median ${fmtDuration(s.medianDurationMs)}` : "No completed visits yet"} />
        <StatCard label="Walk-ins / appointments" value={`${s.walkIns} / ${s.byAppointment}`} />
        <StatCard label="Appointment no-shows" value={data.noShows} hint={`${s.hostConfirmed} meetings confirmed by host`} />
      </StatGrid>
      {s.total === 0 ? (
        <EmptyState title="No visits in this range">Try a wider date range or a different site.</EmptyState>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="pt-4">
                <BarChart
                  title="Visits by day"
                  data={data.byDay.map((d) => ({ label: manyDays ? d.date.slice(8) : fmtDate(d.date).slice(0, 6), value: d.count }))}
                  labelEvery={manyDays ? 5 : 1}
                />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <BarChart
                  title="Busiest hours (site local time)"
                  data={data.byHour.map((h) => ({ label: String(h.hour), value: h.count }))}
                  labelEvery={3}
                />
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardContent className="pt-4">
                <BarList title="By purpose" rows={data.byPurpose.map((p) => ({ key: p.key, label: p.label, count: p.count, note: p.avgDurationMs ? fmtDuration(p.avgDurationMs) : undefined }))} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <BarList title="By host" rows={data.byHost.map((h) => ({ key: h.key, label: h.label, count: h.count, note: h.avgDurationMs ? fmtDuration(h.avgDurationMs) : undefined }))} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 space-y-5">
                <BarList title="By site" rows={data.bySite.map((x) => ({ key: x.key, label: x.label, count: x.count }))} />
                <BarList title="By status" rows={data.byStatus.map((x) => ({ key: x.key, label: STATUS_LABELS[x.label] ?? x.label, count: x.count }))} />
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Visits</CardTitle>
              <CardDescription>Newest first. Times are in each site&apos;s time zone.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Arrived</TableHead>
                    <TableHead>Visitor</TableHead>
                    <TableHead>Host</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{fmtDateTime(r.checkedInAt ?? r.createdAt, r.timeZone)}</TableCell>
                      <TableCell>
                        <Link href={`/app/visits/${r.id}`} className="font-medium hover:underline">
                          {r.visitorName}
                        </Link>
                        {r.company && <span className="block text-xs text-muted-foreground">{r.company}</span>}
                      </TableCell>
                      <TableCell>{r.hostName ?? "–"}</TableCell>
                      <TableCell>{r.purpose}</TableCell>
                      <TableCell>{r.siteName}</TableCell>
                      <TableCell>{r.kind === "appointment" ? "Appointment" : "Walk-in"}</TableCell>
                      <TableCell>
                        <Badge variant={r.status === "on_site" ? "default" : "secondary"}>{STATUS_LABELS[r.status]}</Badge>
                        {r.method && <span className="ml-1 text-xs text-muted-foreground">{METHOD_LABELS[r.method] ?? r.method}</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtDuration(r.durationMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ShowMore shown={data.rows.length} total={data.rowsTotal} limit={limit} onMore={more} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// --- On site now / at a time -------------------------------------------------

export function OnSiteTab({ siteId }: TabProps) {
  const { organizationId } = useActiveOrg();
  const [atText, setAtText] = useState("");
  // Validated when the value changes (not during render) so a bad value never reaches the query.
  const [validAt, setValidAt] = useState<number | undefined>(undefined);
  const bad = atText !== "" && validAt === undefined;
  function changeAt(text: string) {
    setAtText(text);
    const ms = text ? new Date(text).getTime() : Number.NaN;
    setValidAt(Number.isFinite(ms) && ms <= Date.now() ? ms : undefined);
  }
  const data = useQuery(api.reports.onSite, { organizationId, ...(siteId ? { siteId } : {}), ...(validAt !== undefined ? { at: validAt } : {}) });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Label htmlFor="onsite-at">Look back to a past time (optional)</Label>
          <div className="flex gap-2">
            <Input id="onsite-at" type="datetime-local" value={atText} onChange={(e) => changeAt(e.target.value)} className="w-56" />
            {atText && (
              <Button variant="ghost" onClick={() => changeAt("")}>
                Back to now
              </Button>
            )}
          </div>
          {bad && (
            <p role="alert" className="text-sm text-destructive">
              Choose a time that is not in the future.
            </p>
          )}
          <p className="text-xs text-muted-foreground">Past times use your browser&apos;s time zone.</p>
        </div>
        <ExportButton args={{ report: "on_site", siteId, at: validAt }} disabled={!data || data.rows.length === 0} />
      </div>
      {data === undefined ? (
        <ReportSkeleton />
      ) : (
        <>
          <TruncatedNotice truncated={data.truncated} cap={data.cap} />
          <StatGrid>
            <StatCard label={data.historical ? "On site at that time" : "On site now"} value={data.rows.length} hint={data.historical ? fmtDateTime(data.asOf, "UTC") + " UTC" : undefined} />
          </StatGrid>
          {data.rows.length === 0 ? (
            <EmptyState title={data.historical ? "Nobody was on site at that time" : "Nobody is on site right now"} />
          ) : (
            <Card>
              <CardContent className="pt-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Visitor</TableHead>
                      <TableHead>Host</TableHead>
                      <TableHead>Purpose</TableHead>
                      <TableHead>Site</TableHead>
                      <TableHead>Arrived</TableHead>
                      <TableHead className="text-right">On site for</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <Link href={`/app/visits/${r.id}`} className="font-medium hover:underline">
                            {r.visitorName}
                          </Link>
                          {r.company && <span className="block text-xs text-muted-foreground">{r.company}</span>}
                        </TableCell>
                        <TableCell>{r.hostName ?? "–"}</TableCell>
                        <TableCell>{r.purpose}</TableCell>
                        <TableCell>{r.siteName}</TableCell>
                        <TableCell>{fmtDateTime(r.checkedInAt, r.timeZone)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtDuration(r.onSiteMs)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// --- Appointment outcomes ----------------------------------------------------

export function AppointmentsTab({ fromDate, toDate, siteId, personId }: TabProps) {
  const { organizationId } = useActiveOrg();
  const { limit, more } = useRowLimit();
  const data = useQuery(api.reports.appointments, { organizationId, fromDate, toDate, ...(siteId ? { siteId } : {}), ...hostArg(personId), rowLimit: limit });
  if (data === undefined) return <ReportSkeleton />;
  const order = ["attended", "no_show", "upcoming", "pending", "lapsed", "declined", "cancelled"];
  return (
    <div className="space-y-5">
      <Toolbar>
        <ExportButton args={{ report: "appointments", fromDate, toDate, siteId, hostUserId: personId as Id<"users"> | undefined }} disabled={data.total === 0} />
      </Toolbar>
      <TruncatedNotice truncated={data.truncated} />
      <StatGrid>
        <StatCard label="Appointments" value={data.total} />
        <StatCard label="Attended" value={data.counts.attended ?? 0} />
        <StatCard label="No-shows" value={data.counts.no_show ?? 0} />
        <StatCard label="Show-up rate" value={data.attendanceRate === null ? "–" : `${Math.round(data.attendanceRate * 100)}%`} hint="Attended out of attended + no-show" />
      </StatGrid>
      {data.total === 0 ? (
        <EmptyState title="No appointments in this range" />
      ) : (
        <>
          <Card>
            <CardContent className="pt-4">
              <BarList title="Outcomes" rows={order.filter((k) => data.counts[k]).map((k) => ({ key: k, label: OUTCOME_LABELS[k]!, count: data.counts[k]! }))} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3 pt-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Visitor</TableHead>
                    <TableHead>Host</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Site</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{fmtDateTime(r.scheduledStart, r.timeZone)}</TableCell>
                      <TableCell>
                        <Link href={`/app/appointments/${r.id}`} className="font-medium hover:underline">
                          {r.visitorName}
                        </Link>
                      </TableCell>
                      <TableCell>{r.hostName ?? "–"}</TableCell>
                      <TableCell>{r.purpose}</TableCell>
                      <TableCell>{r.siteName}</TableCell>
                      <TableCell>
                        <Badge variant={r.outcome === "no_show" ? "destructive" : "secondary"}>{OUTCOME_LABELS[r.outcome]}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ShowMore shown={data.rows.length} total={data.total} limit={limit} onMore={more} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// --- Host meeting proof ------------------------------------------------------

export function HostMeetingsTab({ fromDate, toDate, siteId, personId }: TabProps) {
  const { organizationId } = useActiveOrg();
  const { limit, more } = useRowLimit();
  const data = useQuery(api.reports.hostMeetings, { organizationId, fromDate, toDate, ...(siteId ? { siteId } : {}), ...hostArg(personId), rowLimit: limit });
  if (data === undefined) return <ReportSkeleton />;
  return (
    <div className="space-y-5">
      <Toolbar>
        <ExportButton args={{ report: "host_meetings", fromDate, toDate, siteId, hostUserId: personId as Id<"users"> | undefined }} disabled={data.total === 0} />
      </Toolbar>
      <TruncatedNotice truncated={data.truncated} />
      <StatGrid>
        <StatCard label="Meetings with a host" value={data.total} />
        <StatCard label="Confirmed by host" value={data.confirmed} hint="Host marked the meeting as done" />
        <StatCard label="Not confirmed" value={data.total - data.confirmed} hint="Visitor was cleared by someone else" />
      </StatGrid>
      {data.total === 0 ? (
        <EmptyState title="No hosted meetings in this range" />
      ) : (
        <Card>
          <CardContent className="space-y-3 pt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Host</TableHead>
                  <TableHead>Met with</TableHead>
                  <TableHead>Purpose</TableHead>
                  <TableHead>Arrived</TableHead>
                  <TableHead>Host confirmed</TableHead>
                  <TableHead className="text-right">Meeting length</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.hostName ?? "–"}</TableCell>
                    <TableCell>
                      <Link href={`/app/visits/${r.id}`} className="hover:underline">
                        {r.visitorName}
                      </Link>
                      {r.company && <span className="block text-xs text-muted-foreground">{r.company}</span>}
                    </TableCell>
                    <TableCell>{r.purpose}</TableCell>
                    <TableCell>{fmtDateTime(r.checkedInAt, r.timeZone)}</TableCell>
                    <TableCell>
                      {r.confirmedAt ? (
                        <>
                          {fmtDateTime(r.confirmedAt, r.timeZone)}
                          {r.confirmedBy && <span className="block text-xs text-muted-foreground">by {r.confirmedBy}</span>}
                        </>
                      ) : (
                        <Badge variant="outline">Not confirmed</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtDuration(r.meetingMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ShowMore shown={data.rows.length} total={data.total} limit={limit} onMore={more} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// --- Attendance --------------------------------------------------------------

export function AttendanceTab({ fromDate, toDate, siteId, personId }: TabProps) {
  const { organizationId } = useActiveOrg();
  const [selected, setSelected] = useState<string | null>(null);
  const userId = (selected ?? personId) as Id<"users"> | undefined;
  const data = useQuery(api.reports.attendance, { organizationId, fromDate, toDate, ...(siteId ? { siteId } : {}), ...(userId ? { userId } : {}) });
  if (data === undefined) return <ReportSkeleton />;
  const t = data.totals;
  const person = selected ? data.people[0] : null;

  return (
    <div className="space-y-5">
      {selected && (
        <Button variant="ghost" size="sm" onClick={() => setSelected(null)} className="-ml-2">
          <ArrowLeft aria-hidden /> Back to all people
        </Button>
      )}
      <Toolbar>
        <ExportButton args={{ report: "attendance", fromDate, toDate, siteId, userId }} disabled={t.people === 0} />
      </Toolbar>
      <TruncatedNotice truncated={data.truncated} />
      <StatGrid>
        <StatCard label="People" value={t.people} />
        <StatCard label="Hours worked" value={fmtDuration(t.totalMs)} />
        <StatCard label="Late arrivals / absent days" value={`${t.late} / ${t.absent}`} hint="Late: first clock-in after 09:00 on a weekday. Absent: a weekday with no clock-in." />
        <StatCard label="Exceptions / corrections" value={`${t.exceptions} / ${t.corrections}`} hint="Unclosed sessions and stray clock-outs / corrections requested" />
      </StatGrid>
      {t.people === 0 ? (
        <EmptyState title="No staff to report on for this selection" />
      ) : person ? (
        <Card>
          <CardHeader>
            <CardTitle>{person.name}</CardTitle>
            <CardDescription>
              Hours per day, {fmtDate(fromDate)} to {fmtDate(toDate)}.{" "}
              <Link href={`/app/staff/${person.userId}`} className="underline">
                Open attendance record
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {person.days.length > 0 && (
              <BarChart title="Hours per day" unit="hours" data={person.days.map((d) => ({ label: d.date.slice(8), value: Math.round((d.ms / 3_600_000) * 10) / 10 }))} />
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>First clock-in</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[
                  ...person.days.map((d) => ({ date: d.date, first: d.firstInAt, ms: d.ms as number | null, late: d.late, absent: false })),
                  ...person.absentDates.map((date) => ({ date, first: null, ms: null, late: false, absent: true })),
                ]
                  .sort((a, b) => (a.date < b.date ? -1 : 1))
                  .map((d) => (
                    <TableRow key={d.date}>
                      <TableCell>{fmtDate(d.date)}</TableCell>
                      <TableCell>{fmtTime(d.first, data.range.timeZone)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtDuration(d.ms)}</TableCell>
                      <TableCell>
                        {d.late && <Badge variant="destructive">Late</Badge>}
                        {d.absent && <Badge variant="outline">Absent</Badge>}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead className="text-right">Days worked</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead className="text-right">Late</TableHead>
                  <TableHead className="text-right">Absent</TableHead>
                  <TableHead className="text-right">Exceptions</TableHead>
                  <TableHead className="text-right">Corrections</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.people.map((p) => {
                  const ex = p.exceptions.unclosed + p.exceptions.orphanClockOuts + (p.exceptions.staleOpen ? 1 : 0);
                  return (
                    <TableRow key={p.userId}>
                      <TableCell>
                        <button type="button" onClick={() => setSelected(p.userId)} className="font-medium hover:underline">
                          {p.name}
                        </button>
                        {p.exceptions.stillIn && <Badge variant="secondary" className="ml-2">In now</Badge>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{p.daysWorked}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtDuration(p.totalMs)}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.lateCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.absentCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{ex}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.corrections.approved + p.corrections.pending}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
