import { describe, expect, test } from "vitest";
import {
  autoFillAnswers,
  formFieldSchema,
  formFieldsSchema,
  mappedValues,
  publishProblems,
  validateAnswers,
  visibleFields,
  type FormFieldInput,
} from "../../lib/validation/forms";

const f = (input: Partial<FormFieldInput> & { id: string; type: FormFieldInput["type"] }) =>
  formFieldSchema.parse({ label: input.id, ...input });

const fields = (...inputs: Parameters<typeof f>[0][]) => inputs.map(f);

const visitorFields = () =>
  fields(
    { id: "name", type: "short_text", required: true, mapsTo: "visitor.name" },
    { id: "phone", type: "phone", required: true, mapsTo: "visitor.phone" },
    { id: "purpose", type: "short_text", required: true, mapsTo: "visit.purpose" },
  );

describe("formFieldSchema", () => {
  test("applies defaults and forces sensitive on ID scans, faces and ID numbers", () => {
    expect(f({ id: "a", type: "short_text" })).toMatchObject({ required: false, sensitive: false });
    expect(f({ id: "scan", type: "id_scan" }).sensitive).toBe(true);
    expect(f({ id: "face", type: "face_photo" }).sensitive).toBe(true);
    expect(f({ id: "idn", type: "short_text", mapsTo: "visitor.idNumber" }).sensitive).toBe(true);
  });

  test("rejects bad ids, empty labels and choice fields without options", () => {
    expect(formFieldSchema.safeParse({ id: "Bad Id", type: "short_text", label: "x" }).success).toBe(false);
    expect(formFieldSchema.safeParse({ id: "a", type: "short_text", label: "  " }).success).toBe(false);
    expect(formFieldSchema.safeParse({ id: "a", type: "dropdown", label: "x" }).success).toBe(false);
    expect(formFieldSchema.safeParse({ id: "a", type: "dropdown", label: "x", options: ["A", "a"] }).success).toBe(false);
    expect(formFieldSchema.safeParse({ id: "a", type: "short_text", label: "x", options: ["A"] }).success).toBe(false);
  });

  test("consent needs text; only ID scans store images; mapping must suit the type", () => {
    expect(formFieldSchema.safeParse({ id: "c", type: "consent", label: "x" }).success).toBe(false);
    expect(formFieldSchema.safeParse({ id: "c", type: "short_text", label: "x", consentText: "hi" }).success).toBe(false);
    expect(formFieldSchema.safeParse({ id: "p", type: "photo", label: "x", storeImage: true }).success).toBe(false);
    expect(formFieldSchema.safeParse({ id: "n", type: "number", label: "x", mapsTo: "visitor.name" }).success).toBe(false);
    expect(formFieldSchema.safeParse({ id: "s", type: "id_scan", label: "x", storeImage: true }).success).toBe(true);
  });

  test("limits the number of fields and a showIf cannot point at itself", () => {
    const many = Array.from({ length: 61 }, (_, i) => ({ id: `f${i}`, type: "short_text", label: "x" }));
    expect(formFieldsSchema.safeParse(many).success).toBe(false);
    const self = { id: "a", type: "short_text", label: "x", showIf: { fieldId: "a", equals: "x" } };
    expect(formFieldSchema.safeParse(self).success).toBe(false);
  });
});

describe("publishProblems", () => {
  test("a visitor form must map name, phone and purpose as required and always shown", () => {
    expect(publishProblems([], { audience: "visitor" }).length).toBeGreaterThan(0);
    expect(publishProblems(visitorFields(), { audience: "visitor" })).toEqual([]);
    const hidden = fields(
      { id: "name", type: "short_text", required: true, mapsTo: "visitor.name" },
      { id: "phone", type: "phone", required: false, mapsTo: "visitor.phone" },
      { id: "purpose", type: "short_text", required: true, mapsTo: "visit.purpose" },
    );
    expect(publishProblems(hidden, { audience: "visitor" }).join(" ")).toMatch(/must be required/);
  });

  test("staff forms have no mapping requirements", () => {
    expect(publishProblems(fields({ id: "a", type: "short_text" }), { audience: "staff" })).toEqual([]);
  });

  test("showIf must point at an earlier field and a value it can hold", () => {
    const base = fields(
      { id: "kind", type: "single_choice", options: ["A", "B"] },
      { id: "extra", type: "short_text", showIf: { fieldId: "kind", equals: "C" } },
    );
    expect(publishProblems(base, { audience: "staff" }).join(" ")).toMatch(/cannot have/);
    const later = fields(
      { id: "extra", type: "short_text", showIf: { fieldId: "kind", equals: "A" } },
      { id: "kind", type: "single_choice", options: ["A"] },
    );
    expect(publishProblems(later, { audience: "staff" }).join(" ")).toMatch(/before it/);
  });

  test("a face photo needs the organization switch and an earlier required consent", () => {
    const withFace = (consent: boolean) =>
      fields(
        ...(consent ? [{ id: "ok", type: "consent" as const, required: true, consentText: "I agree." }] : []),
        { id: "face", type: "face_photo" },
      );
    expect(publishProblems(withFace(true), { audience: "staff", faceCaptureEnabled: false }).join(" ")).toMatch(/Settings/);
    expect(publishProblems(withFace(false), { audience: "staff", faceCaptureEnabled: true }).join(" ")).toMatch(/consent/);
    expect(publishProblems(withFace(true), { audience: "staff", faceCaptureEnabled: true })).toEqual([]);
  });

  test("two fields cannot map to the same target", () => {
    const dup = fields(
      { id: "a", type: "short_text", mapsTo: "visitor.company" },
      { id: "b", type: "short_text", mapsTo: "visitor.company" },
    );
    expect(publishProblems(dup, { audience: "staff" }).join(" ")).toMatch(/More than one/);
  });
});

describe("validateAnswers", () => {
  const form = fields(
    { id: "name", type: "short_text", required: true },
    { id: "age", type: "number" },
    { id: "email", type: "email" },
    { id: "phone", type: "phone" },
    { id: "day", type: "date" },
    { id: "when", type: "datetime" },
    { id: "size", type: "dropdown", options: ["S", "M"] },
    { id: "tags", type: "multi_choice", options: ["x", "y", "z"] },
    { id: "ok", type: "yes_no" },
    { id: "agree", type: "consent", required: true, consentText: "I agree to be recorded." },
    { id: "bio", type: "long_text" },
  );
  const good = { name: "Jane", agree: { accepted: true, text: "I agree to be recorded." } };

  test("accepts a valid set and trims text", () => {
    const res = validateAnswers(form, { ...good, name: "  Jane  ", age: 30, size: "M", tags: ["x", "z"], ok: false });
    expect(res).toEqual({
      ok: true,
      answers: { ...good, name: "Jane", age: 30, size: "M", tags: ["x", "z"], ok: false },
    });
  });

  test("required fields and unticked consent are errors", () => {
    const res = validateAnswers(form, { agree: { accepted: false, text: "I agree to be recorded." } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(Object.keys(res.errors).sort()).toEqual(["agree", "name"]);
  });

  test("consent must carry the exact text of the version", () => {
    const res = validateAnswers(form, { name: "J", agree: { accepted: true, text: "something else" } });
    expect(res.ok).toBe(false);
  });

  test("types, option membership and size limits", () => {
    const bad = (extra: Record<string, unknown>) => {
      const res = validateAnswers(form, { ...good, ...extra });
      expect(res.ok, JSON.stringify(extra)).toBe(false);
    };
    bad({ age: "30" });
    bad({ age: Number.POSITIVE_INFINITY });
    bad({ email: "nope" });
    bad({ phone: "12" });
    bad({ day: "2025-02-30" });
    bad({ when: "2025-02-10 10:00" });
    bad({ size: "XL" });
    bad({ tags: ["x", "x"] });
    bad({ tags: ["nope"] });
    bad({ ok: "yes" });
    bad({ name: "x".repeat(201) });
    bad({ bio: "x".repeat(4001) });
    bad({ ghost: "unknown field" });
    expect(validateAnswers(form, { ...good, day: "2025-02-28", when: "2025-02-10T10:00", email: "a@b.co" }).ok).toBe(true);
  });

  test("showIf hides fields: hidden answers are dropped and hidden required fields are not required", () => {
    const f2 = fields(
      { id: "has_car", type: "yes_no" },
      { id: "plate", type: "short_text", required: true, showIf: { fieldId: "has_car", equals: "yes" } },
      { id: "plate_note", type: "short_text", required: true, showIf: { fieldId: "plate", equals: "KDA" } },
    );
    expect(validateAnswers(f2, { has_car: false })).toEqual({ ok: true, answers: { has_car: false } });
    expect(validateAnswers(f2, { has_car: false, plate: "KDA" })).toEqual({ ok: true, answers: { has_car: false } });
    const missing = validateAnswers(f2, { has_car: true });
    expect(missing.ok).toBe(false);
    // chain: plate shown but plate_note only for plate = KDA
    expect(validateAnswers(f2, { has_car: true, plate: "KBB" }).ok).toBe(true);
    expect(validateAnswers(f2, { has_car: true, plate: "KDA" }).ok).toBe(false);
    expect(visibleFields(f2, { has_car: false }).map((x) => x.id)).toEqual(["has_car"]);
  });

  test("file fields take a file reference; ID scans may be read-and-discard", () => {
    const f3 = fields(
      { id: "sig", type: "signature", required: true },
      { id: "scan", type: "id_scan", required: true },
    );
    expect(validateAnswers(f3, { sig: "data:image/png;base64,AAAA", scan: { scanned: true } }).ok).toBe(false);
    expect(validateAnswers(f3, { sig: { fileId: "abc" }, scan: { scanned: true } }).ok).toBe(true);
    expect(validateAnswers(f3, { sig: { fileId: "abc" }, scan: { fileId: "def" } }).ok).toBe(true);
    expect(validateAnswers(f3, { sig: { fileId: "abc" } }).ok).toBe(false);
  });

  test("face photos are ignored (not required) when switched off", () => {
    const f4 = fields({ id: "face", type: "face_photo", required: true });
    expect(validateAnswers(f4, {}, { skipTypes: ["face_photo"] }).ok).toBe(true);
    expect(validateAnswers(f4, {}).ok).toBe(false);
  });

  test("rejects non-object answers", () => {
    expect(validateAnswers(form, null).ok).toBe(false);
    expect(validateAnswers(form, []).ok).toBe(false);
  });
});

describe("mapping helpers", () => {
  test("mappedValues copies mapped text but never the ID number", () => {
    const flds = fields(
      { id: "name", type: "short_text", mapsTo: "visitor.name" },
      { id: "idn", type: "short_text", mapsTo: "visitor.idNumber" },
      { id: "why", type: "short_text", mapsTo: "visit.purpose" },
    );
    const out = mappedValues(flds, { name: " Jane ", idn: "12345678", why: "Meeting" });
    expect(out).toEqual({ "visitor.name": "Jane", "visit.purpose": "Meeting" });
  });

  test("autoFillAnswers fills text fields mapped to confirmed invitation details", () => {
    const flds = fields(
      { id: "n", type: "short_text", mapsTo: "visitor.name" },
      { id: "p", type: "phone", mapsTo: "visitor.phone" },
      { id: "why", type: "single_choice", options: ["a"], mapsTo: "visit.purpose" },
    );
    expect(autoFillAnswers(flds, { name: "Jane", phone: "+254700000000", purpose: "a" })).toEqual({
      n: "Jane",
      p: "+254700000000",
    });
  });
});
