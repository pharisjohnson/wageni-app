import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  brandingSchema,
  createOrganizationSchema,
  slugSchema,
} from "../lib/validation/organization";
import { requireUser } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { orgMutation, orgQuery } from "./lib/functions";
import { parseOrThrow } from "./lib/validate";
import { vBranding } from "./validators";

/** Abuse guard: how many organizations one account may own. */
const MAX_OWNED_ORGANIZATIONS = 5;

export const create = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    timeZone: v.string(),
    siteName: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const input = parseOrThrow(createOrganizationSchema, args);

    const owned = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(200);
    if (owned.filter((m) => m.role === "owner").length >= MAX_OWNED_ORGANIZATIONS) {
      throw appError("FORBIDDEN", "You have reached the maximum number of organizations.");
    }

    const taken = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", input.slug))
      .unique();
    if (taken) throw appError("CONFLICT", "That organization address is already taken.");

    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: input.name,
      slug: input.slug,
      branding: {},
      timeZone: input.timeZone,
      status: "trial",
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("memberships", {
      organizationId,
      userId: user._id,
      role: "owner",
      permissionOverrides: { grant: [], revoke: [] },
      siteAccess: "all",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const siteId = await ctx.db.insert("sites", {
      organizationId,
      name: input.siteName,
      timeZone: input.timeZone,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, {
      organizationId,
      actorUserId: user._id,
      action: "organization.created",
      resourceType: "organization",
      resourceId: organizationId,
      metadata: { slug: input.slug, defaultSiteId: siteId },
    });
    return { organizationId, siteId };
  },
});

/** Organizations the caller is an active member of. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (!user) return [];
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(100);
    const result = [];
    for (const m of memberships) {
      if (m.status !== "active") continue;
      const org = await ctx.db.get(m.organizationId);
      if (!org) continue;
      result.push({
        organizationId: org._id,
        name: org.name,
        slug: org.slug,
        status: org.status,
        role: m.role,
      });
    }
    return result;
  },
});

/** The current organization plus the caller's role and effective permissions. */
export const get = orgQuery({
  args: {},
  handler: async (ctx) => {
    const { org, membership, permissions } = ctx.oc;
    return {
      _id: org._id,
      name: org.name,
      slug: org.slug,
      status: org.status,
      timeZone: org.timeZone,
      branding: org.branding,
      isDemo: org.isDemo ?? false,
      membership: {
        _id: membership._id,
        role: membership.role,
        siteAccess: membership.siteAccess,
        permissions: [...permissions],
      },
    };
  },
});

export const updateBranding = orgMutation({
  args: { branding: vBranding },
  handler: async (ctx, { branding }) => {
    ctx.require("settings:manage");
    const parsed = parseOrThrow(brandingSchema, branding);
    await ctx.db.patch(ctx.oc.org._id, { branding: parsed, updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "organization.branding_updated",
      resourceType: "organization",
      resourceId: ctx.oc.org._id,
    });
  },
});

export const isSlugAvailable = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    await requireUser(ctx);
    const parsed = slugSchema.safeParse(slug);
    if (!parsed.success) return false;
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", parsed.data))
      .unique();
    return existing === null;
  },
});

/**
 * Public, unauthenticated lookup for the kiosk welcome screen. Returns only
 * branding needed to render the screen: never members, sites or records.
 */
export const getPublicBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", slug.toLowerCase()))
      .unique();
    if (!org || org.status === "suspended") return null;
    return {
      name: org.name,
      slug: org.slug,
      branding: {
        logoUrl: org.branding.logoUrl ?? null,
        primaryColor: org.branding.primaryColor ?? null,
        welcomeText: org.branding.welcomeText ?? null,
        privacyNotice: org.branding.privacyNotice ?? null,
      },
    };
  },
});
