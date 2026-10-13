"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Field } from "@/components/forms/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  CHOICE_TYPES,
  FIELD_TYPE_LABELS,
  ID_SOURCES,
  ID_SOURCE_LABELS,
  MAPS_TO_LABELS,
  type FieldType,
  type IdSource,
  type MapsTo,
} from "@/lib/validation/forms";
import { cleanField, compatibleTargets, fieldTypesFor, type DraftField } from "./builder-utils";

type Values = {
  type: FieldType;
  label: string;
  helpText: string;
  required: boolean;
  sensitive: boolean;
  retentionDays: string;
  optionsText: string;
  consentText: string;
  storeImage: boolean;
  mapsTo: string;
  idSource: string;
  showFieldId: string;
  showEquals: string;
};

function toValues(f: DraftField): Values {
  return {
    type: f.type,
    label: f.label,
    helpText: f.helpText ?? "",
    required: f.required,
    sensitive: f.sensitive,
    retentionDays: f.retentionDays ? String(f.retentionDays) : "",
    optionsText: (f.options ?? []).join("\n"),
    consentText: f.consentText ?? "",
    storeImage: f.storeImage ?? false,
    mapsTo: f.mapsTo ?? "",
    idSource: f.idSource ?? "",
    showFieldId: f.showIf?.fieldId ?? "",
    showEquals: f.showIf?.equals ?? "",
  };
}

function fromValues(id: string, v: Values): DraftField {
  const choice = CHOICE_TYPES.includes(v.type);
  const forced = v.type === "id_scan" || v.type === "face_photo" || v.mapsTo === "visitor.idNumber";
  return cleanField({
    id,
    type: v.type,
    label: v.label,
    helpText: v.helpText.trim(),
    required: v.required,
    sensitive: v.sensitive || forced,
    retentionDays: v.retentionDays ? Number(v.retentionDays) : undefined,
    options: choice ? v.optionsText.split("\n").map((s) => s.trim()).filter(Boolean) : undefined,
    consentText: v.type === "consent" ? v.consentText.trim() : undefined,
    storeImage: v.type === "id_scan" ? v.storeImage : undefined,
    mapsTo: (v.mapsTo || undefined) as MapsTo | undefined,
    idSource: v.type === "short_text" || v.type === "date" ? ((v.idSource || undefined) as IdSource | undefined) : undefined,
    showIf: v.showFieldId ? { fieldId: v.showFieldId, equals: v.showEquals.trim() } : undefined,
  });
}

/**
 * Edits one field. Remount it (key = field id) when another field is
 * selected. Changes are pushed up as the user types; the parent validates
 * the whole form with the shared zod schema before saving.
 */
export function FieldEditor({
  field,
  earlier,
  onChange,
  audience = "visitor",
}: {
  /** Staff forms have no visit to fill and no file fields. */
  audience?: "visitor" | "staff";
  field: DraftField;
  /** Fields before this one: the only ones a "show if" rule may depend on. */
  earlier: DraftField[];
  onChange: (next: DraftField) => void;
}) {
  const form = useForm<Values>({ defaultValues: toValues(field) });
  const { register, watch } = form;

  useEffect(() => {
    const sub = watch((values) => onChange(fromValues(field.id, values as Values)));
    return () => sub.unsubscribe();
  }, [watch, onChange, field.id]);

  const v = watch();
  const choice = CHOICE_TYPES.includes(v.type);
  const forcedSensitive = v.type === "id_scan" || v.type === "face_photo" || v.mapsTo === "visitor.idNumber";
  const source = earlier.find((f) => f.id === v.showFieldId);
  const sourceValues =
    source?.type === "yes_no" ? ["yes", "no"] : source && CHOICE_TYPES.includes(source.type) ? (source.options ?? []) : null;
  const isFile = ["signature", "file_upload", "photo", "id_scan", "face_photo"].includes(v.type);
  const check = "size-4 accent-primary";

  return (
    <div className="grid gap-4 sm:grid-cols-2" aria-label={`Settings for ${field.label}`}>
      <Field id="fe-type" label="Field type">
        <NativeSelect id="fe-type" {...register("type")}>
          {fieldTypesFor(audience).map((t) => (
            <option key={t} value={t}>
              {FIELD_TYPE_LABELS[t]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="fe-label" label="Label">
        <Input id="fe-label" {...register("label")} />
      </Field>
      <div className="sm:col-span-2">
        <Field id="fe-help" label="Help text (optional)">
          <Input id="fe-help" {...register("helpText")} />
        </Field>
      </div>

      {choice && (
        <div className="sm:col-span-2">
          <Field id="fe-options" label="Options" help="One option per line.">
            <Textarea id="fe-options" rows={4} {...register("optionsText")} />
          </Field>
        </div>
      )}

      {v.type === "consent" && (
        <div className="sm:col-span-2">
          <Field id="fe-consent" label="Consent text" help="Shown exactly like this to the visitor, and stored with their answer.">
            <Textarea id="fe-consent" rows={3} {...register("consentText")} />
          </Field>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className={check} {...register("required")} /> Required
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className={check} checked={forcedSensitive || v.sensitive} disabled={forcedSensitive} {...register("sensitive")} />
          Sensitive (only people with the sensitive-data permission can read it)
        </label>
        {v.type === "id_scan" && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className={check} {...register("storeImage")} /> Keep the ID image (default: read it, then discard it)
          </label>
        )}
      </div>

      <Field
        id="fe-retention"
        label="Keep for (days)"
        help={
          isFile
            ? "Stored files are deleted after this. Blank = 90 days."
            : `The answer is removed after this many days (the form keeps a note that it was removed). Blank = ${audience === "staff" ? "the organization's attendance retention" : "the organization's visitor-record retention"}. Never shorter than the organization minimum (${audience === "staff" ? "365" : "30"} days).`
        }
      >
        <Input id="fe-retention" type="number" min={1} max={3650} {...register("retentionDays")} />
      </Field>

      {audience === "visitor" && (
        <Field id="fe-maps" label="Fill into" help="Copies the answer into the visit record.">
          <NativeSelect id="fe-maps" {...register("mapsTo")}>
            <option value="">Nothing (kept in the form response)</option>
            {compatibleTargets(v.type).map((t) => (
              <option key={t} value={t}>
                {MAPS_TO_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}

      {audience === "visitor" && (v.type === "short_text" || v.type === "date") && (
        <Field id="fe-idsource" label="Suggest from ID scan" help="Pre-filled for the visitor to check, never trusted blindly.">
          <NativeSelect id="fe-idsource" {...register("idSource")}>
            <option value="">No suggestion</option>
            {ID_SOURCES.map((s) => (
              <option key={s} value={s}>
                {ID_SOURCE_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}

      <fieldset className="grid gap-4 rounded-lg border p-3 sm:col-span-2 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium">Show only if…</legend>
        <Field id="fe-showfield" label="Another field">
          <NativeSelect id="fe-showfield" {...register("showFieldId")}>
            <option value="">Always show</option>
            {earlier.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {v.showFieldId && (
          <Field id="fe-showequals" label="Equals">
            {sourceValues ? (
              <NativeSelect id="fe-showequals" {...register("showEquals")}>
                <option value="">Choose…</option>
                {sourceValues.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <Input id="fe-showequals" {...register("showEquals")} />
            )}
          </Field>
        )}
      </fieldset>
    </div>
  );
}
