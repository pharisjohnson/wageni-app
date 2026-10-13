import { internalMutation } from "./_generated/server";
import { deleteExpiredFiles } from "./lib/files";

/**
 * Retention for stored files, scheduled in convex/crons.ts. The function
 * deletes bytes whose `deleteAfter` has passed (including pending uploads that
 * no response claimed within an hour), keeps the `files` row as "deleted", and
 * audits each deletion. It handles up to 200 files per run and is safe to run
 * repeatedly.
 */
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await deleteExpiredFiles(ctx, Date.now());
  },
});
