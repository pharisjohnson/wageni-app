import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { writeAudit } from "./audit";

/**
 * Visit lifecycle logic shared by the signed-in paths (convex/visits.ts) and
 * the self-service kiosk (convex/kioskVisitor.ts), so the two never diverge.
 *
 * Actor model: every visit event and audit entry records where the action
 * came from. A signed-in person is `{ userId }`; a paired kiosk is
 * `{ kioskDeviceId }` (the device, which maps to an org/site/gate). Events are
 * append-only, so the origin is fixed at write time and never reassigned.
 */
export type VisitActor = { userId: Id<"users"> } | { kioskDeviceId: Id<"kioskDevices"> };

export function actorFields(actor: VisitActor) {
  return "userId" in actor ? { actorUserId: actor.userId } : { kioskDeviceId: actor.kioskDeviceId };
}

export async function addVisitEvent(
  ctx: MutationCtx,
  visit: Pick<Doc<"visits">, "_id" | "organizationId" | "siteId">,
  type: Doc<"visitEvents">["type"],
  actor: VisitActor,
  gateId?: Id<"gates">,
) {
  await ctx.db.insert("visitEvents", {
    organizationId: visit.organizationId,
    siteId: visit.siteId,
    visitId: visit._id,
    type,
    ...actorFields(actor),
    gateId,
    at: Date.now(),
  });
}

/**
 * A 6-digit badge code, unique among the visits currently on site at the
 * site (a few retries; a collision is otherwise harmless because kiosk
 * check-out also needs the visitor's phone digits).
 */
export async function newBadgeCode(ctx: QueryCtx, siteId: Id<"sites">): Promise<string> {
  const onSite = await ctx.db
    .query("visits")
    .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "on_site"))
    .take(1000);
  const taken = new Set(onSite.map((v) => v.badgeCode));
  let code = "";
  for (let i = 0; i < 10; i++) {
    code = String(Math.floor(100000 + Math.random() * 900000));
    if (!taken.has(code)) break;
  }
  return code;
}

/**
 * Turn an approved appointment into an on-site visit: visit row, appointment
 * marked checked in, `checked_in` event, audit entry. Callers have already
 * authorised the actor and validated the appointment and gate.
 */
export async function admitAppointment(
  ctx: MutationCtx,
  appt: Doc<"appointments">,
  gateId: Id<"gates">,
  actor: VisitActor,
) {
  const now = Date.now();
  const badgeCode = await newBadgeCode(ctx, appt.siteId);
  const visitId = await ctx.db.insert("visits", {
    organizationId: appt.organizationId,
    siteId: appt.siteId,
    visitorId: appt.visitorId,
    appointmentId: appt._id,
    hostUserId: appt.hostUserId,
    purpose: appt.purpose,
    status: "on_site",
    badgeCode,
    checkedInAt: now,
    checkedInGateId: gateId,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(appt._id, { status: "checked_in", updatedAt: now });
  await addVisitEvent(
    ctx,
    { _id: visitId, organizationId: appt.organizationId, siteId: appt.siteId },
    "checked_in",
    actor,
    gateId,
  );
  await writeAudit(ctx, {
    organizationId: appt.organizationId,
    ...actorFields(actor),
    action: "visit.checked_in",
    resourceType: "visit",
    resourceId: visitId,
    metadata: "kioskDeviceId" in actor ? { origin: "kiosk", gateId } : undefined,
  });
  return { visitId, badgeCode };
}

/**
 * Register a walk-in visit. With `admitGateId` the visitor is admitted at once
 * (on site, badge issued); otherwise the visit is `expected` and waits for a
 * guard or receptionist to admit it. Callers authorise the actor and validate
 * the site, host and gate first.
 */
export async function registerVisit(
  ctx: MutationCtx,
  input: {
    organizationId: Id<"organizations">;
    siteId: Id<"sites">;
    visitorId: Id<"visitors">;
    hostUserId?: Id<"users">;
    purpose: string;
    admitGateId?: Id<"gates">;
    /** Gate the registration came from (kiosk), recorded on the event and audit entry. */
    originGateId?: Id<"gates">;
  },
  actor: VisitActor,
) {
  const now = Date.now();
  const { admitGateId } = input;
  const visitId = await ctx.db.insert("visits", {
    organizationId: input.organizationId,
    siteId: input.siteId,
    visitorId: input.visitorId,
    hostUserId: input.hostUserId,
    purpose: input.purpose,
    status: admitGateId ? "on_site" : "expected",
    badgeCode: admitGateId ? await newBadgeCode(ctx, input.siteId) : undefined,
    checkedInAt: admitGateId ? now : undefined,
    checkedInGateId: admitGateId,
    createdAt: now,
    updatedAt: now,
  });
  const ref = { _id: visitId, organizationId: input.organizationId, siteId: input.siteId };
  await addVisitEvent(ctx, ref, "registered", actor, input.originGateId);
  if (admitGateId) await addVisitEvent(ctx, ref, "checked_in", actor, admitGateId);
  await writeAudit(ctx, {
    organizationId: input.organizationId,
    ...actorFields(actor),
    action: "visit.walk_in_registered",
    resourceType: "visit",
    resourceId: visitId,
    metadata: input.originGateId ? { origin: "kiosk", gateId: input.originGateId } : undefined,
  });
  return visitId;
}

/** Check-out transition: status, appointment completion, events, audit. */
export async function completeCheckOut(
  ctx: MutationCtx,
  visit: Doc<"visits">,
  method: "host" | "gate" | "reception" | "kiosk",
  actor: VisitActor,
  gateId?: Id<"gates">,
) {
  const now = Date.now();
  await ctx.db.patch(visit._id, {
    status: "checked_out",
    checkedOutAt: now,
    checkedOutGateId: gateId,
    checkedOutMethod: method,
    updatedAt: now,
  });
  if (visit.appointmentId) {
    await ctx.db.patch(visit.appointmentId, { status: "completed", updatedAt: now });
  }
  // The host clearing the visitor is recorded as its own event, ahead of check-out.
  if (method === "host") await addVisitEvent(ctx, visit, "meeting_ended", actor);
  await addVisitEvent(ctx, visit, "checked_out", actor, gateId);
  await writeAudit(ctx, {
    organizationId: visit.organizationId,
    ...actorFields(actor),
    action: method === "host" ? "visit.host_checked_out" : "visit.checked_out",
    resourceType: "visit",
    resourceId: visit._id,
    metadata: gateId ? { method, gateId } : { method },
  });
}
