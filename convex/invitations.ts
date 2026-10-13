import { v } from "convex/values";
import { autoFillAnswers, invitationCreateSchema, invitationSubmitSchema } from "../lib/validation/forms";
import { mutation, type QueryCtx } from "./_generated/server";
import { hasSiteAccess, requireSite } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { openUploadIntent, registerUpload } from "./lib/files";
import { checkAnswers, fieldsOf, resolveActiveForm, servedFields, storeResponse } from "./lib/formResponses";
import { orgMutation, orgQuery } from "./lib/functions";
import { absoluteInviteLink, onInvitationCreated } from "./lib/invitationHooks";
import { generateInviteToken, hashInviteToken, isInviteTokenShape } from "./lib/invitationToken";
import { requireApproval } from "./lib/policy";
import { proxyArgs, takeIpLimit } from "./lib/proxy";
import { takePublicLimit } from "./lib/publicLimit";
import { parseOrThrow } from "./lib/validate";
import { requireHost, upsertVisitor } from "./lib/visitors";
import { vFileKind, vRawAnswers } from "./validators";

/**
 * Invitation links.
 *
 * Signed-in side (`create`, `list`, `cancel`): host or reception creates a
 * link for a visitor. Only the SHA-256 of the token is stored, so the link is
 * shown once, at creation.
 *
 * Public side (`lookup`, `generateUploadUrl`, `registerUploaded`, `submit`):
 * the token is the credential. Every failure (unknown, expired, cancelled,
 * already used, suspended organization, inactive site) looks identical:
 * `{ status: "unavailable" }`. A used link cannot be replayed. Tokens carry
 * 256 bits, so guessing is infeasible; global fixed-window limits protect the
 * database from floods (see convex/lib/publicLimit.ts).
 *
 * These four are reachable ONLY through the Next.js route handlers in
 * `app/api/invite/*`: every call must carry `proxySecret` (checked in constant
 * time against INVITE_PROXY_SECRET) and the caller's `ipHash`, and spends from
 * a per-IP budget (convex/lib/proxy.ts). A direct call without the secret is
 * refused with FORBIDDEN, so the per-IP limits cannot be bypassed.
 */

const MAX_LIST = 100;
const PUBLIC_LIMIT = 120;
const PUBLIC_WINDOW_MS = 60_000;
/** Per client (hashed IP) budgets, applied before the global ones. */
export const IP_LIMITS = {
  lookup: { max: 60, windowMs: 60_000 },
  upload: { max: 30, windowMs: 5 * 60_000 },
  submit: { max: 15, windowMs: 10 * 60_000 },
} as const;
const MAX_UPLOADS_PER_INVITATION = 10;

const UNAVAILABLE = { status: "unavailable" as const };

/** The invitation for a presented token, only while it can still be answered. */
async function resolveInvitation(ctx: QueryCtx, token: string) {
  if (!isInviteTokenShape(token)) return null;
  const tokenHash = await hashInviteToken(token);
  const inv = await ctx.db
    .query("invitations")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!inv || inv.status !== "pending" || inv.expiresAt <= Date.now()) return null;
  const [org, site] = await Promise.all([ctx.db.get(inv.organizationId), ctx.db.get(inv.siteId)]);
  if (!org || org.status === "suspended" || !site || site.status !== "active" || site.organizationId !== org._id) {
    return null;
  }
  return { inv, org, site };
}

// ---------- Signed-in side ----------

export const create = orgMutation({
  args: {
    siteId: v.id("sites"),
    hostUserId: v.id("users"),
    visitorName: v.optional(v.string()),
    visitorPhone: v.optional(v.string()),
    visitorEmail: v.optional(v.string()),
    purpose: v.string(),
    scheduledStart: v.number(),
    scheduledEnd: v.number(),
    formId: v.optional(v.id("forms")),
    /** `window.location.origin` of the creating browser; validated, see lib/invite/origin.ts. */
    origin: v.optional(v.string()),
  },
  handler: async (ctx, { siteId, hostUserId, formId, origin, ...rest }) => {
    ctx.require("appointments:create");
    const site = await requireSite(ctx, ctx.oc, siteId);
    const input = parseOrThrow(invitationCreateSchema, rest);
    if (input.scheduledEnd <= Date.now()) throw appError("VALIDATION", "Choose a time in the future.");
    const me = ctx.oc.user._id;
    if (hostUserId !== me && !ctx.oc.permissions.has("appointments:read_site")) throw appError("FORBIDDEN");
    await requireHost(ctx, ctx.oc, hostUserId, siteId);
    if (formId) {
      const form = await ctx.db.get(formId);
      if (!form || form.organizationId !== ctx.oc.org._id || form.audience !== "visitor" || form.status !== "published") {
        throw appError("VALIDATION", "Choose a published visitor form.");
      }
    }
    const token = generateInviteToken();
    const now = Date.now();
    const id = await ctx.db.insert("invitations", {
      organizationId: ctx.oc.org._id,
      siteId: site._id,
      hostUserId,
      createdBy: me,
      visitorName: input.visitorName || undefined,
      visitorPhone: input.visitorPhone || undefined,
      visitorEmail: input.visitorEmail || undefined,
      purpose: input.purpose,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      tokenHash: await hashInviteToken(token),
      status: "pending",
      expiresAt: input.scheduledEnd,
      formId,
      createdAt: now,
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: me,
      action: "invitation.created",
      resourceType: "invitation",
      resourceId: id,
    });
    const link = `/invite/${token}`;
    const invitation = (await ctx.db.get(id))!;
    await onInvitationCreated(ctx, { invitation, link, origin });
    // `url` is absolute when APP_BASE_URL or a valid origin is known, else equal to `path`.
    return { invitationId: id, token, path: link, url: absoluteInviteLink(link, origin) };
  },
});

export const list = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("appointments:create");
    const canSite = ctx.oc.permissions.has("appointments:read_site");
    const me = ctx.oc.user._id;
    const rows = await ctx.db
      .query("invitations")
      .withIndex("by_org", (q) => q.eq("organizationId", ctx.oc.org._id))
      .order("desc")
      .take(MAX_LIST);
    const now = Date.now();
    const visible = rows.filter(
      (i) => hasSiteAccess(ctx.oc.membership, i.siteId) && (canSite || i.hostUserId === me || i.createdBy === me),
    );
    return await Promise.all(
      visible.map(async (i) => {
        const host = await ctx.db.get(i.hostUserId);
        // tokenHash is never returned.
        return {
          _id: i._id,
          siteId: i.siteId,
          hostName: host?.name ?? host?.email ?? "Unknown",
          visitorName: i.visitorName ?? null,
          purpose: i.purpose,
          scheduledStart: i.scheduledStart,
          scheduledEnd: i.scheduledEnd,
          status: i.status === "pending" && i.expiresAt <= now ? ("expired" as const) : i.status,
          appointmentId: i.appointmentId ?? null,
          createdAt: i.createdAt,
        };
      }),
    );
  },
});

export const cancel = orgMutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, { invitationId }) => {
    ctx.require("appointments:cancel");
    const inv = await ctx.db.get(invitationId);
    if (!inv || inv.organizationId !== ctx.oc.org._id || !hasSiteAccess(ctx.oc.membership, inv.siteId)) {
      throw appError("NOT_FOUND");
    }
    const own = inv.hostUserId === ctx.oc.user._id || inv.createdBy === ctx.oc.user._id;
    if (!own && !ctx.oc.permissions.has("appointments:read_site")) throw appError("NOT_FOUND");
    if (inv.status !== "pending") throw appError("CONFLICT", "This invitation can no longer be cancelled.");
    await ctx.db.patch(invitationId, { status: "cancelled" });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "invitation.cancelled",
      resourceType: "invitation",
      resourceId: invitationId,
    });
  },
});

// ---------- Public side (no sign-in; the token is the credential) ----------

/** What the invitee sees. Generic `unavailable` for every kind of failure. */
export const lookup = mutation({
  args: { ...proxyArgs, token: v.string() },
  handler: async (ctx, { token, ...proxy }) => {
    await takeIpLimit(ctx, proxy, "invite_lookup", IP_LIMITS.lookup.max, IP_LIMITS.lookup.windowMs);
    const found = await resolveInvitation(ctx, token);
    if (!found) return UNAVAILABLE;
    const { inv, org, site } = found;
    const [host, active] = await Promise.all([
      ctx.db.get(inv.hostUserId),
      resolveActiveForm(ctx, org._id, site._id, "visitor", inv.formId),
    ]);
    const fields = active ? servedFields(org, active.version) : [];
    return {
      status: "ok" as const,
      organizationName: org.name,
      branding: {
        logoUrl: org.branding.logoUrl ?? null,
        primaryColor: org.branding.primaryColor ?? null,
        privacyNotice: org.branding.privacyNotice ?? null,
      },
      siteName: site.name,
      timeZone: site.timeZone,
      hostName: host?.name ?? "your host",
      purpose: inv.purpose,
      scheduledStart: inv.scheduledStart,
      scheduledEnd: inv.scheduledEnd,
      visitor: { name: inv.visitorName ?? "", phone: inv.visitorPhone ?? "", email: inv.visitorEmail ?? "" },
      form: active
        ? { versionId: active.version._id, name: active.version.name, fields }
        : null,
    };
  },
});

export const generateUploadUrl = mutation({
  args: { ...proxyArgs, token: v.string(), kind: vFileKind },
  handler: async (ctx, { token, kind, ...proxy }) => {
    await takeIpLimit(ctx, proxy, "invite_upload", IP_LIMITS.upload.max, IP_LIMITS.upload.windowMs);
    await takePublicLimit(ctx, "invite_upload", PUBLIC_LIMIT, PUBLIC_WINDOW_MS);
    const found = await resolveInvitation(ctx, token);
    if (!found) return UNAVAILABLE;
    const count = found.inv.uploadCount ?? 0;
    if (count >= MAX_UPLOADS_PER_INVITATION) throw appError("RATE_LIMITED");
    await openUploadIntent(ctx, found.org._id, { invitationId: found.inv._id }, kind);
    await ctx.db.patch(found.inv._id, { uploadCount: count + 1 });
    return { status: "ok" as const, uploadUrl: await ctx.storage.generateUploadUrl() };
  },
});

export const registerUploaded = mutation({
  args: { ...proxyArgs, token: v.string(), storageId: v.id("_storage"), kind: vFileKind },
  handler: async (ctx, { token, storageId, kind, ...proxy }) => {
    await takeIpLimit(ctx, proxy, "invite_upload", IP_LIMITS.upload.max, IP_LIMITS.upload.windowMs);
    await takePublicLimit(ctx, "invite_upload", PUBLIC_LIMIT, PUBLIC_WINDOW_MS);
    const found = await resolveInvitation(ctx, token);
    if (!found) {
      // Do not keep bytes for a link that cannot be used.
      await ctx.storage.delete(storageId);
      return UNAVAILABLE;
    }
    return await registerUpload(ctx, {
      organizationId: found.org._id,
      siteId: found.site._id,
      storageId,
      kind,
      uploader: { invitationId: found.inv._id },
    });
  },
});

/**
 * The invitee confirms their details and answers the form. Creates the
 * visitor and the appointment (status from the approval policy), stores the
 * response against the version served, and consumes the invitation.
 */
export const submit = mutation({
  args: {
    ...proxyArgs,
    token: v.string(),
    details: v.object({
      name: v.string(),
      phone: v.string(),
      email: v.optional(v.string()),
      company: v.optional(v.string()),
    }),
    versionId: v.optional(v.id("formVersions")),
    answers: vRawAnswers,
  },
  handler: async (ctx, { proxySecret, ipHash, ...args }) => {
    await takeIpLimit(ctx, { proxySecret, ipHash }, "invite_submit", IP_LIMITS.submit.max, IP_LIMITS.submit.windowMs);
    await takePublicLimit(ctx, "invite_submit", PUBLIC_LIMIT, PUBLIC_WINDOW_MS);
    const found = await resolveInvitation(ctx, args.token);
    if (!found) {
      // An expired-but-pending link is closed for good (no throw: the patch must commit).
      const hash = isInviteTokenShape(args.token) ? await hashInviteToken(args.token) : null;
      const stale = hash
        ? await ctx.db.query("invitations").withIndex("by_token_hash", (q) => q.eq("tokenHash", hash)).unique()
        : null;
      if (stale && stale.status === "pending" && stale.expiresAt <= Date.now()) {
        await ctx.db.patch(stale._id, { status: "expired" });
      }
      return UNAVAILABLE;
    }
    const { inv, org, site } = found;
    const details = parseOrThrow(invitationSubmitSchema, args.details);
    const active = await resolveActiveForm(ctx, org._id, site._id, "visitor", inv.formId);
    if (active && active.version._id !== args.versionId) {
      throw appError("CONFLICT", "This form was updated. Please reload the page.");
    }
    if (!active && Object.keys(args.answers).length > 0) throw appError("VALIDATION");

    let checked: Awaited<ReturnType<typeof checkAnswers>> | null = null;
    if (active) {
      const filled = {
        ...args.answers,
        ...autoFillAnswers(fieldsOf(active.version), { ...details, purpose: inv.purpose }),
      };
      checked = await checkAnswers(ctx, org, active.version, filled, { invitationId: inv._id });
    }

    const now = Date.now();
    const visitorId = await upsertVisitor(
      ctx,
      org._id,
      { name: details.name, phone: details.phone, email: details.email, company: details.company },
      { updateExisting: false },
    );
    const needsApproval = requireApproval(org, site);
    const appointmentId = await ctx.db.insert("appointments", {
      organizationId: org._id,
      siteId: site._id,
      visitorId,
      hostUserId: inv.hostUserId,
      purpose: inv.purpose,
      scheduledStart: inv.scheduledStart,
      scheduledEnd: inv.scheduledEnd,
      status: needsApproval ? "pending_approval" : "approved",
      createdBy: inv.createdBy,
      decisionNote: needsApproval ? undefined : "Approved automatically by policy.",
      createdAt: now,
      updatedAt: now,
    });
    if (active && checked) {
      await storeResponse(ctx, {
        org,
        siteId: site._id,
        form: active.form,
        version: active.version,
        answers: checked.answers,
        fileIds: checked.fileIds,
        appointmentId,
        actor: {},
      });
    }
    await ctx.db.patch(inv._id, { status: "submitted", appointmentId, submittedAt: now });
    await writeAudit(ctx, {
      organizationId: org._id,
      action: "invitation.submitted",
      resourceType: "invitation",
      resourceId: inv._id,
      metadata: { origin: "invite_link", appointmentId, status: needsApproval ? "pending_approval" : "approved" },
    });
    const host = await ctx.db.get(inv.hostUserId);
    return {
      status: "ok" as const,
      approval: needsApproval ? ("pending" as const) : ("approved" as const),
      hostName: host?.name ?? "your host",
      scheduledStart: inv.scheduledStart,
    };
  },
});
