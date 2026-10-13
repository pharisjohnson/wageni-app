import { v } from "convex/values";
import { walkInPurposeSchema } from "../lib/validation/visits";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { hasSiteAccess, requireSite } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { orgMutation, orgQuery, type OrgCtx } from "./lib/functions";
import { parseOrThrow } from "./lib/validate";
import { requireGate, requireHost, upsertVisitor } from "./lib/visitors";
import { addVisitEvent, admitAppointment, completeCheckOut, newBadgeCode, registerVisit } from "./lib/visits";

const MAX_LIST = 300;
const RECENT_MS = 4 * 60 * 60 * 1000;

const vVisitorInput = v.object({
  name: v.string(),
  phone: v.optional(v.string()),
  email: v.optional(v.string()),
  company: v.optional(v.string()),
});

/** Load a visit in the caller's organization and site access; otherwise NOT_FOUND. */
async function loadVisit(ctx: OrgCtx, visitId: Id<"visits">) {
  const visit = await ctx.db.get(visitId);
  if (!visit || visit.organizationId !== ctx.oc.org._id || !hasSiteAccess(ctx.oc.membership, visit.siteId)) {
    throw appError("NOT_FOUND");
  }
  return visit;
}

/** Visits currently on site (or awaiting admission) at the caller's accessible sites. */
export const listActive = orgQuery({
  args: { siteId: v.optional(v.id("sites")) },
  handler: async (ctx, { siteId }) => {
    ctx.require("visits:read_site");
    let siteIds: Id<"sites">[];
    if (siteId) {
      await requireSite(ctx, ctx.oc, siteId);
      siteIds = [siteId];
    } else {
      const sites = await ctx.db
        .query("sites")
        .withIndex("by_org", (q) => q.eq("organizationId", ctx.oc.org._id))
        .take(200);
      siteIds = sites.filter((s) => hasSiteAccess(ctx.oc.membership, s._id)).map((s) => s._id);
    }
    const rows: Doc<"visits">[] = [];
    for (const id of siteIds) {
      for (const status of ["expected", "on_site"] as const) {
        rows.push(
          ...(await ctx.db
            .query("visits")
            .withIndex("by_site_status", (q) => q.eq("siteId", id).eq("status", status))
            .take(MAX_LIST)),
        );
      }
    }
    return await Promise.all(
      rows.map(async (visit) => {
        const [visitor, host] = await Promise.all([
          ctx.db.get(visit.visitorId),
          visit.hostUserId ? ctx.db.get(visit.hostUserId) : null,
        ]);
        return {
          ...visit,
          visitorName: visitor?.name ?? "Unknown",
          hostName: host?.name ?? host?.email ?? null,
        };
      }),
    );
  },
});

/** Active (expected / on site) visits where the caller is the named host, within their site access. */
export const myVisitors = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("visits:check_out_own");
    const me = ctx.oc.user._id;
    const sites = await ctx.db
      .query("sites")
      .withIndex("by_org", (q) => q.eq("organizationId", ctx.oc.org._id))
      .take(200);
    const rows: Doc<"visits">[] = [];
    for (const site of sites.filter((s) => hasSiteAccess(ctx.oc.membership, s._id))) {
      for (const status of ["expected", "on_site"] as const) {
        const found = await ctx.db
          .query("visits")
          .withIndex("by_site_status", (q) => q.eq("siteId", site._id).eq("status", status))
          .take(MAX_LIST);
        rows.push(...found.filter((vis) => vis.hostUserId === me));
      }
    }
    return await Promise.all(
      rows.map(async (visit) => ({
        ...visit,
        visitorName: (await ctx.db.get(visit.visitorId))?.name ?? "Unknown",
      })),
    );
  },
});

/** Visits checked out in the last few hours, so gate staff can see who was cleared and by whom. */
export const recentCheckOuts = orgQuery({
  args: { siteId: v.id("sites"), withinMs: v.optional(v.number()) },
  handler: async (ctx, { siteId, withinMs }) => {
    ctx.require("visits:read_site");
    await requireSite(ctx, ctx.oc, siteId);
    const cutoff = Date.now() - Math.min(withinMs ?? RECENT_MS, 24 * 60 * 60 * 1000);
    const rows = await ctx.db
      .query("visits")
      .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "checked_out"))
      .order("desc")
      .take(100);
    return await Promise.all(
      rows
        .filter((visit) => (visit.checkedOutAt ?? 0) >= cutoff)
        .map(async (visit) => ({
          ...visit,
          visitorName: (await ctx.db.get(visit.visitorId))?.name ?? "Unknown",
        })),
    );
  },
});

/**
 * One visit with its event timeline. Site-wide readers see any visit at their
 * sites; a host with `visits:check_out_own` sees only visits they host.
 */
export const get = orgQuery({
  args: { visitId: v.id("visits") },
  handler: async (ctx, { visitId }) => {
    const visit = await loadVisit(ctx, visitId);
    const isOwnHosted = visit.hostUserId === ctx.oc.user._id && ctx.oc.permissions.has("visits:check_out_own");
    if (!ctx.oc.permissions.has("visits:read_site") && !isOwnHosted) throw appError("FORBIDDEN");
    const [visitor, host, events] = await Promise.all([
      ctx.db.get(visit.visitorId),
      visit.hostUserId ? ctx.db.get(visit.hostUserId) : null,
      ctx.db.query("visitEvents").withIndex("by_visit", (q) => q.eq("visitId", visitId)).take(100),
    ]);
    const timeline = await Promise.all(
      events.map(async (e) => {
        const [actor, device, gate] = await Promise.all([
          e.actorUserId ? ctx.db.get(e.actorUserId) : null,
          e.kioskDeviceId ? ctx.db.get(e.kioskDeviceId) : null,
          e.gateId ? ctx.db.get(e.gateId) : null,
        ]);
        const actorName = e.kioskDeviceId
          ? `Kiosk${device ? `: ${device.name}` : ""}`
          : (actor?.name ?? actor?.email ?? "Unknown");
        return { ...e, actorName, gateName: gate?.name ?? null };
      }),
    );
    return {
      ...visit,
      visitor,
      hostName: host ? (host.name ?? host.email ?? null) : null,
      events: timeline,
    };
  },
});

/** Admit a visitor with an approved appointment. */
export const checkInAppointment = orgMutation({
  args: { appointmentId: v.id("appointments"), gateId: v.id("gates") },
  handler: async (ctx, { appointmentId, gateId }) => {
    ctx.require("visits:check_in");
    const appt = await ctx.db.get(appointmentId);
    if (!appt || appt.organizationId !== ctx.oc.org._id || !hasSiteAccess(ctx.oc.membership, appt.siteId)) {
      throw appError("NOT_FOUND");
    }
    if (appt.status !== "approved") {
      throw appError("CONFLICT", "Only approved appointments can be checked in.");
    }
    await requireGate(ctx, ctx.oc, gateId, appt.siteId);
    const { visitId } = await admitAppointment(ctx, appt, gateId, { userId: ctx.oc.user._id });
    return visitId;
  },
});

/**
 * Register a walk-in. Anyone with `visitors:register_walk_in` creates an
 * `expected` visit; a user who can also check visitors in and supplies a gate
 * admits them at once.
 */
export const registerWalkIn = orgMutation({
  args: {
    siteId: v.id("sites"),
    visitor: vVisitorInput,
    purpose: v.string(),
    hostUserId: v.optional(v.id("users")),
    gateId: v.optional(v.id("gates")),
  },
  handler: async (ctx, { siteId, visitor, purpose, hostUserId, gateId }) => {
    ctx.require("visitors:register_walk_in");
    await requireSite(ctx, ctx.oc, siteId);
    const cleanPurpose = parseOrThrow(walkInPurposeSchema, purpose);
    if (hostUserId) await requireHost(ctx, ctx.oc, hostUserId, siteId);
    const admitNow = Boolean(gateId) && ctx.oc.permissions.has("visits:check_in");
    if (gateId) await requireGate(ctx, ctx.oc, gateId, siteId);
    const visitorId = await upsertVisitor(ctx, ctx.oc.org._id, visitor);
    return await registerVisit(
      ctx,
      {
        organizationId: ctx.oc.org._id,
        siteId,
        visitorId,
        hostUserId,
        purpose: cleanPurpose,
        admitGateId: admitNow ? gateId : undefined,
      },
      { userId: ctx.oc.user._id },
    );
  },
});

/** Admit a registered (expected) visitor at a gate. */
export const admit = orgMutation({
  args: { visitId: v.id("visits"), gateId: v.id("gates") },
  handler: async (ctx, { visitId, gateId }) => {
    ctx.require("visits:check_in");
    const visit = await loadVisit(ctx, visitId);
    if (visit.status !== "expected") throw appError("CONFLICT", "This visitor is not awaiting admission.");
    await requireGate(ctx, ctx.oc, gateId, visit.siteId);
    const now = Date.now();
    await ctx.db.patch(visitId, {
      status: "on_site",
      badgeCode: await newBadgeCode(ctx, visit.siteId),
      checkedInAt: now,
      checkedInGateId: gateId,
      updatedAt: now,
    });
    await addVisitEvent(ctx, visit, "checked_in", { userId: ctx.oc.user._id }, gateId);
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "visit.checked_in",
      resourceType: "visit",
      resourceId: visitId,
    });
  },
});

/** Shared check-out transition: status, appointment completion, events, audit. */
async function finishVisit(
  ctx: OrgCtx & MutationCtx,
  visit: Doc<"visits">,
  method: "host" | "gate" | "reception",
  gateId?: Id<"gates">,
) {
  await completeCheckOut(ctx, visit, method, { userId: ctx.oc.user._id }, gateId);
}

/**
 * Check a visitor out at a gate (guard) or from reception (no gate). Needs
 * `visits:check_out`, or `visits:check_out_own` for visits the caller hosts.
 */
export const checkOut = orgMutation({
  args: { visitId: v.id("visits"), gateId: v.optional(v.id("gates")) },
  handler: async (ctx, { visitId, gateId }) => {
    const visit = await loadVisit(ctx, visitId);
    const isOwn = visit.hostUserId === ctx.oc.user._id;
    const method = ctx.oc.permissions.has("visits:check_out")
      ? gateId
        ? "gate"
        : "reception"
      : ctx.oc.permissions.has("visits:check_out_own") && isOwn
        ? "host"
        : null;
    if (!method) throw appError("FORBIDDEN");
    if (visit.status !== "on_site") throw appError("CONFLICT", "This visitor is not on site.");
    if (gateId) await requireGate(ctx, ctx.oc, gateId, visit.siteId);
    await finishVisit(ctx, visit, method, gateId);
  },
});

/** A host ends the meeting and clears their own visitor to leave. */
export const hostCheckOut = orgMutation({
  args: { visitId: v.id("visits") },
  handler: async (ctx, { visitId }) => {
    ctx.require("visits:check_out_own");
    const visit = await loadVisit(ctx, visitId);
    if (visit.hostUserId !== ctx.oc.user._id) throw appError("FORBIDDEN");
    if (visit.status !== "on_site") throw appError("CONFLICT", "This visitor is not on site.");
    await finishVisit(ctx, visit, "host");
  },
});
