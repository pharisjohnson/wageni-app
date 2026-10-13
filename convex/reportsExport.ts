import { v } from "convex/values";
import { toCsv } from "../lib/csv";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { orgMutation } from "./lib/functions";
import {
  appointmentsTable,
  attendanceTable,
  EXPORT_ROW_CAP,
  hostMeetingsTable,
  onSiteTable,
  visitsTable,
  type Table,
} from "./lib/reportExport";
import {
  loadAppointmentRows,
  loadAttendance,
  loadOnSite,
  loadVisitRows,
  rangeOrThrow,
  reportScope,
  siteName,
  siteTz,
} from "./lib/reports";

const vReportKind = v.union(
  v.literal("visits"),
  v.literal("on_site"),
  v.literal("appointments"),
  v.literal("attendance"),
  v.literal("host_meetings"),
);

/**
 * Permission to see sensitive columns (and, with Phase 4, sensitive form
 * answers). Checked by name so this file does not depend on the forms module;
 * until `forms:read_sensitive` exists no role holds it and requests for
 * sensitive columns are refused.
 */
export const SENSITIVE_PERMISSION = "forms:read_sensitive";

/**
 * Build a CSV for a report. A mutation (not a query) because every export is
 * audit-logged in the same transaction: who, which report, the filters, and
 * the row count. Sensitive columns are excluded unless the caller asks for
 * them AND holds the sensitive-data permission.
 */
export const csv = orgMutation({
  args: {
    report: vReportKind,
    fromDate: v.optional(v.string()),
    toDate: v.optional(v.string()),
    siteId: v.optional(v.id("sites")),
    hostUserId: v.optional(v.id("users")),
    userId: v.optional(v.id("users")),
    /** on_site only: a past instant for the historical register. */
    at: v.optional(v.number()),
    includeSensitive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    ctx.require("reports:read");
    ctx.require("reports:export");
    if (args.report === "attendance") ctx.require("staff_attendance:read_site");

    const includeSensitive = args.includeSensitive === true;
    if (includeSensitive && !(ctx.oc.permissions as ReadonlySet<string>).has(SENSITIVE_PERMISSION)) {
      throw appError("FORBIDDEN", "You do not have permission to export sensitive fields.");
    }

    const scope = await reportScope(ctx, args.siteId);
    const tz = (id: string) => siteTz(scope, id);
    const site = (id: string) => siteName(scope, id);
    const now = Date.now();

    let table: Table;
    let sourceTruncated = false;
    let dates: { fromDate: string; toDate: string } | null = null;
    if (args.report === "on_site") {
      if (args.at !== undefined && (!Number.isFinite(args.at) || args.at > now + 5 * 60_000)) {
        throw appError("VALIDATION", "Choose a time that is not in the future.");
      }
      const loaded = await loadOnSite(ctx, scope, args.at);
      sourceTruncated = loaded.truncated;
      table = onSiteTable(loaded.rows, tz, site, args.at ?? now, includeSensitive);
    } else {
      if (!args.fromDate || !args.toDate) throw appError("VALIDATION", "Choose a date range.");
      const range = rangeOrThrow(scope, args.fromDate, args.toDate, args.report === "attendance" ? 62 : undefined);
      dates = { fromDate: range.fromDate, toDate: range.toDate };
      if (args.report === "visits" || args.report === "host_meetings") {
        const loaded = await loadVisitRows(ctx, scope, range, { hostUserId: args.hostUserId });
        sourceTruncated = loaded.truncated;
        table =
          args.report === "visits"
            ? visitsTable(loaded.rows, tz, site, includeSensitive)
            : hostMeetingsTable(
                loaded.rows.filter((r) => r.hostUserId && r.checkedInAt !== undefined),
                tz,
                site,
              );
      } else if (args.report === "appointments") {
        const loaded = await loadAppointmentRows(ctx, scope, range, { hostUserId: args.hostUserId });
        sourceTruncated = loaded.truncated;
        table = appointmentsTable(loaded.rows, tz, site);
      } else {
        const loaded = await loadAttendance(ctx, scope, range, { userId: args.userId });
        sourceTruncated = loaded.truncated;
        table = attendanceTable(loaded.people, scope.timeZone);
      }
    }

    const rowCapped = table.rows.length > EXPORT_ROW_CAP;
    const rows = rowCapped ? table.rows.slice(0, EXPORT_ROW_CAP) : table.rows;
    const truncated = rowCapped || sourceTruncated;
    const message = truncated
      ? `The export was limited to the first ${rows.length} rows. Narrow the date range or filters to get everything.`
      : null;

    const filters: Record<string, string | number | boolean> = {};
    if (dates) {
      filters.fromDate = dates.fromDate;
      filters.toDate = dates.toDate;
    }
    if (args.siteId) filters.siteId = args.siteId;
    if (args.hostUserId) filters.hostUserId = args.hostUserId;
    if (args.userId) filters.userId = args.userId;
    if (args.at !== undefined) filters.at = args.at;
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "report.exported",
      resourceType: "report",
      resourceId: args.report,
      metadata: {
        ...filters,
        rowCount: rows.length,
        truncated,
        includeSensitive,
        omittedColumns: table.omittedSensitive.join("|"),
      },
    });

    const stamp = new Date(now).toISOString().slice(0, 10);
    return {
      filename: `wageni-${args.report.replace(/_/g, "-")}-${dates ? `${dates.fromDate}_to_${dates.toDate}` : stamp}.csv`,
      csv: toCsv(table.headers, rows),
      rowCount: rows.length,
      truncated,
      message,
      omittedColumns: table.omittedSensitive,
    };
  },
});
