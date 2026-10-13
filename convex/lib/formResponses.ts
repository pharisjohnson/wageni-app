import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  DEFAULT_FILE_RETENTION_DAYS,
  fileKindForField,
  validateAnswers,
  type FormField,
} from "../../lib/validation/forms";
import { writeAudit } from "./audit";
import { appError } from "./errors";
import { uploadedBy, type Uploader } from "./files";
import { disabledFieldTypes } from "./policy";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The stored field list as the shared type (validators mirror the zod schema). */
export function fieldsOf(version: Pick<Doc<"formVersions">, "fields">): FormField[] {
  return version.fields as FormField[];
}

/**
 * The published form a visitor sees at a site: a site-specific form beats an
 * organization-wide one; the most recently published wins a tie. Returns null
 * when nothing is published (callers fall back to fixed fields).
 */
export async function resolveActiveForm(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  siteId: Id<"sites">,
  audience: "visitor" | "staff" = "visitor",
  preferFormId?: Id<"forms">,
): Promise<{ form: Doc<"forms">; version: Doc<"formVersions"> } | null> {
  const forms = await ctx.db
    .query("forms")
    .withIndex("by_org_audience_status", (q) =>
      q.eq("organizationId", organizationId).eq("audience", audience).eq("status", "published"),
    )
    .take(100);
  const candidates: { form: Doc<"forms">; version: Doc<"formVersions"> }[] = [];
  for (const form of forms) {
    if (!form.publishedVersionId) continue;
    if (form.siteId && form.siteId !== siteId) continue;
    const version = await ctx.db.get(form.publishedVersionId);
    if (!version || version.organizationId !== organizationId || version.formId !== form._id) continue;
    candidates.push({ form, version });
  }
  const preferred = preferFormId ? candidates.find((c) => c.form._id === preferFormId) : undefined;
  if (preferred) return preferred;
  candidates.sort(
    (a, b) =>
      Number(Boolean(b.form.siteId)) - Number(Boolean(a.form.siteId)) || b.version.publishedAt - a.version.publishedAt,
  );
  return candidates[0] ?? null;
}

/**
 * Validate raw answers against a version and verify every file reference:
 * the file exists in this organization, is still `pending`, was uploaded by
 * the same caller (device or invitation), has the kind the field expects, and
 * is used once. Returns clean answers with real `files` ids.
 */
export async function checkAnswers(
  ctx: QueryCtx,
  org: Doc<"organizations">,
  version: Doc<"formVersions">,
  raw: unknown,
  uploader: Uploader,
): Promise<{ answers: Record<string, unknown>; fileIds: Map<Id<"files">, FormField> }> {
  const fields = fieldsOf(version);
  const check = validateAnswers(fields, raw, { skipTypes: disabledFieldTypes(org) });
  if (!check.ok) {
    const [first] = Object.entries(check.errors);
    const label = first ? (fields.find((f) => f.id === first[0])?.label ?? first[0]) : "";
    throw appError("VALIDATION", first ? `${label}: ${first[1]}` : undefined);
  }
  const byId = new Map(fields.map((f) => [f.id, f]));
  const answers: Record<string, unknown> = {};
  const fileIds = new Map<Id<"files">, FormField>();
  for (const [fieldId, value] of Object.entries(check.answers)) {
    const field = byId.get(fieldId)!;
    if (typeof value === "object" && value !== null && !Array.isArray(value) && "fileId" in value) {
      const fileId = ctx.db.normalizeId("files", value.fileId);
      const file = fileId ? await ctx.db.get(fileId) : null;
      if (
        !fileId ||
        !file ||
        file.organizationId !== org._id ||
        file.status !== "pending" ||
        !uploadedBy(file, uploader) ||
        file.kind !== fileKindForField(field.type) ||
        fileIds.has(fileId) ||
        (field.type === "id_scan" && !field.storeImage)
      ) {
        throw appError("VALIDATION", `${field.label}: please add this again.`);
      }
      fileIds.set(fileId, field);
      answers[fieldId] = { fileId };
    } else {
      answers[fieldId] = value;
    }
  }
  return { answers, fileIds };
}

/**
 * Store a response, link it to its version and claim its files (they become
 * `attached` with a retention deadline from the field's `retentionDays`).
 */
export async function storeResponse(
  ctx: MutationCtx,
  input: {
    org: Doc<"organizations">;
    siteId?: Id<"sites">;
    form: Doc<"forms">;
    version: Doc<"formVersions">;
    answers: Record<string, unknown>;
    fileIds: Map<Id<"files">, FormField>;
    visitId?: Id<"visits">;
    appointmentId?: Id<"appointments">;
    userId?: Id<"users">;
    actor: { actorUserId?: Id<"users">; kioskDeviceId?: Id<"kioskDevices"> };
  },
): Promise<Id<"formResponses">> {
  const now = Date.now();
  const responseId = await ctx.db.insert("formResponses", {
    organizationId: input.org._id,
    siteId: input.siteId,
    formId: input.form._id,
    formVersionId: input.version._id,
    visitId: input.visitId,
    appointmentId: input.appointmentId,
    userId: input.userId,
    answers: input.answers as Doc<"formResponses">["answers"],
    createdAt: now,
  });
  for (const [fileId, field] of input.fileIds) {
    await ctx.db.patch(fileId, {
      status: "attached",
      responseId,
      fieldId: field.id,
      deleteAfter: now + (field.retentionDays ?? DEFAULT_FILE_RETENTION_DAYS) * DAY_MS,
    });
  }
  await writeAudit(ctx, {
    organizationId: input.org._id,
    ...input.actor,
    action: "form_response.created",
    resourceType: "formResponse",
    resourceId: responseId,
    metadata: { formVersionId: input.version._id, version: input.version.version },
  });
  return responseId;
}

/** Fields shown to the answerer for this org (face photos hidden when switched off). */
export function servedFields(org: Doc<"organizations">, version: Doc<"formVersions">): FormField[] {
  const off = disabledFieldTypes(org);
  return fieldsOf(version).filter((f) => !off.includes(f.type));
}
