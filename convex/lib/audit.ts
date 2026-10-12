import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

type AuditMetadata = Record<string, string | number | boolean | null>;

/**
 * Append an audit entry in the same transaction as the change it describes.
 * Keep metadata free of secrets and unnecessary personal data.
 */
export async function writeAudit(
  ctx: MutationCtx,
  entry: {
    organizationId: Id<"organizations">;
    actorUserId: Id<"users">;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: AuditMetadata;
  },
) {
  await ctx.db.insert("auditLogs", { ...entry, at: Date.now() });
}
