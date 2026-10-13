import { v } from "convex/values";
import { appointmentSchema } from "../lib/validation/visits";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hasSiteAccess, requireSite } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { orgMutation, orgQuery, type OrgCtx } from "./lib/functions";
import { parseOrThrow } from "./lib/validate";
import { requireHost, upsertVisitor } from "./lib/visitors";

const MAX_LIST = 200;

const vVisitorInput = v.object({
  name: v.string(),
  phone: v.optional(v.string()),
  email: v.optional(v.string()),
  company: v.optional(v.string()),
});

/** Load an appointment the caller may see: same org, accessible site, and (without site-wide read) their own. */
async function loadVisible(ctx: OrgCtx, appointmentId: Id<"appointments">) {
  const appt = await ctx.db.get(appointmentId);
  if (!appt || appt.organizationId !== ctx.oc.org._id || !hasSiteAccess(ctx.oc.membership, appt.siteId)) {
    throw appError("NOT_FOUND");
  }
  const me = ctx.oc.user._id;
  const own = appt.hostUserId === me || appt.createdBy === me;
  const canSee =
    ctx.oc.permissions.has("appointments:read_site") ||
    (ctx.oc.permissions.has("appointments:read_own") && own);
  if (!canSee) throw appError("NOT_FOUND");
  return appt;
}

export const list = orgQuery({
  args: { from: v.number(), to: v.number(), siteId: v.optional(v.id("sites")) },
  handler: async (ctx, { from, to, siteId }) => {
    const canSite = ctx.oc.permissions.has("appointments:read_site");
    if (!canSite) ctx.require("appointments:read_own");
    if (siteId) await requireSite(ctx, ctx.oc, siteId);
    const me = ctx.oc.user._id;
    const rows = await ctx.db
      .query("appointments")
      .withIndex("by_org_start", (q) =>
        q.eq("organizationId", ctx.oc.org._id).gte("scheduledStart", from).lt("scheduledStart", to),
      )
      .take(MAX_LIST);
    const visible = rows.filter(
      (a) =>
        hasSiteAccess(ctx.oc.membership, a.siteId) &&
        (!siteId || a.siteId === siteId) &&
        (canSite || a.hostUserId === me || a.createdBy === me),
    );
    return await Promise.all(
      visible.map(async (a) => {
        const [visitor, host] = await Promise.all([ctx.db.get(a.visitorId), ctx.db.get(a.hostUserId)]);
        return {
          ...a,
          visitorName: visitor?.name ?? "Unknown",
          hostName: host?.name ?? host?.email ?? "Unknown",
        };
      }),
    );
  },
});

export const get = orgQuery({
  args: { appointmentId: v.id("appointments") },
  handler: async (ctx, { appointmentId }) => {
    const appt = await loadVisible(ctx, appointmentId);
    const [visitor, host, decider, creator, visit] = await Promise.all([
      ctx.db.get(appt.visitorId),
      ctx.db.get(appt.hostUserId),
      appt.decidedBy ? ctx.db.get(appt.decidedBy) : null,
      ctx.db.get(appt.createdBy),
      ctx.db.query("visits").withIndex("by_appointment", (q) => q.eq("appointmentId", appointmentId)).first(),
    ]);
    const canSeeVisit = ctx.oc.permissions.has("visits:read_site") || visit?.hostUserId === ctx.oc.user._id;
    return {
      ...appt,
      visitor,
      hostName: host?.name ?? host?.email ?? "Unknown",
      decidedByName: decider ? (decider.name ?? decider.email ?? "Unknown") : null,
      createdByName: creator?.name ?? creator?.email ?? "Unknown",
      visitId: visit && canSeeVisit ? visit._id : null,
    };
  },
});

export const create = orgMutation({
  args: {
    siteId: v.id("sites"),
    hostUserId: v.id("users"),
    visitor: vVisitorInput,
    purpose: v.string(),
    scheduledStart: v.number(),
    scheduledEnd: v.number(),
  },
  handler: async (ctx, { siteId, hostUserId, visitor, ...rest }) => {
    ctx.require("appointments:create");
    await requireSite(ctx, ctx.oc, siteId);
    const input = parseOrThrow(appointmentSchema, rest);
    if (input.scheduledEnd <= Date.now()) {
      throw appError("VALIDATION", "Choose a time in the future.");
    }
    const me = ctx.oc.user._id;
    // Hosts book for themselves; booking for someone else needs site-wide scope (receptionist, admin).
    if (hostUserId !== me && !ctx.oc.permissions.has("appointments:read_site")) {
      throw appError("FORBIDDEN");
    }
    await requireHost(ctx, ctx.oc, hostUserId, siteId);
    const visitorId = await upsertVisitor(ctx, ctx.oc.org._id, visitor);
    const now = Date.now();
    // A host who can approve auto-approves their own bookings.
    const selfApproved = hostUserId === me && ctx.oc.permissions.has("appointments:approve");
    const id = await ctx.db.insert("appointments", {
      organizationId: ctx.oc.org._id,
      siteId,
      visitorId,
      hostUserId,
      purpose: input.purpose,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      status: selfApproved ? "approved" : "pending_approval",
      createdBy: me,
      decidedBy: selfApproved ? me : undefined,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: me,
      action: "appointment.created",
      resourceType: "appointment",
      resourceId: id,
    });
    await ctx.scheduler.runAfter(0, internal.notifications.onAppointmentEvent, { appointmentId: id, event: "requested", actorUserId: me }); // N1
    return id;
  },
});

export const decide = orgMutation({
  args: {
    appointmentId: v.id("appointments"),
    decision: v.union(v.literal("approved"), v.literal("declined")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { appointmentId, decision, note }) => {
    ctx.require("appointments:approve");
    const appt = await loadVisible(ctx, appointmentId);
    const me = ctx.oc.user._id;
    if (appt.hostUserId !== me && !ctx.oc.permissions.has("appointments:read_site")) {
      throw appError("FORBIDDEN");
    }
    if (appt.status !== "pending_approval") {
      throw appError("CONFLICT", "This appointment has already been decided.");
    }
    await ctx.db.patch(appointmentId, {
      status: decision,
      decidedBy: me,
      decisionNote: note?.trim().slice(0, 300) || undefined,
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: me,
      action: `appointment.${decision}`,
      resourceType: "appointment",
      resourceId: appointmentId,
    });
    await ctx.scheduler.runAfter(0, internal.notifications.onAppointmentEvent, { appointmentId, event: decision, actorUserId: me }); // N1
  },
});

export const cancel = orgMutation({
  args: { appointmentId: v.id("appointments") },
  handler: async (ctx, { appointmentId }) => {
    ctx.require("appointments:cancel");
    const appt = await loadVisible(ctx, appointmentId);
    if (appt.status !== "pending_approval" && appt.status !== "approved") {
      throw appError("CONFLICT", "This appointment can no longer be cancelled.");
    }
    await ctx.db.patch(appointmentId, { status: "cancelled", updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "appointment.cancelled",
      resourceType: "appointment",
      resourceId: appointmentId,
    });
    await ctx.scheduler.runAfter(0, internal.notifications.onAppointmentEvent, { appointmentId, event: "cancelled", actorUserId: ctx.oc.user._id }); // N1
  },
});

export const reschedule = orgMutation({
  args: { appointmentId: v.id("appointments"), scheduledStart: v.number(), scheduledEnd: v.number() },
  handler: async (ctx, { appointmentId, ...times }) => {
    ctx.require("appointments:update");
    const appt = await loadVisible(ctx, appointmentId);
    if (appt.status !== "pending_approval" && appt.status !== "approved") {
      throw appError("CONFLICT", "This appointment can no longer be changed.");
    }
    const input = parseOrThrow(appointmentSchema, { purpose: appt.purpose, ...times });
    await ctx.db.patch(appointmentId, {
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "appointment.rescheduled",
      resourceType: "appointment",
      resourceId: appointmentId,
    });
    await ctx.scheduler.runAfter(0, internal.notifications.onAppointmentEvent, { appointmentId, event: "rescheduled", actorUserId: ctx.oc.user._id }); // N1
  },
});

/**
 * People who can be named as a host at a site. Exposes only id and display name,
 * so booking works for roles that cannot list members.
 */
export const hostOptions = orgQuery({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    ctx.require("appointments:create");
    await requireSite(ctx, ctx.oc, siteId);
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("organizationId", ctx.oc.org._id))
      .take(500);
    const eligible = members.filter((m) => m.status === "active" && hasSiteAccess(m, siteId));
    const users = await Promise.all(eligible.map((m) => ctx.db.get(m.userId)));
    return users.flatMap((u) => (u ? [{ userId: u._id, name: u.name ?? u.email ?? "Unnamed" }] : []));
  },
});
