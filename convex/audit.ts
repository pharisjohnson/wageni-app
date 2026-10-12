import { paginationOptsValidator } from "convex/server";
import { orgQuery } from "./lib/functions";

/** Newest-first audit trail for the caller's organization. */
export const list = orgQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    ctx.require("audit:read");
    return await ctx.db
      .query("auditLogs")
      .withIndex("by_org_at", (q) => q.eq("organizationId", ctx.oc.org._id))
      .order("desc")
      .paginate(paginationOpts);
  },
});
