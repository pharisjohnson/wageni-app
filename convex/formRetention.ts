import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type QueryCtx } from "./_generated/server";
import { NO_REDACTION_DUE, planRedaction } from "../lib/answer-retention";
import { writeAudit } from "./lib/audit";
import { fieldsOf } from "./lib/formResponses";

/**
 * Per-field retention for form answers. Each answer is kept for its field's
 * `retentionDays`, or the organization's period when the field sets none
 * (visitor forms: visitor records; staff forms: attendance). The period is
 * clamped to the organization minimum in `lib/retention.ts`, so a field cannot
 * be kept shorter than that floor.
 *
 * Past its period, an answer value is replaced by the tombstone
 * `{ redacted: true }`. The `formResponses` row, its form version reference
 * and its subject (visit, appointment, person) stay, so you can still see THAT
 * a response was given and which version. File answers are not touched here:
 * stored files follow `files.deleteAfter` (see convex/files.ts).
 *
 * Scheduling: each response carries `nextRedactionCheck` (earliest deadline,
 * at most 30 days ahead), so the job reads only due rows through an index.
 * Work is bounded per run; a full batch schedules another run. `dryRun`
 * reports the same counts without changing anything. The audit entry holds
 * counts only, never field names or values.
 */

const DEFAULT_BATCH = 200;
const MAX_BATCH = 500;

export type RedactionCounts = { responses: number; answers: number; sensitiveAnswers: number };

type Due = Doc<"formResponses">;

async function loadDue(ctx: QueryCtx, org: Doc<"organizations">, now: number, batch: number): Promise<Due[]> {
  // Rows stored before this job existed have no check time; they sort first.
  const legacy = await ctx.db
    .query("formResponses")
    .withIndex("by_org_redaction", (q) => q.eq("organizationId", org._id).eq("nextRedactionCheck", undefined))
    .take(batch);
  const rest =
    legacy.length >= batch
      ? []
      : await ctx.db
          .query("formResponses")
          .withIndex("by_org_redaction", (q) => q.eq("organizationId", org._id).lt("nextRedactionCheck", now))
          .take(batch - legacy.length);
  // `undefined` also sorts below every number, so a legacy row can appear in both reads.
  return [...new Map([...legacy, ...rest].map((r) => [r._id, r])).values()];
}

export const redactExpired = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    dryRun: v.boolean(),
    now: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ dryRun: boolean; counts: RedactionCounts; hasMore: boolean }> => {
    const counts: RedactionCounts = { responses: 0, answers: 0, sensitiveAnswers: 0 };
    const org = await ctx.db.get(args.organizationId);
    if (!org) return { dryRun: args.dryRun, counts, hasMore: false };
    const now = args.now ?? Date.now();
    const batch = Math.min(MAX_BATCH, Math.max(1, Math.floor(args.batchSize ?? DEFAULT_BATCH)));
    const rows = await loadDue(ctx, org, now, batch);

    for (const row of rows) {
      const version = await ctx.db.get(row.formVersionId);
      if (!version || version.organizationId !== org._id) {
        // Nothing to plan against; park the row so it is not reread every run.
        if (!args.dryRun) await ctx.db.patch(row._id, { nextRedactionCheck: NO_REDACTION_DUE });
        continue;
      }
      const plan = planRedaction({
        fields: fieldsOf(version),
        answers: row.answers,
        createdAt: row.createdAt,
        audience: version.audience,
        retention: org.retention,
        now,
      });
      if (plan.redact.length > 0) {
        counts.responses++;
        counts.answers += plan.redact.length;
        counts.sensitiveAnswers += plan.sensitive;
      }
      if (args.dryRun) continue;
      const answers = { ...row.answers };
      for (const id of plan.redact) answers[id] = { redacted: true };
      await ctx.db.patch(row._id, { answers, nextRedactionCheck: plan.nextCheck });
    }

    const hasMore = rows.length >= batch;
    if (args.dryRun) return { dryRun: true, counts, hasMore };
    if (counts.answers > 0) {
      await writeAudit(ctx, {
        organizationId: org._id,
        action: "form_answers.redacted",
        resourceType: "retention",
        resourceId: org._id,
        metadata: { ...counts, system: true },
      });
    }
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.formRetention.redactExpired, {
        organizationId: org._id,
        dryRun: false,
        batchSize: args.batchSize,
      });
    }
    return { dryRun: false, counts, hasMore };
  },
});
