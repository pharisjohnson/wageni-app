import { describe, expect, test } from "vitest";
import { initialRedactionCheck, NO_REDACTION_DUE, planRedaction, REDACTION_RECHECK_MS } from "../../lib/answer-retention";
import { sniffContentType, verifyBlobBytes } from "../../lib/files/magic";
import { cleanOrigin, resolveInviteOrigin } from "../../lib/invite/origin";
import { answerRetentionDays, DAY_MS, MIN_RETENTION } from "../../lib/retention";
import { clientIp, hashIp } from "../../lib/server/client-ip";
import {
  formFieldSchema,
  publishProblems,
  usableAutoFill,
  type FormField,
  type FormFieldInput,
} from "../../lib/validation/forms";

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
const WEBP = Uint8Array.from([...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8 ")]);
const PDF = ascii("%PDF-1.7\n%\xE2\xE3");

describe("sniffContentType", () => {
  test("recognises the allowed formats by their signatures", () => {
    expect(sniffContentType(JPEG)).toBe("image/jpeg");
    expect(sniffContentType(PNG)).toBe("image/png");
    expect(sniffContentType(WEBP)).toBe("image/webp");
    expect(sniffContentType(PDF)).toBe("application/pdf");
  });

  test("everything else is unrecognised", () => {
    expect(sniffContentType(ascii("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffContentType(ascii("GIF89a......"))).toBeNull();
    expect(sniffContentType(new Uint8Array(16))).toBeNull();
    expect(sniffContentType(new Uint8Array(0))).toBeNull();
    // Truncated signatures do not match.
    expect(sniffContentType(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    // RIFF that is not WEBP (e.g. WAV).
    expect(sniffContentType(Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]))).toBeNull();
    // PDF must start with the marker, not merely contain it.
    expect(sniffContentType(ascii(" %PDF-1.4"))).toBeNull();
  });
});

describe("verifyBlobBytes", () => {
  const base = { recordedSize: 1000, actualSize: 1000 };

  test("accepts matching bytes, declared type and size", () => {
    expect(verifyBlobBytes({ ...base, kind: "photo", declaredType: "image/jpeg", head: JPEG })).toEqual({
      ok: true,
      contentType: "image/jpeg",
    });
    expect(verifyBlobBytes({ ...base, kind: "file", declaredType: "application/pdf", head: PDF }).ok).toBe(true);
    expect(verifyBlobBytes({ ...base, kind: "signature", declaredType: "IMAGE/PNG", head: PNG }).ok).toBe(true);
  });

  test("rejects a declared type the bytes do not match", () => {
    expect(verifyBlobBytes({ ...base, kind: "photo", declaredType: "image/png", head: JPEG })).toEqual({
      ok: false,
      reason: "type_mismatch",
    });
    // A script declared as an image.
    expect(verifyBlobBytes({ ...base, kind: "photo", declaredType: "image/png", head: ascii("<svg onload=x>") })).toEqual({
      ok: false,
      reason: "unrecognised",
    });
  });

  test("signatures are PNG only; a real JPEG or PDF is not allowed there", () => {
    expect(verifyBlobBytes({ ...base, kind: "signature", declaredType: "image/jpeg", head: JPEG })).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(verifyBlobBytes({ ...base, kind: "photo", declaredType: "application/pdf", head: PDF })).toEqual({
      ok: false,
      reason: "not_allowed",
    });
  });

  test("checks size: empty, over the limit, and different from what was recorded", () => {
    expect(verifyBlobBytes({ ...base, actualSize: 0, kind: "photo", declaredType: "image/jpeg", head: JPEG })).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      verifyBlobBytes({ recordedSize: 600_000, actualSize: 600_000, kind: "signature", declaredType: "image/png", head: PNG }),
    ).toEqual({ ok: false, reason: "too_large" });
    expect(
      verifyBlobBytes({ recordedSize: 1000, actualSize: 1200, kind: "photo", declaredType: "image/jpeg", head: JPEG }),
    ).toEqual({ ok: false, reason: "size_mismatch" });
  });
});

describe("invitation origin", () => {
  test("accepts clean https origins and normalises them", () => {
    expect(cleanOrigin("https://app.example.com")).toBe("https://app.example.com");
    expect(cleanOrigin("https://app.example.com/")).toBe("https://app.example.com");
    expect(cleanOrigin("https://app.example.com:8443")).toBe("https://app.example.com:8443");
    expect(cleanOrigin(" https://APP.example.com ")).toBe("https://app.example.com");
  });

  test("rejects credentials, paths, queries, fragments and other schemes", () => {
    for (const bad of [
      "https://user:pw@app.example.com",
      "https://user@app.example.com",
      "https://app.example.com/invite",
      "https://app.example.com/?x=1",
      "https://app.example.com?",
      "https://app.example.com/#frag",
      "https://app.example.com#",
      "javascript:alert(1)",
      "ftp://app.example.com",
      "//app.example.com",
      "app.example.com",
      "",
      "https://",
      "https://" + "a".repeat(400) + ".com",
    ]) {
      expect(cleanOrigin(bad), bad).toBeNull();
    }
  });

  test("plain http is accepted for localhost only, and only when local origins are allowed", () => {
    expect(cleanOrigin("http://localhost:3000")).toBeNull();
    expect(cleanOrigin("http://localhost:3000", { allowLocal: true })).toBe("http://localhost:3000");
    expect(cleanOrigin("http://127.0.0.1:3000", { allowLocal: true })).toBe("http://127.0.0.1:3000");
    expect(cleanOrigin("http://app.example.com", { allowLocal: true })).toBeNull();
    expect(cleanOrigin("http://localhost.evil.com", { allowLocal: true })).toBeNull();
    expect(cleanOrigin("http://localhost:3000/x", { allowLocal: true })).toBeNull();
  });

  test("APP_BASE_URL wins; otherwise the validated origin; otherwise nothing", () => {
    expect(resolveInviteOrigin({ configured: "https://wageni.example.com/", requested: "https://evil.example" })).toBe(
      "https://wageni.example.com",
    );
    expect(resolveInviteOrigin({ configured: "", requested: "https://app.example.com" })).toBe("https://app.example.com");
    expect(resolveInviteOrigin({ requested: "https://u:p@app.example.com" })).toBe("");
    expect(resolveInviteOrigin({})).toBe("");
  });
});

describe("client IP and hashing", () => {
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

  test("reads the platform headers in order of trust", () => {
    expect(clientIp(headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1" }))).toBe("203.0.113.9");
    expect(clientIp(headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }))).toBe("198.51.100.4");
    expect(clientIp(headers({ "x-forwarded-for": "2001:DB8::1" }))).toBe("2001:db8::1");
    expect(clientIp(headers({ "x-custom": "192.0.2.1", "x-real-ip": "203.0.113.9" }), { header: "x-custom" })).toBe("192.0.2.1");
  });

  test("ignores values that are not addresses", () => {
    expect(clientIp(headers({}))).toBeNull();
    expect(clientIp(headers({ "x-real-ip": "not an ip", "x-forwarded-for": "<script>" }))).toBeNull();
    expect(clientIp(headers({ "x-forwarded-for": "a".repeat(100) }))).toBeNull();
  });

  test("hashes are keyed, stable, and hide the address", async () => {
    const a = await hashIp("203.0.113.9", "secret-one-0123456789");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashIp("203.0.113.9", "secret-one-0123456789")).toBe(a);
    expect(await hashIp("203.0.113.9", "secret-two-0123456789")).not.toBe(a);
    expect(await hashIp("203.0.113.10", "secret-one-0123456789")).not.toBe(a);
    expect(a).not.toContain("203");
    expect(await hashIp(null, "secret-one-0123456789")).toMatch(/^[0-9a-f]{64}$/);
  });
});

const field = (input: Partial<FormFieldInput> & { id: string; type: FormFieldInput["type"] }) =>
  formFieldSchema.parse({ label: input.id, ...input }) as FormField;

describe("staff form publish rules", () => {
  test("a staff form needs no visitor mappings", () => {
    const ok = [field({ id: "temp", type: "number", required: true }), field({ id: "fit", type: "yes_no", required: true })];
    expect(publishProblems(ok, { audience: "staff" })).toEqual([]);
    expect(publishProblems(ok, { audience: "visitor" }).join(" ")).toMatch(/Map a field/);
  });

  test("staff forms refuse visit mappings and file-like fields, with clear messages", () => {
    const problems = publishProblems(
      [
        field({ id: "name", type: "short_text", mapsTo: "visitor.name" }),
        field({ id: "sig", type: "signature" }),
        field({ id: "doc", type: "file_upload" }),
        field({ id: "scan", type: "id_scan" }),
      ],
      { audience: "staff" },
    );
    expect(problems.join("\n")).toMatch(/does not have|do not have/);
    expect(problems.filter((p) => /not available on staff forms/.test(p))).toHaveLength(3);
  });
});

describe("usableAutoFill", () => {
  const details = { name: "Jane Visitor", phone: "+254700111222", email: "jane@example.com", purpose: "Interview" };

  test("fills mapped text fields from known details", () => {
    const fields = [
      field({ id: "n", type: "short_text", mapsTo: "visitor.name", required: true }),
      field({ id: "p", type: "phone", mapsTo: "visitor.phone", required: true }),
      field({ id: "why", type: "long_text", mapsTo: "visit.purpose" }),
      field({ id: "co", type: "short_text", mapsTo: "visitor.company" }),
      field({ id: "other", type: "short_text" }),
    ];
    expect(usableAutoFill(fields, details)).toEqual({ n: "Jane Visitor", p: "+254700111222", why: "Interview" });
  });

  test("drops values the field would reject, so the person is asked instead", () => {
    const fields = [field({ id: "p", type: "phone", mapsTo: "visitor.phone", required: true })];
    expect(usableAutoFill(fields, { ...details, phone: "12" })).toEqual({});
    const email = [field({ id: "e", type: "email", mapsTo: "visitor.email" })];
    expect(usableAutoFill(email, { ...details, email: "not-an-email" })).toEqual({});
  });
});

describe("answer retention days", () => {
  test("a field's own period is used, else the org's period for the audience", () => {
    expect(answerRetentionDays(90, "visitor")).toBe(90);
    expect(answerRetentionDays(undefined, "visitor")).toBe(365);
    expect(answerRetentionDays(undefined, "visitor", { visitRecordsDays: 200 })).toBe(200);
    expect(answerRetentionDays(undefined, "staff")).toBe(2555);
    expect(answerRetentionDays(undefined, "staff", { attendanceDays: 400 })).toBe(400);
  });

  test("the organization minimums are respected and the maximum applies", () => {
    expect(answerRetentionDays(1, "visitor")).toBe(MIN_RETENTION.visitRecordsDays);
    expect(answerRetentionDays(10, "staff")).toBe(MIN_RETENTION.attendanceDays);
    // A stored org value below the floor is clamped too.
    expect(answerRetentionDays(undefined, "visitor", { visitRecordsDays: 3 })).toBe(MIN_RETENTION.visitRecordsDays);
    expect(answerRetentionDays(99_999, "visitor")).toBe(3650);
    expect(answerRetentionDays(Number.NaN, "visitor")).toBe(365);
  });
});

describe("planRedaction", () => {
  const fields = [
    field({ id: "short", type: "short_text", retentionDays: 45 }),
    field({ id: "plain", type: "short_text" }),
    field({ id: "secret", type: "short_text", sensitive: true, retentionDays: 30 }),
    field({ id: "sig", type: "signature", retentionDays: 30 }),
    field({ id: "consent", type: "consent", consentText: "ok" }),
  ];
  const answers = {
    short: "a",
    plain: "b",
    secret: "c",
    sig: { fileId: "f1" },
    consent: { accepted: true, text: "ok" },
  };
  const createdAt = Date.UTC(2026, 0, 1);
  const at = (days: number) => createdAt + days * DAY_MS;

  test("nothing is due before the shortest period", () => {
    const plan = planRedaction({ fields, answers, createdAt, audience: "visitor", now: at(10) });
    expect(plan.redact).toEqual([]);
    expect(plan.nextCheck).toBe(at(30));
  });

  test("redacts what is past its own period, counts sensitive ones, and never touches file answers", () => {
    const plan = planRedaction({ fields, answers, createdAt, audience: "visitor", now: at(50) });
    expect(plan.redact.sort()).toEqual(["secret", "short"]);
    expect(plan.sensitive).toBe(1);
    // The rest wait for the org default (365 days) but are rechecked within 30 days.
    expect(plan.nextCheck).toBe(at(50) + REDACTION_RECHECK_MS);
  });

  test("after the org period everything but files is redacted, then the row is parked", () => {
    const plan = planRedaction({ fields, answers, createdAt, audience: "visitor", now: at(400) });
    expect(plan.redact.sort()).toEqual(["consent", "plain", "secret", "short"]);
    const done = planRedaction({
      fields,
      answers: { short: { redacted: true }, plain: { redacted: true }, sig: { fileId: "f1" } },
      createdAt,
      audience: "visitor",
      now: at(400),
    });
    expect(done.redact).toEqual([]);
    expect(done.nextCheck).toBe(NO_REDACTION_DUE);
  });

  test("a shortened field period below the floor does not redact early", () => {
    const f = [field({ id: "x", type: "short_text", retentionDays: 1 })];
    expect(planRedaction({ fields: f, answers: { x: "v" }, createdAt, audience: "visitor", now: at(5) }).redact).toEqual([]);
    expect(planRedaction({ fields: f, answers: { x: "v" }, createdAt, audience: "visitor", now: at(31) }).redact).toEqual(["x"]);
  });

  test("the first check for a new response is its earliest deadline", () => {
    expect(initialRedactionCheck({ fields, answers, createdAt, audience: "visitor" })).toBe(at(30));
    expect(initialRedactionCheck({ fields: [], answers: {}, createdAt, audience: "visitor" })).toBe(NO_REDACTION_DUE);
  });
});
