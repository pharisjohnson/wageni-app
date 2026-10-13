"use client";

import { useCallback, useMemo, useState } from "react";
import {
  validateAnswers,
  visibleFields,
  type Answers,
  type FieldType,
  type FormField,
} from "@/lib/validation/forms";

/**
 * State for rendering a form. Personal data lives here (React state) and
 * nowhere else; leaving the screen discards it.
 *
 * ID-scan suggestions: `suggest()` pre-fills a field and marks it unconfirmed.
 * The visitor must confirm or edit each one; `validate()` refuses to continue
 * while any visible suggestion is unconfirmed.
 */
export function useFormController(fields: FormField[], opts: { skipTypes?: readonly FieldType[] } = {}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [suggested, setSuggested] = useState<ReadonlySet<string>>(new Set());
  const { skipTypes } = opts;

  const setValue = useCallback((id: string, value: unknown) => {
    setValues((v) => {
      const next = { ...v };
      if (value === undefined || value === "") delete next[id];
      else next[id] = value;
      return next;
    });
    // Editing a suggested value counts as confirming it.
    setSuggested((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    setErrors((e) => {
      if (!(id in e)) return e;
      const next = { ...e };
      delete next[id];
      return next;
    });
  }, []);

  const suggest = useCallback((id: string, value: string) => {
    setValues((v) => ({ ...v, [id]: value }));
    setSuggested((s) => new Set(s).add(id));
  }, []);

  const confirm = useCallback((id: string) => {
    setSuggested((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setValues({});
    setErrors({});
    setSuggested(new Set());
  }, []);

  const visible = useMemo(() => visibleFields(fields, values, skipTypes), [fields, values, skipTypes]);

  /**
   * Validate with the shared rules. `extra` supplies answers for fields that
   * are not rendered (filled from other steps). Returns clean answers, or
   * null after recording per-field errors.
   */
  const validate = useCallback(
    (extra: Record<string, unknown> = {}): Answers | null => {
      const all = { ...values, ...extra };
      const res = validateAnswers(fields, all, { skipTypes });
      const problems: Record<string, string> = res.ok ? {} : { ...res.errors };
      for (const f of visibleFields(fields, all, skipTypes)) {
        if (suggested.has(f.id)) problems[f.id] = "Please check this and confirm it, or correct it.";
      }
      setErrors(problems);
      return res.ok && Object.keys(problems).length === 0 ? res.answers : null;
    },
    [fields, values, skipTypes, suggested],
  );

  return { values, setValue, errors, setErrors, suggested, suggest, confirm, reset, visible, validate };
}

export type FormController = ReturnType<typeof useFormController>;
