import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { fieldsOf } from "./lib/formResponses";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { orgMutation } from "./lib/functions";
import { clampPagination } from "./lib/validate";

/**
 * Data-subject and tenant data tooling (H1), for Kenya Data Protection Act
 * 2019 access and erasure requests and for tenant offboarding.
 *
 * Both functions are `orgMutation`s so the audit entry commits with the work,
 * need `organization:manage` (owner and, by default, nobody else with
 * delete-level power) and only ever touch the caller's organization.
 *
 * `exportChunk`  - cursor-paged JSON export, one table per call, at most
 *                  100 rows a call. Contact details need `forms:read_sensitive`
 *                  as well; answers to sensitive fields, files, PIN data,
 *                  device and invitation tokens are never included.
 * `eraseVisitor` - anonymise one visitor everywhere a name or number can live:
 *                  the visitor row, their visits and appointments (free text),
 *                  and their form answers. Uploaded files are scheduled for
 *                  deletion by the daily file job. Refuses while the person is
 *                  on site, expected or has an upcoming appointment.
 */

export const EXPORT_TABLES = [
  "sites",
  "gates",
  "members",
  "visitors",
  "visits",
  "appointments",
  "attendance",
  "audit",
  "formResponses",
] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

const vExportTable = v.union(...EXPORT_TABLES.map((t) => v.literal(t)));

const ERASED_TEXT = "Erased on request";
export const ERASED_NAME = "Anonymised visitor";
const ERASE_BATCH = 100;

function requireDataRights(ctx: { require: (p: "organization:manage" | "reports:export") => void }) {
  ctx.require("organization:manage");
  ctx.require("reports:export");
}

export const exportChunk = orgMutation({
  args: {
    table: vExportTable,
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { table, cursor, limit }) => {
    requireDataRights(ctx);
    const orgId = ctx.oc.org._id;
    const numItems = clampPagination({ numItems: Math.floor(limit ?? 100) }).numItems;
    const opts = { numItems, cursor: cursor ?? null };
    const withContact = ctx.oc.permissions.has("forms:read_sensitive");

    let page: { page: Record<string, unknown>[]; continueCursor: string; isDone: boolean };
    switch (table) {
      case "sites": {
        const r = await ctx.db.query("sites").withIndex("by_org", (q) => q.eq("organizationId", orgId)).paginate(opts);
        page = { ...r, page: r.page };
        break;
      }
      case "gates": {
        const r = await ctx.db.query("gates").withIndex("by_org", (q) => q.eq("organizationId", orgId)).paginate(opts);
        page = { ...r, page: r.page };
        break;
      }
      case "members": {
        const r = await ctx.db
          .query("memberships")
          .withIndex("by_org", (q) => q.eq("organizationId", orgId))
          .paginate(opts);
        const rows = [];
        for (const m of r.page) {
          const user = await ctx.db.get(m.userId);
          rows.push({ ...m, name: user?.name ?? null, email: withContact ? (user?.email ?? null) : undefined });
        }
        page = { ...r, page: rows };
        break;
      }
      case "visitors": {
        const r = await ctx.db
          .query("visitors")
          .withIndex("by_org", (q) => q.eq("organizationId", orgId))
          .paginate(opts);
        page = {
          ...r,
          page: r.page.map((x) => (withContact ? x : { ...x, phone: undefined, email: undefined })),
        };
        break;
      }
      case "visits": {
        const r = await ctx.db
          .query("visits")
          .withIndex("by_org", (q) => q.eq("organizationId", orgId))
          .paginate(opts);
        const rows = [];
        for (const visit of r.page) {
          const events = await ctx.db
            .query("visitEvents")
            .withIndex("by_visit", (q) => q.eq("visitId", visit._id))
            .take(50);
          rows.push({ ...visit, events });
        }
        page = { ...r, page: rows };
        break;
      }
      case "appointments": {
        const r = await ctx.db
          .query("appointments")
          .withIndex("by_org_start", (q) => q.eq("organizationId", orgId))
          .paginate(opts);
        page = { ...r, page: r.page };
        break;
      }
      case "attendance": {
        const r = await ctx.db
          .query("attendanceEvents")
          .withIndex("by_user_at", (q) => q.eq("organizationId", orgId))
          .paginate(opts);
        page = { ...r, page: r.page };
        break;
      }
      case "audit": {
        const r = await ctx.db
          .query("auditLogs")
          .withIndex("by_org_at", (q) => q.eq("organizationId", orgId))
          .paginate(opts);
        page = { ...r, page: r.page };
        break;
      }
      case "formResponses": {
        const r = await ctx.db
          .query("formResponses")
          .withIndex("by_org_user", (q) => q.eq("organizationId", orgId))
          .paginate(opts);
        const sensitiveByVersion = new Map<Id<"formVersions">, Set<string> | null>();
        const rows = [];
        for (const resp of r.page) {
          if (!sensitiveByVersion.has(resp.formVersionId)) {
            const version = await ctx.db.get(resp.formVersionId);
            sensitiveByVersion.set(
              resp.formVersionId,
              version && version.organizationId === orgId
                ? new Set(fieldsOf(version).filter((f) => f.sensitive).map((f) => f.id))
                : null,
            );
          }
          const sensitive = sensitiveByVersion.get(resp.formVersionId);
          const answers: Record<string, unknown> = {};
          for (const [id, value] of Object.entries(resp.answers)) {
            const isFile = typeof value === "object" && value !== null && !Array.isArray(value) && "fileId" in value;
            answers[id] = !sensitive || sensitive.has(id) || isFile ? "[withheld]" : value;
          }
          rows.push({ ...resp, answers });
        }
        page = { ...r, page: rows };
        break;
      }
    }

    await writeAudit(ctx, {
      organizationId: orgId,
      actorUserId: ctx.oc.user._id,
      action: "organization.data_exported",
      resourceType: "organization",
      resourceId: orgId,
      metadata: { table, rows: page.page.length, contact: withContact, done: page.isDone },
    });
    return { table, rows: page.page, nextCursor: page.isDone ? null : page.continueCursor, done: page.isDone };
  },
});

function tombstoned(answers: Doc<"formResponses">["answers"]) {
  return Object.fromEntries(Object.keys(answers).map((k) => [k, { redacted: true as const }]));
}

export const eraseVisitor = orgMutation({
  args: { visitorId: v.id("visitors") },
  handler: async (ctx, { visitorId }) => {
    requireDataRights(ctx);
    const orgId = ctx.oc.org._id;
    const visitor = await ctx.db.get(visitorId);
    if (!visitor || visitor.organizationId !== orgId) throw appError("NOT_FOUND");
    if (visitor.anonymisedAt !== undefined) return { done: true as const, visits: 0, appointments: 0, responses: 0 };

    const now = Date.now();
    const visits = await ctx.db
      .query("visits")
      .withIndex("by_visitor", (q) => q.eq("visitorId", visitorId))
      .take(500);
    if (visits.some((x) => x.organizationId === orgId && x.status !== "checked_out")) {
      throw appError("CONFLICT", "This visitor is on site or expected. Check them out or cancel first.");
    }
    const appointments = await ctx.db
      .query("appointments")
      .withIndex("by_visitor", (q) => q.eq("visitorId", visitorId))
      .take(500);
    if (
      appointments.some(
        (a) =>
          a.organizationId === orgId &&
          (a.status === "approved" || a.status === "pending_approval") &&
          a.scheduledEnd >= now,
      )
    ) {
      throw appError("CONFLICT", "This visitor has an upcoming appointment. Cancel it first.");
    }

    // Work in bounded batches; the visitor row is anonymised last, so a
    // repeat call picks up whatever is left.
    let touchedVisits = 0;
    let touchedAppointments = 0;
    let touchedResponses = 0;
    const redactResponse = async (row: Doc<"formResponses">) => {
      for (const a of Object.values(row.answers)) {
        if (typeof a === "object" && a !== null && !Array.isArray(a) && "fileId" in a) {
          const file = await ctx.db.get(a.fileId);
          if (file && file.organizationId === orgId && file.status !== "deleted") {
            await ctx.db.patch(file._id, { deleteAfter: now });
          }
        }
      }
      await ctx.db.patch(row._id, { answers: tombstoned(row.answers) });
      touchedResponses++;
    };

    const isRedacted = (row: Doc<"formResponses">) =>
      Object.values(row.answers).every((a) => typeof a === "object" && a !== null && !Array.isArray(a) && "redacted" in a);
    let budget = ERASE_BATCH;
    let more = false;
    for (const visit of visits) {
      if (visit.organizationId !== orgId) continue;
      const responses = await ctx.db
        .query("formResponses")
        .withIndex("by_visit", (q) => q.eq("visitId", visit._id))
        .take(20);
      const pending = responses.filter((r) => r.organizationId === orgId && !isRedacted(r));
      const dirty = visit.purpose !== ERASED_TEXT || visit.badgeCode !== undefined;
      if (pending.length === 0 && !dirty) continue;
      if (budget <= 0) {
        more = true;
        continue;
      }
      for (const r of pending) await redactResponse(r);
      if (dirty) {
        await ctx.db.patch(visit._id, { badgeCode: undefined, purpose: ERASED_TEXT, anonymisedAt: visit.anonymisedAt ?? now, updatedAt: now });
        touchedVisits++;
      }
      budget--;
    }
    for (const appt of appointments) {
      if (appt.organizationId !== orgId) continue;
      const responses = await ctx.db
        .query("formResponses")
        .withIndex("by_appointment", (q) => q.eq("appointmentId", appt._id))
        .take(20);
      const pending = responses.filter((r) => r.organizationId === orgId && !isRedacted(r));
      const dirty = appt.purpose !== ERASED_TEXT || appt.decisionNote !== undefined;
      if (pending.length === 0 && !dirty) continue;
      if (budget <= 0) {
        more = true;
        continue;
      }
      for (const r of pending) await redactResponse(r);
      if (dirty) {
        await ctx.db.patch(appt._id, { purpose: ERASED_TEXT, decisionNote: undefined, updatedAt: now });
        touchedAppointments++;
      }
      budget--;
    }

    const done = !more && visits.length < 500 && appointments.length < 500;
    if (done) {
      await ctx.db.patch(visitorId, {
        name: ERASED_NAME,
        phone: undefined,
        email: undefined,
        company: undefined,
        anonymisedAt: now,
        updatedAt: now,
      });
    }
    await writeAudit(ctx, {
      organizationId: orgId,
      actorUserId: ctx.oc.user._id,
      action: "visitor.erased",
      resourceType: "visitor",
      resourceId: visitorId,
      metadata: { visits: touchedVisits, appointments: touchedAppointments, responses: touchedResponses, done },
    });
    return { done, visits: touchedVisits, appointments: touchedAppointments, responses: touchedResponses };
  },
});
