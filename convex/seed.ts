import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";

/**
 * Development/demo data. Internal only, and refuses to run unless the
 * deployment sets ALLOW_DEMO_SEED=true. Everything it creates is flagged
 * `isDemo` and labelled in the UI so it cannot be mistaken for real records.
 *
 *   npx convex env set ALLOW_DEMO_SEED true
 *   npx convex run seed:demo '{"ownerEmail":"you@example.com"}'
 */
export const demo = internalMutation({
  args: { ownerEmail: v.string() },
  handler: async (ctx, { ownerEmail }) => {
    if (process.env.ALLOW_DEMO_SEED !== "true") {
      throw appError("FORBIDDEN", "Demo seeding is disabled on this deployment.");
    }
    const owner = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", ownerEmail.trim()))
      .first();
    if (!owner) throw appError("NOT_FOUND", "Sign in once with that email before seeding.");

    const slug = `demo-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Demo Organization (sample data)",
      slug,
      branding: {
        primaryColor: "#0F766E",
        welcomeText: "Welcome to the demo office",
        privacyNotice:
          "Demo environment. Do not enter real personal information.",
      },
      timeZone: "Africa/Nairobi",
      status: "trial",
      isDemo: true,
      createdBy: owner._id,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("memberships", {
      organizationId,
      userId: owner._id,
      role: "owner",
      permissionOverrides: { grant: [], revoke: [] },
      siteAccess: "all",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const sites = [
      { name: "Head Office", address: "Westlands, Nairobi", gates: ["Main Gate", "Reception"] },
      { name: "Warehouse", address: "Industrial Area, Nairobi", gates: ["Truck Gate"] },
    ];
    for (const s of sites) {
      const siteId = await ctx.db.insert("sites", {
        organizationId,
        name: s.name,
        address: s.address,
        timeZone: "Africa/Nairobi",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      for (const g of s.gates) {
        await ctx.db.insert("gates", {
          organizationId,
          siteId,
          name: g,
          type: g === "Reception" ? "reception" : g === "Truck Gate" ? "vehicle" : "pedestrian",
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    await writeAudit(ctx, {
      organizationId,
      actorUserId: owner._id,
      action: "organization.demo_seeded",
      resourceType: "organization",
      resourceId: organizationId,
    });
    return { organizationId, slug };
  },
});
