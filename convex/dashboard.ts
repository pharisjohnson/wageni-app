import { hasSiteAccess } from "./lib/auth";
import { orgQuery } from "./lib/functions";

const COUNT_CAP = 1000;

/**
 * Phase 1 dashboard figures, all from real records scoped to the caller's
 * organization and site access. Counts are capped to keep reads bounded;
 * `capped` tells the UI to show "1000+".
 */
export const summary = orgQuery({
  args: {},
  handler: async (ctx) => {
    const orgId = ctx.oc.org._id;
    const result: {
      sites: number | null;
      gates: number | null;
      members: number | null;
      capped: boolean;
    } = { sites: null, gates: null, members: null, capped: false };

    if (ctx.oc.permissions.has("sites:read")) {
      const sites = (
        await ctx.db
          .query("sites")
          .withIndex("by_org", (q) => q.eq("organizationId", orgId))
          .take(COUNT_CAP)
      ).filter((s) => hasSiteAccess(ctx.oc.membership, s._id));
      const gates = (
        await ctx.db
          .query("gates")
          .withIndex("by_org", (q) => q.eq("organizationId", orgId))
          .take(COUNT_CAP)
      ).filter((g) => hasSiteAccess(ctx.oc.membership, g.siteId));
      result.sites = sites.length;
      result.gates = gates.length;
      result.capped ||= sites.length === COUNT_CAP || gates.length === COUNT_CAP;
    }
    if (ctx.oc.permissions.has("members:read")) {
      const members = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("organizationId", orgId))
        .take(COUNT_CAP);
      result.members = members.filter((m) => m.status === "active").length;
      result.capped ||= members.length === COUNT_CAP;
    }
    return result;
  },
});
