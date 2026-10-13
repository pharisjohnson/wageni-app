import { v } from "convex/values";
import {
  FORM_LIMITS,
  formDetailsSchema,
  formFieldsSchema,
  publishProblems,
  type FormField,
} from "../lib/validation/forms";
import { isRedactedAnswer } from "../lib/validation/forms";
import type { Doc, Id } from "./_generated/dataModel";
import { hasSiteAccess, requireSite } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { fieldsOf } from "./lib/formResponses";
import { orgMutation, orgQuery, type OrgCtx } from "./lib/functions";
import { faceCaptureEnabled } from "./lib/policy";
import { parseOrThrow } from "./lib/validate";
import { vFormAudience, vFormField } from "./validators";

/**
 * Form builder backend. `forms.draftFields` is the editable copy; publishing
 * inserts a NEW immutable `formVersions` row. There is deliberately no
 * function that patches or deletes a version row.
 *
 * Reading answers:
 * - `visitResponses` (query) never returns sensitive values or file URLs.
 * - `revealSensitive` and `openFile` (mutations, because every read is
 *   audited) return them, and only with `forms:read_sensitive`.
 */

const MAX_FORMS = 200;
const MAX_VERSIONS = 100;

/** Normalise and validate fields from the client. Throws a VALIDATION error. */
function parseFields(input: unknown): FormField[] {
  return parseOrThrow(formFieldsSchema, input);
}

async function loadForm(ctx: OrgCtx, formId: Id<"forms">) {
  const form = await ctx.db.get(formId);
  if (!form || form.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
  return form;
}

async function checkSite(ctx: OrgCtx, siteId: Id<"sites"> | undefined) {
  if (siteId) await requireSite(ctx, ctx.oc, siteId);
}

export const list = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("forms:manage");
    const forms = await ctx.db
      .query("forms")
      .withIndex("by_org", (q) => q.eq("organizationId", ctx.oc.org._id))
      .order("desc")
      .take(MAX_FORMS);
    return await Promise.all(
      forms.map(async (f) => {
        const [site, version] = await Promise.all([
          f.siteId ? ctx.db.get(f.siteId) : null,
          f.publishedVersionId ? ctx.db.get(f.publishedVersionId) : null,
        ]);
        return {
          _id: f._id,
          name: f.name,
          audience: f.audience,
          status: f.status,
          purpose: f.purpose ?? null,
          siteName: site?.name ?? null,
          fieldCount: f.draftFields.length,
          publishedVersion: version?.version ?? null,
          updatedAt: f.updatedAt,
        };
      }),
    );
  },
});

/** A form with its draft and version history (read-only list). */
export const get = orgQuery({
  args: { formId: v.id("forms") },
  handler: async (ctx, { formId }) => {
    ctx.require("forms:manage");
    const form = await loadForm(ctx, formId);
    const versions = await ctx.db
      .query("formVersions")
      .withIndex("by_form", (q) => q.eq("formId", formId))
      .order("desc")
      .take(MAX_VERSIONS);
    const history = await Promise.all(
      versions.map(async (ver) => {
        const by = await ctx.db.get(ver.publishedBy);
        return {
          _id: ver._id,
          version: ver.version,
          publishedAt: ver.publishedAt,
          publishedByName: by?.name ?? by?.email ?? "Unknown",
          fieldCount: ver.fields.length,
        };
      }),
    );
    const published = form.publishedVersionId ? versions.find((x) => x._id === form.publishedVersionId) : undefined;
    return {
      ...form,
      history,
      faceCaptureEnabled: faceCaptureEnabled(ctx.oc.org),
      // The builder warns when the draft differs from what is live.
      hasUnpublishedChanges: !published || JSON.stringify(published.fields) !== JSON.stringify(form.draftFields),
    };
  },
});

/** One immutable version, for the read-only history view. */
export const getVersion = orgQuery({
  args: { versionId: v.id("formVersions") },
  handler: async (ctx, { versionId }) => {
    ctx.require("forms:manage");
    const ver = await ctx.db.get(versionId);
    if (!ver || ver.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
    return ver;
  },
});

export const create = orgMutation({
  args: {
    name: v.string(),
    audience: vFormAudience,
    siteId: v.optional(v.id("sites")),
    purpose: v.optional(v.string()),
    fields: v.optional(v.array(vFormField)),
  },
  handler: async (ctx, args) => {
    ctx.require("forms:manage");
    const details = parseOrThrow(formDetailsSchema, args);
    await checkSite(ctx, args.siteId);
    const draftFields = parseFields(args.fields ?? []);
    const now = Date.now();
    const id = await ctx.db.insert("forms", {
      organizationId: ctx.oc.org._id,
      name: details.name,
      audience: details.audience,
      siteId: args.siteId,
      purpose: details.purpose || undefined,
      status: "draft",
      draftFields,
      createdBy: ctx.oc.user._id,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "form.created",
      resourceType: "form",
      resourceId: id,
    });
    return id;
  },
});

/** Save the working copy. Never touches published versions. */
export const saveDraft = orgMutation({
  args: {
    formId: v.id("forms"),
    name: v.string(),
    siteId: v.optional(v.id("sites")),
    purpose: v.optional(v.string()),
    fields: v.array(vFormField),
  },
  handler: async (ctx, args) => {
    ctx.require("forms:manage");
    const form = await loadForm(ctx, args.formId);
    if (form.status === "archived") throw appError("CONFLICT", "Restore this form before editing it.");
    const details = parseOrThrow(formDetailsSchema, { name: args.name, audience: form.audience, purpose: args.purpose });
    await checkSite(ctx, args.siteId);
    const fields = parseFields(args.fields);
    if (args.fields.length > FORM_LIMITS.maxFields) throw appError("VALIDATION");
    await ctx.db.patch(form._id, {
      name: details.name,
      purpose: details.purpose || undefined,
      siteId: args.siteId,
      draftFields: fields,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Publish the draft as the next version. Earlier versions stay exactly as
 * they were, and responses keep pointing at the version they were answered
 * with.
 */
export const publish = orgMutation({
  args: { formId: v.id("forms") },
  handler: async (ctx, { formId }) => {
    ctx.require("forms:manage");
    const form = await loadForm(ctx, formId);
    if (form.status === "archived") throw appError("CONFLICT", "Restore this form before publishing it.");
    const fields = parseFields(form.draftFields);
    const problems = publishProblems(fields, {
      audience: form.audience,
      faceCaptureEnabled: faceCaptureEnabled(ctx.oc.org),
    });
    if (problems.length > 0) throw appError("VALIDATION", problems.join(" "));
    const last = await ctx.db
      .query("formVersions")
      .withIndex("by_form", (q) => q.eq("formId", formId))
      .order("desc")
      .first();
    const now = Date.now();
    const versionId = await ctx.db.insert("formVersions", {
      organizationId: ctx.oc.org._id,
      formId,
      version: (last?.version ?? 0) + 1,
      name: form.name,
      audience: form.audience,
      siteId: form.siteId,
      fields,
      publishedAt: now,
      publishedBy: ctx.oc.user._id,
    });
    await ctx.db.patch(formId, { status: "published", publishedVersionId: versionId, updatedAt: now });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "form.published",
      resourceType: "form",
      resourceId: formId,
      metadata: { version: (last?.version ?? 0) + 1 },
    });
    return versionId;
  },
});

/** Stop serving the form. Versions and responses are kept. */
export const archive = orgMutation({
  args: { formId: v.id("forms") },
  handler: async (ctx, { formId }) => {
    ctx.require("forms:manage");
    const form = await loadForm(ctx, formId);
    if (form.status === "archived") return;
    await ctx.db.patch(formId, { status: "archived", publishedVersionId: undefined, updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "form.archived",
      resourceType: "form",
      resourceId: formId,
    });
  },
});

/** Bring an archived form back as a draft (publish again to serve it). */
export const restore = orgMutation({
  args: { formId: v.id("forms") },
  handler: async (ctx, { formId }) => {
    ctx.require("forms:manage");
    const form = await loadForm(ctx, formId);
    if (form.status !== "archived") return;
    await ctx.db.patch(formId, { status: "draft", updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "form.restored",
      resourceType: "form",
      resourceId: formId,
    });
  },
});

// ---------- Reading responses ----------

/** The caller may see the visit (same rule as `visits.get`). */
async function canSeeVisit(ctx: OrgCtx, visit: Doc<"visits">) {
  if (visit.organizationId !== ctx.oc.org._id || !hasSiteAccess(ctx.oc.membership, visit.siteId)) return false;
  const own = visit.hostUserId === ctx.oc.user._id && ctx.oc.permissions.has("visits:check_out_own");
  return ctx.oc.permissions.has("visits:read_site") || own;
}

/** Load a response the caller is allowed to read at all (not yet sensitive). */
async function loadReadableResponse(ctx: OrgCtx, responseId: Id<"formResponses">) {
  const response = await ctx.db.get(responseId);
  if (!response || response.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
  let allowed = false;
  if (response.visitId) {
    const visit = await ctx.db.get(response.visitId);
    allowed = Boolean(visit) && (await canSeeVisit(ctx, visit!));
  } else if (response.appointmentId) {
    const appt = await ctx.db.get(response.appointmentId);
    allowed =
      Boolean(appt) &&
      appt!.organizationId === ctx.oc.org._id &&
      hasSiteAccess(ctx.oc.membership, appt!.siteId) &&
      (ctx.oc.permissions.has("appointments:read_site") || appt!.hostUserId === ctx.oc.user._id);
  } else if (response.userId) {
    // A staff response: its author, a forms manager, or someone who may read
    // staff attendance at the site it was given at.
    allowed =
      response.userId === ctx.oc.user._id ||
      ctx.oc.permissions.has("forms:manage") ||
      (ctx.oc.permissions.has("staff_attendance:read_site") &&
        (!response.siteId || hasSiteAccess(ctx.oc.membership, response.siteId)));
  }
  if (!allowed) throw appError("NOT_FOUND");
  const version = await ctx.db.get(response.formVersionId);
  if (!version || version.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
  return { response, version };
}

/** Responses attached to a visit (and to the appointment it came from). */
export const visitResponses = orgQuery({
  args: { visitId: v.id("visits") },
  handler: async (ctx, { visitId }) => {
    const visit = await ctx.db.get(visitId);
    if (!visit || !(await canSeeVisit(ctx, visit))) throw appError("NOT_FOUND");
    const rows = await ctx.db
      .query("formResponses")
      .withIndex("by_visit", (q) => q.eq("visitId", visitId))
      .take(20);
    if (visit.appointmentId) {
      const fromAppt = await ctx.db
        .query("formResponses")
        .withIndex("by_appointment", (q) => q.eq("appointmentId", visit.appointmentId))
        .take(20);
      rows.push(...fromAppt.filter((r) => !rows.some((x) => x._id === r._id)));
    }
    const canReveal = ctx.oc.permissions.has("forms:read_sensitive");
    const out = [];
    for (const response of rows) {
      if (response.organizationId !== ctx.oc.org._id) continue;
      const version = await ctx.db.get(response.formVersionId);
      if (!version) continue;
      out.push({
        responseId: response._id,
        formName: version.name,
        version: version.version,
        createdAt: response.createdAt,
        items: await answerItems(ctx, version, response),
        canRevealSensitive: canReveal,
      });
    }
    return out;
  },
});

/**
 * Display items for one response. Sensitive answers are listed WITHOUT their
 * value (reading them is an audited mutation); file answers carry only the id
 * and whether the file is gone or was rejected by content verification.
 */
async function answerItems(ctx: OrgCtx, version: Doc<"formVersions">, response: Doc<"formResponses">) {
  const items = [];
  for (const f of fieldsOf(version)) {
    const a = response.answers[f.id];
    if (a === undefined) continue;
    if (f.sensitive) {
      items.push({ id: f.id, label: f.label, type: f.type, sensitive: true as const });
      continue;
    }
    if (typeof a === "object" && !Array.isArray(a) && "fileId" in a) {
      const file = await ctx.db.get(a.fileId);
      items.push({
        id: f.id,
        label: f.label,
        type: f.type,
        sensitive: false as const,
        file: fileState(a.fileId, file),
      });
      continue;
    }
    items.push({ id: f.id, label: f.label, type: f.type, sensitive: false as const, value: display(a) });
  }
  return items;
}

function fileState(fileId: Id<"files">, file: Doc<"files"> | null) {
  return {
    fileId,
    deleted: !file || file.status === "deleted",
    rejected: file?.verifyStatus === "rejected",
    verified: file?.verifyStatus === "verified",
  };
}

/**
 * Responses a person gave to staff forms (for example at clock-in). Allowed
 * for the person themselves and for anyone with `staff_attendance:read_site`,
 * limited to the sites the caller can access. Sensitive answers are withheld
 * exactly as for visits: `revealSensitive` is the audited way to read them.
 */
export const staffResponses = orgQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const isSelf = userId === ctx.oc.user._id;
    if (!isSelf) ctx.require("staff_attendance:read_site");
    const rows = await ctx.db
      .query("formResponses")
      .withIndex("by_org_user", (q) => q.eq("organizationId", ctx.oc.org._id).eq("userId", userId))
      .order("desc")
      .take(30);
    const canReveal = ctx.oc.permissions.has("forms:read_sensitive");
    const out = [];
    for (const response of rows) {
      if (response.siteId && !hasSiteAccess(ctx.oc.membership, response.siteId)) continue;
      const version = await ctx.db.get(response.formVersionId);
      if (!version || version.organizationId !== ctx.oc.org._id) continue;
      out.push({
        responseId: response._id,
        formName: version.name,
        version: version.version,
        createdAt: response.createdAt,
        items: await answerItems(ctx, version, response),
        canRevealSensitive: canReveal,
      });
    }
    return out;
  },
});

function display(a: unknown): string {
  if (typeof a === "boolean") return a ? "Yes" : "No";
  if (Array.isArray(a)) return a.join(", ");
  if (typeof a === "object" && a !== null) {
    if (isRedactedAnswer(a)) return "Removed (retention period ended)";
    const o = a as { accepted?: boolean; text?: string; scanned?: boolean };
    if (typeof o.accepted === "boolean") return `${o.accepted ? "Agreed" : "Declined"}: ${o.text ?? ""}`;
    if (o.scanned) return "ID scanned (image not kept)";
  }
  return String(a);
}

/**
 * Sensitive answers of one response. Needs `forms:read_sensitive`; always
 * audited (one entry per call, listing which fields were returned).
 */
export const revealSensitive = orgMutation({
  args: { responseId: v.id("formResponses") },
  handler: async (ctx, { responseId }) => {
    ctx.require("forms:read_sensitive");
    const { response, version } = await loadReadableResponse(ctx, responseId);
    const items = [];
    for (const f of fieldsOf(version)) {
      const a = response.answers[f.id];
      if (!f.sensitive || a === undefined) continue;
      if (typeof a === "object" && !Array.isArray(a) && "fileId" in a) {
        const file = await ctx.db.get(a.fileId);
        items.push({ id: f.id, label: f.label, type: f.type, file: fileState(a.fileId, file) });
      } else {
        items.push({ id: f.id, label: f.label, type: f.type, value: display(a) });
      }
    }
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "form_response.sensitive_read",
      resourceType: "formResponse",
      resourceId: responseId,
      metadata: { fields: items.map((i) => i.id).join(","), count: items.length },
    });
    return items;
  },
});

/**
 * A short-lived URL for one stored file. Sensitive fields and ID/face images
 * need `forms:read_sensitive`; other files need only access to the visit.
 * Every call is audited.
 */
export const openFile = orgMutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get(fileId);
    if (!file || file.organizationId !== ctx.oc.org._id || !file.responseId || !file.storageId || file.status !== "attached") {
      throw appError("NOT_FOUND");
    }
    const { version } = await loadReadableResponse(ctx, file.responseId);
    const field = fieldsOf(version).find((f) => f.id === file.fieldId);
    if (!field || field.sensitive || file.kind === "id_scan" || file.kind === "face_photo") {
      ctx.require("forms:read_sensitive");
    }
    // Nothing is opened until its bytes were checked against the declared type.
    if (file.verifyStatus !== "verified") throw appError("CONFLICT", "This file is still being checked. Try again in a moment.");
    const url = await ctx.storage.getUrl(file.storageId);
    if (!url) throw appError("NOT_FOUND");
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "file.read",
      resourceType: "file",
      resourceId: fileId,
      metadata: { kind: file.kind },
    });
    return { url, contentType: file.contentType };
  },
});
