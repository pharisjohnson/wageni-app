import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { NO_REDACTION_DUE } from "../../lib/answer-retention";
import { CONSENT, GOOD_ANSWERS, formsSetup, type FormsSetup } from "./formsSetup";
import { createOrgWithOwner, newTest, type T } from "./setup";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 1, 12);
const orgArgs = (s: { organizationId: Id<"organizations"> }) => ({ organizationId: s.organizationId });

// Scheduled continuation runs only when a test advances timers.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A published form with short, long and default retention fields, one sensitive. */
const retentionFields = () => {
  const base = { required: false, sensitive: false };
  return [
    { ...base, id: "name", type: "short_text", label: "Name", required: true, mapsTo: "visitor.name" },
    { ...base, id: "phone", type: "phone", label: "Phone", required: true, mapsTo: "visitor.phone" },
    { ...base, id: "purpose", type: "short_text", label: "Purpose", required: true, mapsTo: "visit.purpose" },
    { ...base, id: "temp", type: "short_text", label: "Note", retentionDays: 45 },
    { ...base, id: "tiny", type: "short_text", label: "Tiny", retentionDays: 1 },
    { ...base, id: "idn", type: "short_text", label: "ID number", sensitive: true, retentionDays: 60 },
    { ...base, id: "long", type: "short_text", label: "Kept long", retentionDays: 1000 },
    { ...base, id: "consent", type: "consent", label: "Consent", consentText: CONSENT },
    { ...base, id: "signature", type: "signature", label: "Signature", retentionDays: 30 },
  ];
};

async function setup(t: T) {
  const s = await formsSetup(t);
  const { formId, versionId } = await s.publishedForm(retentionFields());
  return { ...s, formId, versionId };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function addResponse(
  t: T,
  s: Setup,
  ageDays: number,
  answers: Record<string, unknown> = {
    name: "Jane Visitor",
    phone: "+254700111222",
    purpose: "Interview",
    temp: "temp value",
    tiny: "tiny value",
    idn: "12345678",
    long: "long value",
    consent: { accepted: true, text: CONSENT },
  },
  extra: { nextRedactionCheck?: number } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("formResponses", {
      organizationId: s.organizationId,
      siteId: s.siteId,
      formId: s.formId,
      formVersionId: s.versionId,
      answers: answers as never,
      createdAt: NOW - ageDays * DAY,
      ...extra,
    }),
  );
}

const redact = (t: T, s: { organizationId: Id<"organizations"> }, over: { dryRun?: boolean; batchSize?: number; now?: number } = {}) =>
  t.mutation(internal.formRetention.redactExpired, { organizationId: s.organizationId, dryRun: false, now: NOW, ...over });
const answersOf = async (t: T, id: Id<"formResponses">) => (await t.run(async (ctx) => ctx.db.get(id)))!.answers as Record<string, unknown>;
const TOMB = { redacted: true };

describe("per-field answer redaction", () => {
  test("only answers past their own period are replaced by a tombstone; the row and version reference stay", async () => {
    const t = newTest();
    const s = await setup(t);
    const id = await addResponse(t, s, 50);
    const res = await redact(t, s);
    expect(res).toMatchObject({ dryRun: false, hasMore: false, counts: { responses: 1, answers: 2, sensitiveAnswers: 0 } });
    const a = await answersOf(t, id);
    expect(a.temp).toEqual(TOMB); // 45 days
    expect(a.tiny).toEqual(TOMB); // asks for 1 day, kept for the 30 day organization minimum, which has passed
    expect(a.idn).toBe("12345678"); // 60 days
    expect(a.name).toBe("Jane Visitor"); // organization default (365 days)
    expect(a.long).toBe("long value");
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ formVersionId: s.versionId, formId: s.formId, siteId: s.siteId });
    expect(row!.createdAt).toBe(NOW - 50 * DAY);
  });

  test("sensitive answers are redacted by the same rule and counted separately", async () => {
    const t = newTest();
    const s = await setup(t);
    const id = await addResponse(t, s, 70);
    const res = await redact(t, s);
    expect(res.counts).toEqual({ responses: 1, answers: 3, sensitiveAnswers: 1 }); // temp, tiny (30 day floor), idn
    const a = await answersOf(t, id);
    expect(a.idn).toEqual(TOMB);
    expect(a.tiny).toEqual(TOMB);
    expect(a.name).toBe("Jane Visitor");
  });

  test("answers with no period of their own follow the organization's visitor-record retention", async () => {
    const t = newTest();
    const s = await setup(t);
    const id = await addResponse(t, s, 370);
    await redact(t, s);
    const a = await answersOf(t, id);
    // Default 365 days has passed: name, phone, purpose and consent go; the 1000 day field stays.
    for (const key of ["name", "phone", "purpose", "temp", "tiny", "idn", "consent"]) expect(a[key], key).toEqual(TOMB);
    expect(a.long).toBe("long value");
    // A shorter organization setting applies at the next check.
    const id2 = await addResponse(t, s, 100);
    await t.run(async (ctx) => ctx.db.patch(s.organizationId, { retention: { visitRecordsDays: 90, auditLogDays: 730, attendanceDays: 2555 } }));
    await redact(t, s);
    expect((await answersOf(t, id2)).name).toEqual(TOMB);
  });

  test("the organization minimum is respected: a field cannot be kept shorter than it", async () => {
    const t = newTest();
    const s = await setup(t);
    const young = await addResponse(t, s, 29, { tiny: "v", name: "n" });
    const older = await addResponse(t, s, 31, { tiny: "v", name: "n" });
    await redact(t, s);
    expect((await answersOf(t, young)).tiny).toBe("v");
    expect((await answersOf(t, older)).tiny).toEqual(TOMB);
    // An organization setting stored below the floor is clamped too (default for name would otherwise be 3 days).
    await t.run(async (ctx) => ctx.db.patch(s.organizationId, { retention: { visitRecordsDays: 3, auditLogDays: 730, attendanceDays: 2555 } }));
    const fresh = await addResponse(t, s, 10, { name: "n" });
    await redact(t, s);
    expect((await answersOf(t, fresh)).name).toBe("n");
    const stale = await addResponse(t, s, 31, { name: "n" });
    await redact(t, s);
    expect((await answersOf(t, stale)).name).toEqual(TOMB);
  });

  test("file answers are not touched by this job (files follow their own deletion)", async () => {
    const t = newTest();
    const s = await setup(t);
    const up = await s.upload("signature", "image/png", 50);
    if (up.res.status !== "ok") throw new Error("upload failed");
    const id = await addResponse(t, s, 500, { signature: { fileId: up.res.fileId }, name: "n" });
    await redact(t, s);
    const a = await answersOf(t, id);
    expect(a.signature).toEqual({ fileId: up.res.fileId });
    expect(a.name).toEqual(TOMB);
  });

  test("is idempotent, and a finished row is parked so it is not read again", async () => {
    const t = newTest();
    const s = await setup(t);
    const id = await addResponse(t, s, 2000, { name: "n", temp: "t" });
    await redact(t, s);
    expect((await t.run(async (ctx) => ctx.db.get(id)))!.nextRedactionCheck).toBe(NO_REDACTION_DUE);
    const again = await redact(t, s);
    expect(again.counts).toEqual({ responses: 0, answers: 0, sensitiveAnswers: 0 });
    expect(await answersOf(t, id)).toEqual({ name: TOMB, temp: TOMB });
  });

  test("a response is not visited before its earliest deadline (indexed by next check)", async () => {
    const t = newTest();
    const s = await setup(t);
    const id = await addResponse(t, s, 10, { temp: "t" }, { nextRedactionCheck: NOW + 30 * DAY });
    // The row's check time is in the future, so even a very late job run on `now` skips it.
    const res = await redact(t, s, { now: NOW });
    expect(res.counts.answers).toBe(0);
    expect((await answersOf(t, id)).temp).toBe("t");
  });

  test("rows stored before the job existed (no check time) are picked up", async () => {
    const t = newTest();
    const s = await setup(t);
    const id = await addResponse(t, s, 60, { temp: "t" });
    expect((await t.run(async (ctx) => ctx.db.get(id)))!.nextRedactionCheck).toBeUndefined();
    await redact(t, s);
    const row = (await t.run(async (ctx) => ctx.db.get(id)))!;
    expect(row.answers.temp).toEqual(TOMB);
    expect(row.nextRedactionCheck).toBe(NO_REDACTION_DUE);
  });

  test("new responses are scheduled for their earliest field deadline when stored", async () => {
    vi.useRealTimers();
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm(retentionFields());
    await t.mutation(api.kioskForms.submitWalkIn, {
      ...s.k,
      hostUserId: s.host.userId,
      versionId,
      answers: { ...GOOD_ANSWERS, temp: "x" } as never,
    });
    const [row] = await t.run(async (ctx) => ctx.db.query("formResponses").collect());
    // Earliest deadline is the 30 day floor (tiny is absent; temp is 45 days; consent follows 365).
    const days = (row!.nextRedactionCheck! - row!.createdAt) / DAY;
    expect(days).toBeGreaterThanOrEqual(30);
    expect(days).toBeLessThanOrEqual(45);
  });
});

describe("dry run", () => {
  test("reports what a real run would do and changes nothing", async () => {
    const t = newTest();
    const s = await setup(t);
    const id = await addResponse(t, s, 70);
    const before = await t.run(async (ctx) => ctx.db.get(id));
    const dry = await redact(t, s, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, counts: { responses: 1, answers: 3, sensitiveAnswers: 1 } });
    expect(await t.run(async (ctx) => ctx.db.get(id))).toEqual(before);
    expect((await t.run(async (ctx) => ctx.db.query("auditLogs").collect())).some((a) => a.action === "form_answers.redacted")).toBe(false);
    const real = await redact(t, s);
    expect(real.counts).toEqual(dry.counts);
  });
});

describe("batching", () => {
  test("each run handles at most one batch and schedules the next while rows remain", async () => {
    const t = newTest();
    const s = await setup(t);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await addResponse(t, s, 60 + i, { temp: "t" }));
    const first = await redact(t, s, { batchSize: 2 });
    expect(first).toMatchObject({ hasMore: true, counts: { responses: 2, answers: 2 } });
    const redacted = async () =>
      (await Promise.all(ids.map((id) => answersOf(t, id)))).filter((a) => (a.temp as unknown) !== "t").length;
    expect(await redacted()).toBe(2);
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((f) => f.name.includes("redactExpired"))).toBe(true);
    // Let the chain finish: the scheduled runs keep going until everything is done.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await redacted()).toBe(5);
  });

  test("a dry run never schedules anything", async () => {
    const t = newTest();
    const s = await setup(t);
    for (let i = 0; i < 3; i++) await addResponse(t, s, 60, { temp: "t" });
    const res = await redact(t, s, { dryRun: true, batchSize: 1 });
    expect(res.hasMore).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(0);
  });
});

describe("audit entry", () => {
  test("holds counts only: no field names, values or ids of people", async () => {
    const t = newTest();
    const s = await setup(t);
    await addResponse(t, s, 70);
    await redact(t, s);
    const entries = (await t.run(async (ctx) => ctx.db.query("auditLogs").collect())).filter((a) => a.action === "form_answers.redacted");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.metadata).toEqual({ responses: 1, answers: 3, sensitiveAnswers: 1, system: true });
    const text = JSON.stringify(entries[0]);
    for (const leak of ["Jane", "12345678", "idn", "temp", "tiny", "Note"]) expect(text).not.toContain(leak);
    // No entry when nothing was redacted.
    await redact(t, s);
    expect((await t.run(async (ctx) => ctx.db.query("auditLogs").collect())).filter((a) => a.action === "form_answers.redacted")).toHaveLength(1);
  });
});

describe("tenants and views", () => {
  test("another organization's responses are untouched", async () => {
    const t = newTest();
    const a = await setup(t);
    const b = await formsSetup(t, "beta");
    const other = await b.publishedForm(retentionFields());
    const mine = await addResponse(t, a, 400, { name: "n" });
    const theirs = await t.run(async (ctx) =>
      ctx.db.insert("formResponses", {
        organizationId: b.organizationId,
        formId: other.formId,
        formVersionId: other.versionId,
        answers: { name: "other tenant" },
        createdAt: NOW - 400 * DAY,
      }),
    );
    await redact(t, a);
    expect((await answersOf(t, mine)).name).toEqual(TOMB);
    expect((await answersOf(t, theirs)).name).toBe("other tenant");
  });

  test("the visit page shows a redacted answer as removed, not as a value", async () => {
    vi.useRealTimers();
    const t = newTest();
    const s = await setup(t);
    await t.mutation(api.kioskForms.submitWalkIn, {
      ...s.k,
      hostUserId: s.host.userId,
      versionId: s.versionId,
      answers: { ...GOOD_ANSWERS, temp: "secret note" } as never,
    });
    const [visit] = await t.run(async (ctx) => ctx.db.query("visits").collect());
    const [row] = await t.run(async (ctx) => ctx.db.query("formResponses").collect());
    await t.run(async (ctx) => ctx.db.patch(row!._id, { createdAt: Date.now() - 100 * DAY, nextRedactionCheck: Date.now() - 1 }));
    await t.mutation(internal.formRetention.redactExpired, { organizationId: s.organizationId, dryRun: false });
    const [resp] = await s.reception.as.query(api.forms.visitResponses, { ...orgArgs(s), visitId: visit!._id });
    const note = resp!.items.find((i) => i.id === "temp")!;
    expect(note).toMatchObject({ value: "Removed (retention period ended)" });
    expect(JSON.stringify(resp)).not.toContain("secret note");
    // The response still names the version it was answered with.
    expect(resp).toMatchObject({ formName: "Visitor registration", version: 1 });
  });
});

describe("staff forms use attendance retention", () => {
  async function staffSetup(t: T) {
    const org = await createOrgWithOwner(t, "acme", "acme");
    const formId = await org.owner.as.mutation(api.forms.create, {
      ...orgArgs(org),
      name: "Daily declaration",
      audience: "staff",
      fields: [
        { id: "fit", type: "yes_no", label: "Fit for work?", required: true, sensitive: true },
        { id: "note", type: "short_text", label: "Note", required: false, sensitive: false, retentionDays: 10 },
      ] as never,
    });
    const versionId = await org.owner.as.mutation(api.forms.publish, { ...orgArgs(org), formId });
    return { ...org, formId, versionId };
  }

  test("a staff answer follows the 365 day attendance floor and the 7 year default", async () => {
    const t = newTest();
    const s = await staffSetup(t);
    const make = (ageDays: number) =>
      t.run(async (ctx) =>
        ctx.db.insert("formResponses", {
          organizationId: s.organizationId,
          formId: s.formId,
          formVersionId: s.versionId,
          userId: s.owner.userId,
          answers: { fit: true, note: "ok" },
          createdAt: NOW - ageDays * DAY,
        }),
      );
    const a = await make(200);
    const b = await make(400);
    const c = await make(3000);
    await t.mutation(internal.formRetention.redactExpired, { organizationId: s.organizationId, dryRun: false, now: NOW });
    // note asks for 10 days but the staff floor is 365; fit follows the 2555 day default.
    expect(await answersOf(t, a)).toEqual({ fit: true, note: "ok" });
    expect(await answersOf(t, b)).toEqual({ fit: true, note: TOMB });
    expect(await answersOf(t, c)).toEqual({ fit: TOMB, note: TOMB });
  });
});

describe("daily sweep", () => {
  test("retention.sweepAll runs the answer redaction for every organization", async () => {
    const t = newTest();
    const a = await setup(t);
    const id = await addResponse(t, a, 400, { name: "n" });
    await t.run(async (ctx) => ctx.db.patch(id, { createdAt: Date.now() - 400 * DAY }));
    await t.mutation(internal.retention.sweepAll, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await answersOf(t, id)).name).toEqual(TOMB);
  });
});

// Keep the shared fixture referenced so a rename there is caught here.
export type { FormsSetup };
