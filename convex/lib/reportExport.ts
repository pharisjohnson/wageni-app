import type { CsvCell } from "../../lib/csv";
import { formatLocal, visitDurationMs, type VisitRow } from "../../lib/reports/math";
import type { AppointmentRow, AttendancePerson } from "./reports";

/** Hard ceiling on rows in one export. Past it the file is cut and the user is told. */
export const EXPORT_ROW_CAP = 5000;

type Column<R> = {
  header: string;
  /** Contact details and anything from forms the caller may not read by default. */
  sensitive?: boolean;
  get: (row: R) => CsvCell;
};

export type Table = { headers: string[]; rows: CsvCell[][]; omittedSensitive: string[] };

function build<R>(columns: Column<R>[], rows: R[], includeSensitive: boolean): Table {
  const used = columns.filter((c) => includeSensitive || !c.sensitive);
  return {
    headers: used.map((c) => c.header),
    rows: rows.map((r) => used.map((c) => c.get(r))),
    omittedSensitive: includeSensitive ? [] : columns.filter((c) => c.sensitive).map((c) => c.header),
  };
}

const minutes = (ms: number | null) => (ms === null ? "" : Math.round(ms / 60_000));
const hours = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100;

type Tz = (siteId: string) => string;
type SiteName = (siteId: string) => string;

export function visitsTable(rows: VisitRow[], tz: Tz, site: SiteName, includeSensitive: boolean): Table {
  const at = (r: VisitRow, ts?: number) => (ts === undefined ? "" : formatLocal(ts, tz(r.siteId)));
  return build<VisitRow>(
    [
      { header: "Date", get: (r) => formatLocal(r.checkedInAt ?? r.createdAt, tz(r.siteId)).slice(0, 10) },
      { header: "Site", get: (r) => site(r.siteId) },
      { header: "Visitor", get: (r) => r.visitorName },
      { header: "Company", get: (r) => r.company ?? "" },
      { header: "Phone", sensitive: true, get: (r) => r.phone ?? "" },
      { header: "Email", sensitive: true, get: (r) => r.email ?? "" },
      { header: "Host", get: (r) => r.hostName ?? "" },
      { header: "Purpose", get: (r) => r.purpose },
      { header: "Type", get: (r) => (r.appointmentId ? "Appointment" : "Walk-in") },
      { header: "Status", get: (r) => r.status },
      { header: "Checked in", get: (r) => at(r, r.checkedInAt) },
      { header: "Meeting ended (host)", get: (r) => at(r, r.meetingEndedAt) },
      { header: "Checked out", get: (r) => at(r, r.checkedOutAt) },
      { header: "Duration (minutes)", get: (r) => minutes(visitDurationMs(r)) },
      { header: "Check-out method", get: (r) => r.checkedOutMethod ?? "" },
    ],
    rows,
    includeSensitive,
  );
}

export function onSiteTable(rows: VisitRow[], tz: Tz, site: SiteName, reference: number, includeSensitive: boolean): Table {
  return build<VisitRow>(
    [
      { header: "Site", get: (r) => site(r.siteId) },
      { header: "Visitor", get: (r) => r.visitorName },
      { header: "Company", get: (r) => r.company ?? "" },
      { header: "Phone", sensitive: true, get: (r) => r.phone ?? "" },
      { header: "Host", get: (r) => r.hostName ?? "" },
      { header: "Purpose", get: (r) => r.purpose },
      { header: "Checked in", get: (r) => (r.checkedInAt === undefined ? "" : formatLocal(r.checkedInAt, tz(r.siteId))) },
      { header: "On site (minutes)", get: (r) => (r.checkedInAt === undefined ? "" : Math.max(0, Math.round((reference - r.checkedInAt) / 60_000))) },
    ],
    rows,
    includeSensitive,
  );
}

export function appointmentsTable(rows: AppointmentRow[], tz: Tz, site: SiteName): Table {
  return build<AppointmentRow>(
    [
      { header: "Scheduled", get: (r) => formatLocal(r.scheduledStart, tz(r.siteId)) },
      { header: "Site", get: (r) => site(r.siteId) },
      { header: "Visitor", get: (r) => r.visitorName },
      { header: "Host", get: (r) => r.hostName ?? "" },
      { header: "Purpose", get: (r) => r.purpose },
      { header: "Status", get: (r) => r.status },
      { header: "Outcome", get: (r) => r.outcome },
    ],
    rows,
    false,
  );
}

export function hostMeetingsTable(rows: VisitRow[], tz: Tz, site: SiteName): Table {
  return build<VisitRow>(
    [
      { header: "Site", get: (r) => site(r.siteId) },
      { header: "Host", get: (r) => r.hostName ?? "" },
      { header: "Visitor", get: (r) => r.visitorName },
      { header: "Company", get: (r) => r.company ?? "" },
      { header: "Purpose", get: (r) => r.purpose },
      { header: "Checked in", get: (r) => (r.checkedInAt === undefined ? "" : formatLocal(r.checkedInAt, tz(r.siteId))) },
      { header: "Host confirmed meeting ended", get: (r) => (r.meetingEndedAt === undefined ? "" : formatLocal(r.meetingEndedAt, tz(r.siteId))) },
      { header: "Confirmed by", get: (r) => r.meetingConfirmedBy ?? "" },
      {
        header: "Meeting length (minutes)",
        get: (r) => (r.meetingEndedAt !== undefined && r.checkedInAt !== undefined ? minutes(r.meetingEndedAt - r.checkedInAt) : ""),
      },
    ],
    rows,
    false,
  );
}

type AttendanceDayRow = { person: AttendancePerson; day: AttendancePerson["days"][number] | null; absentDate?: string };

/** One row per person per day worked, plus one per absent weekday. */
export function attendanceTable(people: AttendancePerson[], timeZone: string): Table {
  const rows: AttendanceDayRow[] = [];
  for (const person of people) {
    for (const day of person.days) rows.push({ person, day });
    for (const absentDate of person.absentDates) rows.push({ person, day: null, absentDate });
  }
  rows.sort((a, b) =>
    a.person.name.localeCompare(b.person.name) || (a.day?.date ?? a.absentDate!).localeCompare(b.day?.date ?? b.absentDate!),
  );
  return build<AttendanceDayRow>(
    [
      { header: "Person", get: (r) => r.person.name },
      { header: "Date", get: (r) => r.day?.date ?? r.absentDate },
      { header: "Hours", get: (r) => (r.day ? hours(r.day.ms) : 0) },
      { header: "First clock-in", get: (r) => (r.day?.firstInAt ? formatLocal(r.day.firstInAt, timeZone) : "") },
      { header: "Late", get: (r) => (r.day ? r.day.late : "") },
      { header: "Absent", get: (r) => !r.day },
      { header: "Unclosed sessions (person total)", get: (r) => r.person.exceptions.unclosed },
      { header: "Clock-outs without clock-in (person total)", get: (r) => r.person.exceptions.orphanClockOuts },
      { header: "Approved corrections (person total)", get: (r) => r.person.corrections.approved },
    ],
    rows,
    false,
  );
}
