"use client";

import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { IdReader, IdReadResult } from "@/lib/ocr";
import { cn } from "@/lib/utils";
import type { FormField } from "@/lib/validation/forms";
import { CaptureField, type FileUploader } from "./capture-field";
import type { FormController } from "./use-form-controller";

export type RendererVariant = "kiosk" | "page";

const FILE_FIELD_TYPES = new Set(["signature", "file_upload", "photo", "id_scan", "face_photo"]);

/** A date from an ID reader is only usable as a suggestion if it is already YYYY-MM-DD. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Renders the visible fields of a form from a controller. Used by the kiosk,
 * the invitation page and the builder preview, so what an admin previews is
 * what visitors get. `hide` removes fields that were collected elsewhere
 * (invitation details).
 */
export function FormRenderer({
  fields,
  ctrl,
  uploader,
  variant = "page",
  hide,
  idReader,
}: {
  fields: FormField[];
  ctrl: FormController;
  uploader: FileUploader;
  variant?: RendererVariant;
  hide?: ReadonlySet<string>;
  idReader?: IdReader;
}) {
  const large = variant === "kiosk";
  const shown = ctrl.visible.filter((f) => !hide?.has(f.id));

  function onIdRead(result: IdReadResult) {
    for (const f of fields) {
      if (!f.idSource) continue;
      const hit = result.fields[f.idSource];
      if (!hit?.value) continue;
      if (f.type === "date" && !ISO_DATE.test(hit.value)) continue;
      ctrl.suggest(f.id, hit.value);
    }
  }

  return (
    <div className="space-y-5">
      {shown.map((f) => (
        <FieldBlock key={f.id} field={f} ctrl={ctrl} large={large}>
          <FieldInput
            field={f}
            ctrl={ctrl}
            large={large}
            uploader={uploader}
            idReader={idReader}
            onIdRead={onIdRead}
          />
        </FieldBlock>
      ))}
    </div>
  );
}

function FieldBlock({
  field,
  ctrl,
  large,
  children,
}: {
  field: FormField;
  ctrl: FormController;
  large: boolean;
  children: ReactNode;
}) {
  const error = ctrl.errors[field.id];
  const suggested = ctrl.suggested.has(field.id);
  const group = field.type === "single_choice" || field.type === "multi_choice" || field.type === "yes_no" || FILE_FIELD_TYPES.has(field.type);
  const id = `ff-${field.id}`;
  const optional = !field.required && <span className="font-normal text-muted-foreground"> (optional)</span>;
  return (
    <div className="space-y-2" data-field={field.id}>
      {field.type !== "consent" &&
        (group ? (
          <p id={`${id}-label`} className={cn("font-medium", large ? "text-lg" : "text-sm")}>
            {field.label}
            {optional}
          </p>
        ) : (
          <Label htmlFor={id} className={large ? "text-lg" : undefined}>
            {field.label}
            {optional}
          </Label>
        ))}
      {children}
      {suggested && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted p-2 text-sm">
          <span>Suggested from your ID. Please check it.</span>
          <Button type="button" size={large ? "lg" : "sm"} variant="outline" onClick={() => ctrl.confirm(field.id)}>
            <Check aria-hidden /> It is correct
          </Button>
        </div>
      )}
      {error ? (
        <p id={`${id}-error`} role="alert" className={cn("text-destructive", large ? "text-base" : "text-xs")}>
          {error}
        </p>
      ) : field.helpText ? (
        <p id={`${id}-help`} className={cn("text-muted-foreground", large ? "text-sm" : "text-xs")}>
          {field.helpText}
        </p>
      ) : null}
    </div>
  );
}

function FieldInput({
  field,
  ctrl,
  large,
  uploader,
  idReader,
  onIdRead,
}: {
  field: FormField;
  ctrl: FormController;
  large: boolean;
  uploader: FileUploader;
  idReader?: IdReader;
  onIdRead: (r: IdReadResult) => void;
}) {
  const id = `ff-${field.id}`;
  const value = ctrl.values[field.id];
  const invalid = Boolean(ctrl.errors[field.id]);
  const describedBy = invalid ? `${id}-error` : field.helpText ? `${id}-help` : undefined;
  const set = (v: unknown) => ctrl.setValue(field.id, v);
  const inputClass = large ? "h-14 px-4 text-lg md:text-lg" : undefined;
  const common = { id, "aria-invalid": invalid || undefined, "aria-describedby": describedBy } as const;
  const optionClass = cn("flex items-center gap-3 rounded-lg border p-3", large ? "min-h-14 text-lg" : "text-sm");

  switch (field.type) {
    case "short_text":
      return <Input {...common} className={inputClass} autoComplete="off" value={str(value)} onChange={(e) => set(e.target.value)} />;
    case "long_text":
      return <Textarea {...common} rows={4} className={large ? "px-4 text-lg md:text-lg" : undefined} value={str(value)} onChange={(e) => set(e.target.value)} />;
    case "number":
      return (
        <Input
          {...common}
          type="number"
          inputMode="decimal"
          className={inputClass}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
    case "phone":
      return <Input {...common} type="tel" inputMode="tel" autoComplete="off" className={inputClass} value={str(value)} onChange={(e) => set(e.target.value)} />;
    case "email":
      return <Input {...common} type="email" inputMode="email" autoComplete="off" className={inputClass} value={str(value)} onChange={(e) => set(e.target.value)} />;
    case "date":
      return <Input {...common} type="date" className={inputClass} value={str(value)} onChange={(e) => set(e.target.value)} />;
    case "datetime":
      return <Input {...common} type="datetime-local" className={inputClass} value={str(value)} onChange={(e) => set(e.target.value)} />;
    case "dropdown":
      return (
        <NativeSelect {...common} className={large ? "h-14 px-4 text-lg" : undefined} value={str(value)} onChange={(e) => set(e.target.value)}>
          <option value="">Choose…</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </NativeSelect>
      );
    case "single_choice":
      return (
        <div role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={describedBy} className="grid gap-2">
          {(field.options ?? []).map((o) => (
            <label key={o} className={optionClass}>
              <input type="radio" name={id} className="size-5" checked={value === o} onChange={() => set(o)} />
              {o}
            </label>
          ))}
        </div>
      );
    case "multi_choice": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy} className="grid gap-2">
          {(field.options ?? []).map((o) => (
            <label key={o} className={optionClass}>
              <input
                type="checkbox"
                className="size-5"
                checked={chosen.includes(o)}
                onChange={(e) => set(e.target.checked ? [...chosen, o] : chosen.filter((x) => x !== o))}
              />
              {o}
            </label>
          ))}
        </div>
      );
    }
    case "yes_no":
      return (
        <div role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={describedBy} className="grid grid-cols-2 gap-2">
          {([true, false] as const).map((b) => (
            <label key={String(b)} className={optionClass}>
              <input type="radio" name={id} className="size-5" checked={value === b} onChange={() => set(b)} />
              {b ? "Yes" : "No"}
            </label>
          ))}
        </div>
      );
    case "consent": {
      const accepted = (value as { accepted?: boolean } | undefined)?.accepted === true;
      return (
        <label className={cn(optionClass, "items-start")}>
          <input
            id={id}
            type="checkbox"
            className="mt-1 size-5 shrink-0"
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            checked={accepted}
            // The exact text shown is stored with the answer.
            onChange={(e) => set(e.target.checked ? { accepted: true, text: field.consentText ?? "" } : undefined)}
          />
          <span>
            <span className="font-medium">{field.label}</span>
            {!field.required && <span className="text-muted-foreground"> (optional)</span>}
            <span className="mt-1 block whitespace-pre-line text-muted-foreground">{field.consentText}</span>
          </span>
        </label>
      );
    }
    default:
      return (
        <CaptureField
          field={field}
          value={value}
          onChange={set}
          uploader={uploader}
          large={large}
          idReader={idReader}
          onIdRead={onIdRead}
          invalid={invalid}
          describedBy={describedBy}
        />
      );
  }
}

function str(v: unknown) {
  return typeof v === "string" ? v : "";
}
