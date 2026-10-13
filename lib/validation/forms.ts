import { z } from "zod";

/**
 * Form definitions and answers. This module is the single source of truth for
 * the field schema: the builder, the kiosk/invite renderer and the Convex
 * functions all import it. Never trust the client copy of a check; Convex
 * re-runs `validateAnswers` against the immutable published version.
 */

export const FIELD_TYPES = [
  "short_text",
  "long_text",
  "number",
  "phone",
  "email",
  "date",
  "datetime",
  "single_choice",
  "multi_choice",
  "dropdown",
  "yes_no",
  "consent",
  "signature",
  "file_upload",
  "photo",
  "id_scan",
  "face_photo",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  short_text: "Short text",
  long_text: "Long text",
  number: "Number",
  phone: "Phone number",
  email: "Email address",
  date: "Date",
  datetime: "Date and time",
  single_choice: "Single choice",
  multi_choice: "Multiple choice",
  dropdown: "Dropdown",
  yes_no: "Yes / No",
  consent: "Consent checkbox",
  signature: "Signature",
  file_upload: "File upload",
  photo: "Photo (camera)",
  id_scan: "ID scan",
  face_photo: "Face photo",
};

export const CHOICE_TYPES: readonly FieldType[] = ["single_choice", "multi_choice", "dropdown"];
/** Field types whose answer is a reference to a stored file. */
export const FILE_TYPES: readonly FieldType[] = ["signature", "file_upload", "photo", "id_scan", "face_photo"];

/** Well-known targets an answer can be copied to when a visit is created. */
export const MAPS_TO = [
  "visitor.name",
  "visitor.phone",
  "visitor.email",
  "visitor.company",
  "visitor.idNumber",
  "visit.purpose",
] as const;
export type MapsTo = (typeof MAPS_TO)[number];

export const MAPS_TO_LABELS: Record<MapsTo, string> = {
  "visitor.name": "Visitor name",
  "visitor.phone": "Visitor phone",
  "visitor.email": "Visitor email",
  "visitor.company": "Visitor company",
  "visitor.idNumber": "ID number (kept in the response, sensitive)",
  "visit.purpose": "Visit purpose",
};

/** What an ID reader can suggest for a field (see lib/ocr). */
export const ID_SOURCES = ["fullName", "idNumber", "dateOfBirth", "expiry", "documentType"] as const;
export type IdSource = (typeof ID_SOURCES)[number];

export const ID_SOURCE_LABELS: Record<IdSource, string> = {
  fullName: "Full name",
  idNumber: "ID number",
  dateOfBirth: "Date of birth",
  expiry: "Expiry date",
  documentType: "Document type",
};

export const FORM_LIMITS = {
  maxFields: 60,
  maxOptions: 50,
  maxOptionLength: 100,
  shortText: 200,
  longText: 4000,
  email: 254,
  label: 120,
  helpText: 300,
  consentText: 2000,
  maxRetentionDays: 3650,
} as const;

const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

export const fieldIdSchema = z.string().regex(ID_RE, "Use lowercase letters, digits and underscores.");

export const MAPS_COMPATIBLE: Record<MapsTo, readonly FieldType[]> = {
  "visitor.name": ["short_text"],
  "visitor.phone": ["phone", "short_text"],
  "visitor.email": ["email", "short_text"],
  "visitor.company": ["short_text"],
  "visitor.idNumber": ["short_text"],
  "visit.purpose": ["short_text", "long_text", "single_choice", "dropdown"],
};

export const formFieldSchema = z
  .object({
    id: fieldIdSchema,
    type: z.enum(FIELD_TYPES),
    label: z.string().trim().min(1, "Enter a label.").max(FORM_LIMITS.label),
    helpText: z.string().trim().max(FORM_LIMITS.helpText).optional(),
    required: z.boolean().default(false),
    options: z
      .array(z.string().trim().min(1, "Options cannot be empty.").max(FORM_LIMITS.maxOptionLength))
      .max(FORM_LIMITS.maxOptions)
      .optional(),
    showIf: z
      .object({ fieldId: fieldIdSchema, equals: z.string().trim().min(1).max(FORM_LIMITS.maxOptionLength) })
      .optional(),
    sensitive: z.boolean().default(false),
    retentionDays: z.number().int().min(1).max(FORM_LIMITS.maxRetentionDays).optional(),
    mapsTo: z.enum(MAPS_TO).optional(),
    /** Consent: the exact text the visitor sees; stored with the answer. */
    consentText: z.string().trim().min(1).max(FORM_LIMITS.consentText).optional(),
    /** id_scan only: keep the image (default is read and discard). */
    storeImage: z.boolean().optional(),
    /** Suggest this field's value from a scanned ID. */
    idSource: z.enum(ID_SOURCES).optional(),
  })
  .superRefine((f, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (CHOICE_TYPES.includes(f.type)) {
      const opts = f.options ?? [];
      if (opts.length < 1) issue("options", "Add at least one option.");
      if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) issue("options", "Options must be different.");
    } else if (f.options?.length) {
      issue("options", "Only choice fields have options.");
    }
    if (f.type === "consent" && !f.consentText) issue("consentText", "Enter the consent text visitors will agree to.");
    if (f.type !== "consent" && f.consentText) issue("consentText", "Only consent fields have consent text.");
    if (f.storeImage !== undefined && f.type !== "id_scan") issue("storeImage", "Only ID scan fields can store the image.");
    if (f.idSource && f.type !== "short_text" && f.type !== "date") {
      issue("idSource", "Only text and date fields can be filled from an ID.");
    }
    if (f.mapsTo && !MAPS_COMPATIBLE[f.mapsTo].includes(f.type)) {
      issue("mapsTo", `A ${FIELD_TYPE_LABELS[f.type].toLowerCase()} cannot map to ${MAPS_TO_LABELS[f.mapsTo].toLowerCase()}.`);
    }
    if (f.showIf && f.showIf.fieldId === f.id) issue("showIf", "A field cannot depend on itself.");
  })
  .transform((f) => ({
    ...f,
    // Faces, ID scans and ID numbers are always sensitive.
    sensitive: f.sensitive || f.type === "id_scan" || f.type === "face_photo" || f.mapsTo === "visitor.idNumber",
  }));

export type FormField = z.output<typeof formFieldSchema>;
export type FormFieldInput = z.input<typeof formFieldSchema>;

export const FORM_AUDIENCES = ["visitor", "staff"] as const;
export type FormAudience = (typeof FORM_AUDIENCES)[number];

export const formDetailsSchema = z.object({
  name: z.string().trim().min(2, "Enter a form name.").max(100),
  audience: z.enum(FORM_AUDIENCES),
  purpose: z.string().trim().max(200).optional(),
});

export const formFieldsSchema = z.array(formFieldSchema).max(FORM_LIMITS.maxFields);

/** Values a showIf rule compares against, per source field type (null = any text). */
function showIfValues(source: FormField): string[] | null {
  if (source.type === "yes_no") return ["yes", "no"];
  if (CHOICE_TYPES.includes(source.type)) return source.options ?? [];
  return null;
}

/**
 * Problems that stop a form being published (a draft may be incomplete).
 * Returns human readable messages, empty when publishable.
 */
export function publishProblems(
  fields: readonly FormField[],
  opts: { audience: FormAudience; faceCaptureEnabled?: boolean },
): string[] {
  const problems: string[] = [];
  if (fields.length === 0) problems.push("Add at least one field.");
  const ids = new Set<string>();
  const byId = new Map<string, number>();
  fields.forEach((f, i) => {
    if (ids.has(f.id)) problems.push(`Two fields share the id "${f.id}".`);
    ids.add(f.id);
    byId.set(f.id, i);
  });
  const mapped = new Set<string>();
  fields.forEach((f, i) => {
    if (f.showIf) {
      const idx = byId.get(f.showIf.fieldId);
      if (idx === undefined || idx >= i) {
        problems.push(`"${f.label}" depends on a field that does not come before it.`);
      } else {
        const source = fields[idx]!;
        const allowed = showIfValues(source);
        if (allowed && !allowed.includes(f.showIf.equals)) {
          problems.push(`"${f.label}" is shown for a value that "${source.label}" cannot have.`);
        }
      }
    }
    if (f.mapsTo) {
      if (mapped.has(f.mapsTo)) problems.push(`More than one field maps to ${MAPS_TO_LABELS[f.mapsTo].toLowerCase()}.`);
      mapped.add(f.mapsTo);
    }
    if (f.type === "face_photo") {
      if (!opts.faceCaptureEnabled) {
        problems.push("Face photos are off for this organization. Turn on face capture in Settings first.");
      }
      const hasConsent = fields.some((c, j) => j < i && c.type === "consent" && c.required);
      if (!hasConsent) problems.push(`"${f.label}" needs a required consent checkbox before it.`);
    }
  });
  if (opts.audience === "staff") {
    // Staff forms are answered at clock-in: they have no visit to fill, and
    // no signed-in upload path exists yet, so file-like fields are refused.
    for (const f of fields) {
      if (f.mapsTo) {
        problems.push(`"${f.label}" fills a visit record, which staff forms do not have. Remove "Fill into".`);
      }
      // (face photos are already reported above)
      if (FILE_TYPES.includes(f.type) && f.type !== "face_photo") {
        problems.push(
          `"${f.label}": ${FIELD_TYPE_LABELS[f.type].toLowerCase()} fields are not available on staff forms yet.`,
        );
      }
    }
  }
  if (opts.audience === "visitor") {
    for (const target of ["visitor.name", "visitor.phone", "visit.purpose"] as const) {
      const f = fields.find((x) => x.mapsTo === target);
      if (!f) problems.push(`Map a field to "${MAPS_TO_LABELS[target]}".`);
      else if (!f.required || f.showIf) {
        problems.push(`"${f.label}" (${MAPS_TO_LABELS[target]}) must be required and always shown.`);
      }
    }
  }
  return problems;
}

// ---------- Answers ----------

/** What replaces an answer once its retention period ended (see convex/formRetention.ts). */
export type RedactedAnswer = { redacted: true };
export const isRedactedAnswer = (a: unknown): a is RedactedAnswer =>
  typeof a === "object" && a !== null && !Array.isArray(a) && (a as { redacted?: unknown }).redacted === true;

export type AnswerValue =
  | string
  | number
  | boolean
  | string[]
  | { fileId: string }
  | { accepted: boolean; text: string }
  | { scanned: boolean };
export type Answers = Record<string, AnswerValue>;

function validDate(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Compare a showIf value against an answer. */
function matches(answer: unknown, equals: string): boolean {
  if (answer === undefined || answer === null) return false;
  if (typeof answer === "boolean") return (answer ? "yes" : "no") === equals;
  if (Array.isArray(answer)) return answer.includes(equals);
  if (typeof answer === "string" || typeof answer === "number") return String(answer) === equals;
  return false;
}

/**
 * Which fields are shown for the current answers. A field whose controlling
 * field is itself hidden is hidden too. `skipTypes` removes field types the
 * organization has switched off (face photos).
 */
export function visibleFields(
  fields: readonly FormField[],
  answers: Record<string, unknown>,
  skipTypes: readonly FieldType[] = [],
): FormField[] {
  const shown = new Set<string>();
  const out: FormField[] = [];
  for (const f of fields) {
    if (skipTypes.includes(f.type)) continue;
    if (f.showIf) {
      if (!shown.has(f.showIf.fieldId)) continue;
      if (!matches(answers[f.showIf.fieldId], f.showIf.equals)) continue;
    }
    shown.add(f.id);
    out.push(f);
  }
  return out;
}

type Checked = { ok: true; value: AnswerValue } | { ok: false; error: string };

const isFileId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 64;

function checkAnswer(f: FormField, value: unknown): Checked {
  const bad = (error: string): Checked => ({ ok: false, error });
  const good = (v: AnswerValue): Checked => ({ ok: true, value: v });
  switch (f.type) {
    case "short_text": {
      if (typeof value !== "string") return bad("Enter text.");
      const s = value.trim();
      return s.length > FORM_LIMITS.shortText ? bad(`Use at most ${FORM_LIMITS.shortText} characters.`) : good(s);
    }
    case "long_text": {
      if (typeof value !== "string") return bad("Enter text.");
      const s = value.trim();
      return s.length > FORM_LIMITS.longText ? bad(`Use at most ${FORM_LIMITS.longText} characters.`) : good(s);
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12
        ? good(value)
        : bad("Enter a number.");
    case "phone": {
      if (typeof value !== "string") return bad("Enter a phone number.");
      const s = value.trim();
      return PHONE_RE.test(s) && s.replace(/\D/g, "").length >= 7 ? good(s) : bad("Enter a valid phone number.");
    }
    case "email": {
      if (typeof value !== "string") return bad("Enter an email address.");
      const s = value.trim();
      return s.length <= FORM_LIMITS.email && z.email().safeParse(s).success
        ? good(s)
        : bad("Enter a valid email address.");
    }
    case "date":
      return typeof value === "string" && validDate(value) ? good(value) : bad("Enter a valid date.");
    case "datetime": {
      if (typeof value !== "string") return bad("Enter a date and time.");
      const m = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d$/.exec(value);
      return m && validDate(m[1]!) ? good(value) : bad("Enter a valid date and time.");
    }
    case "single_choice":
    case "dropdown":
      return typeof value === "string" && (f.options ?? []).includes(value)
        ? good(value)
        : bad("Choose one of the options.");
    case "multi_choice": {
      if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) return bad("Choose from the options.");
      const list = value as string[];
      const set = new Set(list);
      if (set.size !== list.length || list.some((x) => !(f.options ?? []).includes(x))) {
        return bad("Choose from the options.");
      }
      return good(list);
    }
    case "yes_no":
      return typeof value === "boolean" ? good(value) : bad("Choose yes or no.");
    case "consent": {
      const v = value as { accepted?: unknown; text?: unknown } | null;
      if (!v || typeof v !== "object" || typeof v.accepted !== "boolean" || typeof v.text !== "string") {
        return bad("Tick the box to agree.");
      }
      // The stored text must be exactly what this version showed.
      if (v.text !== f.consentText) return bad("The consent text changed. Please reload and try again.");
      return good({ accepted: v.accepted, text: v.text });
    }
    case "id_scan": {
      const v = value as { scanned?: unknown; fileId?: unknown } | null;
      if (v && typeof v === "object" && isFileId(v.fileId)) return good({ fileId: v.fileId });
      if (v && typeof v === "object" && v.scanned === true) return good({ scanned: true });
      return bad("Scan your ID.");
    }
    default: {
      // signature, file_upload, photo, face_photo
      const v = value as { fileId?: unknown } | null;
      return v && typeof v === "object" && isFileId(v.fileId) ? good({ fileId: v.fileId }) : bad("Add this item.");
    }
  }
}

export type AnswerCheck = { ok: true; answers: Answers } | { ok: false; errors: Record<string, string> };

/**
 * Validate answers against a version's fields: unknown keys, visibility
 * (showIf), required, type, option membership and size limits. Answers for
 * hidden fields are dropped. File ids are only shape-checked here; Convex
 * verifies ownership separately.
 */
export function validateAnswers(
  fields: readonly FormField[],
  raw: unknown,
  opts: { skipTypes?: readonly FieldType[] } = {},
): AnswerCheck {
  const errors: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: { _form: "Invalid answers." } };
  const input = raw as Record<string, unknown>;
  const known = new Set(fields.map((f) => f.id));
  for (const key of Object.keys(input)) if (!known.has(key)) errors[key] = "Unknown field.";
  const answers: Answers = {};
  for (const f of visibleFields(fields, input, opts.skipTypes)) {
    const value = input[f.id];
    const empty =
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0) ||
      (f.type === "consent" && (value as { accepted?: unknown } | undefined)?.accepted !== true);
    if (empty) {
      if (f.required) errors[f.id] = f.type === "consent" ? "You must agree to continue." : "This is required.";
      continue;
    }
    const res = checkAnswer(f, value);
    if (res.ok) answers[f.id] = res.value;
    else errors[f.id] = res.error;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, answers };
}

/**
 * Copy mapped answers into the targets a visit needs. `visitor.idNumber` is
 * deliberately not returned: it stays in the (sensitive) response only.
 */
export function mappedValues(fields: readonly FormField[], answers: Answers) {
  const out: Partial<Record<Exclude<MapsTo, "visitor.idNumber">, string>> = {};
  for (const f of fields) {
    if (!f.mapsTo || f.mapsTo === "visitor.idNumber") continue;
    const a = answers[f.id];
    if (typeof a === "string" && a.trim()) out[f.mapsTo] = a.trim();
  }
  return out;
}

/**
 * Invitation links already collect name, phone, email, company and purpose
 * in a "confirm your details" step. Form fields mapped to those targets (and
 * able to hold the value as text) are filled from that step instead of being
 * asked twice. The server applies the same rule, so both sides agree.
 */
export type InviteDetails = {
  name: string;
  phone: string;
  email?: string;
  company?: string;
  purpose: string;
};

const AUTOFILL_TARGETS: Partial<Record<MapsTo, keyof InviteDetails>> = {
  "visitor.name": "name",
  "visitor.phone": "phone",
  "visitor.email": "email",
  "visitor.company": "company",
  "visit.purpose": "purpose",
};
const TEXT_TYPES: readonly FieldType[] = ["short_text", "long_text", "phone", "email"];

export function isAutoFilled(field: FormField): boolean {
  return Boolean(field.mapsTo && AUTOFILL_TARGETS[field.mapsTo] && TEXT_TYPES.includes(field.type));
}

/** Answers for auto-filled fields, from the confirmed details. */
export function autoFillAnswers(fields: readonly FormField[], details: InviteDetails): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (!isAutoFilled(f)) continue;
    const value = details[AUTOFILL_TARGETS[f.mapsTo!]!];
    if (value) out[f.id] = value;
  }
  return out;
}

/**
 * Like `autoFillAnswers`, but keeps only values the field would accept. A
 * stored phone or email that no longer passes the field's rules is dropped, so
 * the answerer is asked for it instead of being blocked by an error on a field
 * they cannot see.
 */
export function usableAutoFill(fields: readonly FormField[], details: InviteDetails): Record<string, string> {
  const raw = autoFillAnswers(fields, details);
  const out: Record<string, string> = {};
  for (const f of fields) {
    const value = raw[f.id];
    if (value === undefined) continue;
    const res = validateAnswers([{ ...f, required: false, showIf: undefined }], { [f.id]: value });
    if (res.ok) out[f.id] = value;
  }
  return out;
}

// ---------- Files ----------

export const FILE_KINDS = ["photo", "signature", "file", "id_scan", "face_photo"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_LIMITS: Record<FileKind, { maxBytes: number; types: readonly string[] }> = {
  photo: { maxBytes: 3_000_000, types: ["image/jpeg", "image/png", "image/webp"] },
  face_photo: { maxBytes: 3_000_000, types: ["image/jpeg", "image/png", "image/webp"] },
  id_scan: { maxBytes: 3_000_000, types: ["image/jpeg", "image/png", "image/webp"] },
  signature: { maxBytes: 500_000, types: ["image/png"] },
  file: { maxBytes: 5_000_000, types: ["application/pdf", "image/jpeg", "image/png"] },
};

export function fileKindForField(type: FieldType): FileKind | null {
  switch (type) {
    case "photo":
      return "photo";
    case "face_photo":
      return "face_photo";
    case "id_scan":
      return "id_scan";
    case "signature":
      return "signature";
    case "file_upload":
      return "file";
    default:
      return null;
  }
}

/** Default days a stored file is kept when the field sets no retention. */
export const DEFAULT_FILE_RETENTION_DAYS = 90;
/** Uploads not attached to a response within this window are deleted. */
export const PENDING_FILE_TTL_MS = 60 * 60 * 1000;

// ---------- Invitations ----------

export const invitationSubmitSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(120),
  phone: z
    .string()
    .trim()
    .regex(PHONE_RE, "Enter a valid phone number.")
    .refine((s) => s.replace(/\D/g, "").length >= 7, "Enter a valid phone number."),
  email: z
    .email("Enter a valid email address.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  company: z.string().trim().max(120).optional(),
});

export const invitationCreateSchema = z
  .object({
    visitorName: z.string().trim().max(120).optional(),
    visitorPhone: z.string().trim().max(20).optional(),
    visitorEmail: z.string().trim().max(254).optional(),
    purpose: z.string().trim().min(2, "Enter the purpose of the visit.").max(300),
    scheduledStart: z.number().int(),
    scheduledEnd: z.number().int(),
  })
  .refine((a) => a.scheduledEnd > a.scheduledStart, {
    path: ["scheduledEnd"],
    message: "The end time must be after the start time.",
  });
