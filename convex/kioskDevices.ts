import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { requireSite } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { orgMutation, orgQuery } from "./lib/functions";
import { generateKioskToken, hashKioskToken } from "./lib/kiosk";

const MAX_DEVICES_PER_GATE = 20;
const MAX_NAME_LENGTH = 60;

/** Admin-facing shape. Never includes the token hash or rate counters. */
function present(d: Doc<"kioskDevices">) {
  return {
    _id: d._id,
    gateId: d.gateId,
    name: d.name,
    status: d.status,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt ?? null,
    revokedAt: d.revokedAt ?? null,
  };
}

export const listByGate = orgQuery({
  args: { gateId: v.id("gates") },
  handler: async (ctx, { gateId }) => {
    ctx.require("sites:manage");
    const gate = await ctx.db.get(gateId);
    if (!gate || gate.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
    await requireSite(ctx, ctx.oc, gate.siteId);
    const devices = await ctx.db
      .query("kioskDevices")
      .withIndex("by_gate", (q) => q.eq("gateId", gateId))
      .take(100);
    return devices.map(present);
  },
});

/** Issues a device. The plaintext token is returned here once and never again. */
export const issue = orgMutation({
  args: { gateId: v.id("gates"), name: v.string() },
  handler: async (ctx, { gateId, name }) => {
    ctx.require("sites:manage");
    const gate = await ctx.db.get(gateId);
    if (!gate || gate.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
    const site = await requireSite(ctx, ctx.oc, gate.siteId);
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH) {
      throw appError("VALIDATION", `Device name must be 1-${MAX_NAME_LENGTH} characters.`);
    }
    const existing = await ctx.db
      .query("kioskDevices")
      .withIndex("by_gate", (q) => q.eq("gateId", gateId))
      .take(100);
    if (existing.filter((d) => d.status === "active").length >= MAX_DEVICES_PER_GATE) {
      throw appError("FORBIDDEN", "This gate has reached the maximum number of kiosk devices.");
    }
    const token = generateKioskToken();
    const deviceId = await ctx.db.insert("kioskDevices", {
      organizationId: ctx.oc.org._id,
      siteId: site._id,
      gateId,
      name: trimmed,
      tokenHash: await hashKioskToken(token),
      status: "active",
      createdBy: ctx.oc.user._id,
      createdAt: Date.now(),
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "kiosk_device.issued",
      resourceType: "kiosk_device",
      resourceId: deviceId,
      metadata: { gateId, siteId: site._id },
    });
    return { deviceId, token };
  },
});

export const revoke = orgMutation({
  args: { deviceId: v.id("kioskDevices") },
  handler: async (ctx, { deviceId }) => {
    ctx.require("sites:manage");
    const device = await ctx.db.get(deviceId);
    if (!device || device.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
    await requireSite(ctx, ctx.oc, device.siteId);
    if (device.status === "revoked") return;
    await ctx.db.patch(deviceId, { status: "revoked", revokedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "kiosk_device.revoked",
      resourceType: "kiosk_device",
      resourceId: deviceId,
      metadata: { gateId: device.gateId },
    });
  },
});
