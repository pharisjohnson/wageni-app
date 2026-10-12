import { v } from "convex/values";
import { customMutation, customQuery } from "convex-helpers/server/customFunctions";
import type { Id } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import type { Permission } from "../../lib/permissions";
import { requireMembership, type OrgContext } from "./auth";
import { appError } from "./errors";

/**
 * Builders for organization-scoped functions. Each requires an
 * `organizationId` argument and verifies active membership before the handler
 * runs, exposing the verified context as `ctx.oc`. Handlers then assert the
 * specific permission they need with `ctx.require(...)`.
 *
 * Using these builders (instead of plain `query`/`mutation`) for all tenant
 * data makes the membership check impossible to forget.
 */
const orgArgs = { organizationId: v.id("organizations") };

async function orgInput(
  ctx: QueryCtx,
  { organizationId }: { organizationId: Id<"organizations"> },
) {
  const oc = await requireMembership(ctx, organizationId);
  const require = (permission: Permission) => {
    if (!oc.permissions.has(permission)) throw appError("FORBIDDEN");
  };
  return { ctx: { oc, require }, args: {} };
}

export const orgQuery = customQuery(query, { args: orgArgs, input: orgInput });
export const orgMutation = customMutation(mutation, { args: orgArgs, input: orgInput });

/** Context shape handlers receive from the builders above (for shared helpers). */
export type OrgCtx = QueryCtx & { oc: OrgContext; require: (permission: Permission) => void };
