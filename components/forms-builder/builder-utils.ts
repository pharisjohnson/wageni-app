import {
  CHOICE_TYPES,
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  FORM_LIMITS,
  MAPS_COMPATIBLE,
  MAPS_TO,
  type FieldType,
  type FormFieldInput,
  type MapsTo,
} from "@/lib/validation/forms";

/** What the builder edits: the zod input shape with booleans always present. */
export type DraftField = FormFieldInput & { required: boolean; sensitive: boolean };

export function uniqueFieldId(type: FieldType, existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let n = 1; n <= FORM_LIMITS.maxFields + 1; n++) {
    const id = `${type}_${n}`;
    if (!taken.has(id)) return id;
  }
  return `${type}_${Date.now()}`;
}

export function newField(type: FieldType, existing: readonly string[]): DraftField {
  return {
    id: uniqueFieldId(type, existing),
    type,
    label: FIELD_TYPE_LABELS[type],
    required: false,
    sensitive: type === "id_scan" || type === "face_photo",
    ...(CHOICE_TYPES.includes(type) ? { options: ["Option 1", "Option 2"] } : {}),
    ...(type === "consent" ? { consentText: "I agree to the processing of my personal data as described in the privacy notice." } : {}),
    ...(type === "id_scan" ? { storeImage: false } : {}),
  };
}

/** Switching type keeps what still makes sense and drops the rest. */
export function changeType(field: DraftField, type: FieldType): DraftField {
  const next: DraftField = { ...field, type };
  if (!CHOICE_TYPES.includes(type)) delete next.options;
  else next.options = field.options?.length ? field.options : ["Option 1", "Option 2"];
  if (type !== "consent") delete next.consentText;
  else next.consentText = field.consentText ?? "I agree.";
  if (type !== "id_scan") delete next.storeImage;
  if (type !== "short_text" && type !== "date") delete next.idSource;
  if (next.mapsTo && !MAPS_COMPATIBLE[next.mapsTo].includes(type)) delete next.mapsTo;
  if (type === "id_scan" || type === "face_photo") next.sensitive = true;
  return next;
}

/** Drop empty optional values so the server schema sees a tidy field. */
export function cleanField(f: DraftField): DraftField {
  const out: Record<string, unknown> = { ...f };
  for (const key of ["helpText", "mapsTo", "consentText", "idSource", "showIf", "retentionDays", "options", "storeImage"]) {
    const v = out[key];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "number" && Number.isNaN(v))) {
      delete out[key];
    }
  }
  const showIf = out.showIf as { fieldId?: string; equals?: string } | undefined;
  if (showIf && (!showIf.fieldId || !showIf.equals)) delete out.showIf;
  return out as DraftField;
}

/** Field types a staff form cannot use: files need an upload path that staff forms do not have yet. */
export const STAFF_BLOCKED_TYPES: readonly FieldType[] = ["signature", "file_upload", "photo", "id_scan", "face_photo"];

/** Field types the builder offers for an audience. */
export function fieldTypesFor(audience: "visitor" | "staff"): FieldType[] {
  return FIELD_TYPES.filter((t) => audience === "visitor" || !STAFF_BLOCKED_TYPES.includes(t));
}

export function compatibleTargets(type: FieldType): MapsTo[] {
  return MAPS_TO.filter((t) => MAPS_COMPATIBLE[t].includes(type));
}

/** A starting point for a new visitor form: the fields every visit needs. */
export function starterFields(): DraftField[] {
  return [
    { id: "name", type: "short_text", label: "Your name", required: true, sensitive: false, mapsTo: "visitor.name" },
    { id: "phone", type: "phone", label: "Phone number", required: true, sensitive: false, mapsTo: "visitor.phone", helpText: "You will need the last 4 digits to sign out." },
    { id: "company", type: "short_text", label: "Company", required: false, sensitive: false, mapsTo: "visitor.company" },
    { id: "purpose", type: "short_text", label: "Reason for your visit", required: true, sensitive: false, mapsTo: "visit.purpose" },
  ];
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
