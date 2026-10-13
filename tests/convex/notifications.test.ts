import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { enqueueNotification, MAX_ATTEMPTS, RATE_LIMIT_PER_HOUR } from "../../convex/lib/notify";
import { signWebhook } from "../../lib/notifications/webhook";
import { addMember, createOrgWithOwner, expectCode, newTest, signIn, type T } from "./setup";

const HOUR = 3_600_000;
const PHONE = "+254700111222";
const NOON_UTC = Date.UTC(2026, 2, 10, 9, 0); // 12:00 in Nairobi
const NIGHT_UTC = Date.UTC(2026, 2, 10, 20, 0); // 23:00 in Nairobi

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOON_UTC);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.NOTIFY_WEBHOOK_SECRET;
  delete process.env.NOTIFY_EMAIL_PROVIDER;
  delete process.env.RESEND_API_KEY;
});

/** Run every scheduled function (delivery, retries) to completion. */
async function drain(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

const outbox = (t: T) => t.run((ctx) => ctx.db.query("notificationOutbox").collect());

async function setup(t: T, slug = "acme") {
  const org = await createOrgWithOwner(t, slug, slug);
  const host = await addMember(t, org.organizationId, `${slug}-hana`, "host");
  const guard = await addMember(t, org.organizationId, `${slug}-gary`, "guard");
  const reception = await addMember(t, org.organizationId, `${slug}-rita`, "receptionist");
  const staff = await addMember(t, org.organizationId, `${slug}-sam`, "staff");
  const admin = await addMember(t, org.organizationId, `${slug}-ada`, "admin");
  const gateId = await org.owner.as.mutation(api.gates.create, {
    organizationId: org.organizationId,
    siteId: org.siteId,
    name: "Front",
    type: "pedestrian",
  });
  const { token } = await org.owner.as.mutation(api.kioskDevices.issue, {
    organizationId: org.organizationId,
    gateId,
    name: "Tablet",
  });
  const k = { slug, token };
  const orgArg = { organizationId: org.organizationId };

  async function appointment(opts: { email?: string; status?: "approved" | "pending_approval"; start?: number } = {}) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const visitorId = await ctx.db.insert("visitors", {
        organizationId: org.organizationId,
        name: "Jane Visitor",
        phone: PHONE,
        email: opts.email ?? "jane@example.com",
        company: "Secret Corp",
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert("appointments", {
        organizationId: org.organizationId,
        siteId: org.siteId,
        visitorId,
        hostUserId: host.userId,
        purpose: "Secret contract talks",
        scheduledStart: opts.start ?? now,
        scheduledEnd: (opts.start ?? now) + HOUR,
        status: opts.status ?? "approved",
        createdBy: host.userId,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  async function arrive() {
    const appointmentId = await appointment();
    const done = await t.mutation(api.kioskVisitor.checkInAppointment, { ...k, appointmentId, phone: PHONE });
    expect(done.status).toBe("ok");
    await drain(t);
    return appointmentId;
  }

  return { ...org, host, guard, reception, staff, admin, gateId, k, orgArg, appointment, arrive };
}

describe("host notified on arrival", () => {
  test("kiosk check-in notifies the host exactly once, even if the trigger fires again", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.arrive();
    let rows = await outbox(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "visitor_arrived",
      channel: "email",
      status: "sent",
      mode: "dry_run",
      recipientUserId: s.host.userId,
      to: "acme-hana@example.com",
      attempts: 1,
    });
    expect(rows[0]!.providerMessageId).toMatch(/^dry-email-/);

    const visit = await t.run((ctx) => ctx.db.query("visits").first());
    await t.mutation(internal.notifications.onVisitArrived, { visitId: visit!._id });
    await t.mutation(internal.notifications.onVisitArrived, { visitId: visit!._id });
    await drain(t);
    rows = await outbox(t);
    expect(rows).toHaveLength(1);
  });

  test("walk-in awaiting admission, then guard admit, sends one message each", async () => {
    const t = newTest();
    const s = await setup(t);
    await t.mutation(api.kioskVisitor.registerWalkIn, {
      ...s.k,
      visitor: { name: "Walt Walker", phone: "+254700333444" },
      purpose: "Delivery",
      hostUserId: s.host.userId,
    });
    await drain(t);
    expect((await outbox(t)).map((r) => r.eventType)).toEqual(["visitor_awaiting_admit"]);
    const visit = await t.run((ctx) => ctx.db.query("visits").first());
    await s.guard.as.mutation(api.visits.admit, { ...s.orgArg, visitId: visit!._id, gateId: s.gateId });
    await drain(t);
    expect((await outbox(t)).map((r) => r.eventType).sort()).toEqual(["visitor_arrived", "visitor_awaiting_admit"]);
  });

  test("a check-in does not fail or roll back because notifications are off", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.owner.as.mutation(api.notifications.updateOrgSettings, {
      ...s.orgArg,
      enabledChannels: [],
      templateOverrides: {},
    });
    await s.arrive();
    expect(await outbox(t)).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("visits").collect())).toHaveLength(1);
  });

  test("payloads carry no more personal data than the template needs", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.arrive();
    const [row] = await outbox(t);
    expect(Object.keys(row!.payload).sort()).toEqual(["siteName", "visitorName"]);
    const json = JSON.stringify(row);
    for (const secret of [PHONE, "Secret Corp", "Secret contract", "jane@example.com", "badge"]) {
      expect(json).not.toContain(secret);
    }
  });
});

describe("appointment events", () => {
  test("requested goes to the host; approval, reschedule and cancellation reach the visitor", async () => {
    const t = newTest();
    const s = await setup(t);
    const start = Date.now() + 24 * HOUR;
    const id = await s.reception.as.mutation(api.appointments.create, {
      ...s.orgArg,
      siteId: s.siteId,
      hostUserId: s.host.userId,
      visitor: { name: "Jane Visitor", email: "jane@example.com", phone: PHONE },
      purpose: "Interview",
      scheduledStart: start,
      scheduledEnd: start + HOUR,
    });
    await drain(t);
    expect((await outbox(t)).map((r) => [r.eventType, r.recipientKind])).toEqual([["appointment_requested", "user"]]);

    await s.host.as.mutation(api.appointments.decide, { ...s.orgArg, appointmentId: id, decision: "approved" });
    await s.reception.as.mutation(api.appointments.reschedule, {
      ...s.orgArg,
      appointmentId: id,
      scheduledStart: start + 2 * HOUR,
      scheduledEnd: start + 3 * HOUR,
    });
    await s.host.as.mutation(api.appointments.cancel, { ...s.orgArg, appointmentId: id });
    await drain(t);
    const rows = await outbox(t);
    expect(rows.map((r) => r.eventType).sort()).toEqual([
      "appointment_approved",
      "appointment_cancelled", // visitor; the host cancelled it themself so no host copy
      "appointment_requested",
      "appointment_rescheduled",
      "appointment_rescheduled_host",
    ]);
    const visitorRows = rows.filter((r) => r.recipientKind === "visitor");
    expect(visitorRows.every((r) => r.to === "jane@example.com" && r.status === "sent")).toBe(true);
    for (const r of visitorRows) {
      expect(Object.keys(r.payload).sort()).toEqual(["firstName", "hostName", "orgName", "when"]);
      expect(r.payload.firstName).toBe("Jane");
      expect(JSON.stringify(r)).not.toContain("Interview");
    }
  });

  test("declined notifies the visitor once", async () => {
    const t = newTest();
    const s = await setup(t);
    const id = await s.appointment({ status: "pending_approval", start: Date.now() + 5 * HOUR });
    await s.host.as.mutation(api.appointments.decide, { ...s.orgArg, appointmentId: id, decision: "declined" });
    await drain(t);
    expect((await outbox(t)).map((r) => r.eventType)).toEqual(["appointment_declined"]);
  });
});

describe("preferences, quiet hours and channels", () => {
  test("a member can switch email off for an event; other events and members are unaffected", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.host.as.mutation(api.notifications.updateMyPreferences, {
      ...s.orgArg,
      events: { visitor_arrived: { email: false } },
    });
    await s.arrive();
    expect(await outbox(t)).toHaveLength(0);
  });

  test("SMS needs org enablement, the member's opt-in and a phone number", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.host.as.mutation(api.notifications.updateMyPreferences, {
      ...s.orgArg,
      phone: "+254 711 000 111",
      events: { visitor_arrived: { email: true, sms: true } },
    });
    // Org has only email enabled by default: no SMS yet.
    await s.arrive();
    expect((await outbox(t)).map((r) => r.channel)).toEqual(["email"]);
    await s.owner.as.mutation(api.notifications.updateOrgSettings, {
      ...s.orgArg,
      enabledChannels: ["email", "sms"],
      templateOverrides: {},
    });
    const visit = await t.run((ctx) => ctx.db.query("visits").first());
    await t.mutation(internal.notifications.onVisitArrived, { visitId: visit!._id }); // same key: still once per channel
    await drain(t);
    const rows = await outbox(t);
    expect(rows.map((r) => r.channel).sort()).toEqual(["email", "sms"]);
    expect(rows.find((r) => r.channel === "sms")).toMatchObject({ to: "+254711000111", status: "sent" });
  });

  test("quiet hours skip staff messages, in the organization's time zone", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.host.as.mutation(api.notifications.updateMyPreferences, {
      ...s.orgArg,
      events: {},
      quietStartMin: 22 * 60,
      quietEndMin: 6 * 60,
    });
    vi.setSystemTime(NIGHT_UTC); // 23:00 Nairobi
    await s.arrive();
    let rows = await outbox(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "skipped", lastError: "quiet_hours", attempts: 0 });
    expect(rows[0]!.to).toBeUndefined();

    // Outside quiet hours it is delivered.
    vi.setSystemTime(NOON_UTC + 24 * HOUR);
    const second = await s.appointment();
    await t.mutation(api.kioskVisitor.checkInAppointment, { ...s.k, appointmentId: second, phone: PHONE });
    await drain(t);
    rows = await outbox(t);
    expect(rows.map((r) => r.status).sort()).toEqual(["sent", "skipped"]);
  });

  test("quiet hours validation and phone validation", async () => {
    const t = newTest();
    const s = await setup(t);
    await expectCode(
      s.host.as.mutation(api.notifications.updateMyPreferences, { ...s.orgArg, events: {}, quietStartMin: 60 }),
      "VALIDATION",
    );
    await expectCode(
      s.host.as.mutation(api.notifications.updateMyPreferences, { ...s.orgArg, events: {}, phone: "nope" }),
      "VALIDATION",
    );
    await expectCode(
      s.host.as.mutation(api.notifications.updateMyPreferences, { ...s.orgArg, events: { bogus_event: { email: true } } }),
      "VALIDATION",
    );
  });

  test("rate limit records excess messages as skipped", async () => {
    const t = newTest();
    const s = await setup(t);
    await t.run((ctx) =>
      ctx.db.insert("notificationUsage", {
        organizationId: s.organizationId,
        windowStart: Date.now(),
        count: RATE_LIMIT_PER_HOUR,
      }),
    );
    await s.arrive();
    expect(await outbox(t)).toMatchObject([{ status: "skipped", lastError: "rate_limited" }]);
    // The window resets after an hour.
    vi.setSystemTime(Date.now() + HOUR + 1000);
    const visit = await t.run((ctx) => ctx.db.query("visits").first());
    await t.mutation(internal.notifications.onVisitArrived, { visitId: visit!._id });
    await drain(t);
    // Same idempotency key as the skipped row: no new send for the same event.
    expect(await outbox(t)).toHaveLength(1);
  });
});

describe("delivery failures", () => {
  async function invite(t: T, s: Awaited<ReturnType<typeof setup>>, email: string, key: string) {
    await t.mutation(internal.notifications.onInvitationCreated, {
      organizationId: s.organizationId,
      invitee: { name: "Ivy Invitee", email },
      link: "https://wageni.test/invite/SECRET-TOKEN",
      idempotencyKey: key,
    });
  }

  test("a failing provider is retried with backoff, then marked failed with the link redacted", async () => {
    const t = newTest();
    const s = await setup(t);
    await invite(t, s, "fail@example.com", "invite:1");
    await drain(t);
    const [row] = await outbox(t);
    expect(row).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS, lastError: "dry-run simulated failure" });
    expect(row!.payload.link).toBe("[redacted]");
    expect(JSON.stringify(row)).not.toContain("SECRET-TOKEN");
  });

  test("a success redacts the link too, and invitations are idempotent", async () => {
    const t = newTest();
    const s = await setup(t);
    await invite(t, s, "ivy@example.com", "invite:2");
    await invite(t, s, "ivy@example.com", "invite:2");
    await drain(t);
    const rows = await outbox(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", attempts: 1, recipientKind: "visitor" });
    expect(rows[0]!.payload.link).toBe("[redacted]");
    expect(rows[0]!.payload.firstName).toBe("Ivy");
  });

  test("a message that fails once is retried and then succeeds", async () => {
    const t = newTest();
    const s = await setup(t);
    await invite(t, s, "ivy@example.com", "invite:3");
    // Break the first attempt by changing the address after queueing, then fix it before the retry.
    const [row] = await outbox(t);
    await t.run((ctx) => ctx.db.patch(row!._id, { to: "fail@example.com" }));
    await vi.advanceTimersByTimeAsync(1000);
    await t.finishInProgressScheduledFunctions();
    let current = (await outbox(t))[0]!;
    expect(current).toMatchObject({ status: "queued", attempts: 1, lastError: "dry-run simulated failure" });
    expect(current.nextAttemptAt).toBeGreaterThan(Date.now());
    await t.run((ctx) => ctx.db.patch(row!._id, { to: "ivy@example.com" }));
    await drain(t);
    current = (await outbox(t))[0]!;
    expect(current).toMatchObject({ status: "sent", attempts: 2 });
  });

  test("retry: admins and owners can requeue a failed message; others cannot", async () => {
    const t = newTest();
    const s = await setup(t);
    await invite(t, s, "fail@example.com", "invite:4");
    await drain(t);
    const [row] = await outbox(t);
    await expectCode(s.reception.as.mutation(api.notifications.retry, { ...s.orgArg, outboxId: row!._id }), "FORBIDDEN");
    await t.run((ctx) => ctx.db.patch(row!._id, { to: "ok@example.com" }));
    await s.admin.as.mutation(api.notifications.retry, { ...s.orgArg, outboxId: row!._id });
    await drain(t);
    expect((await outbox(t))[0]).toMatchObject({ status: "sent", attempts: 1 });
    await expectCode(s.admin.as.mutation(api.notifications.retry, { ...s.orgArg, outboxId: row!._id }), "CONFLICT");
  });

  test("the stale-outbox cron picks up a queued message whose schedule was lost", async () => {
    const t = newTest();
    const s = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("notificationOutbox", {
        organizationId: s.organizationId,
        channel: "email",
        eventType: "test_message",
        templateKey: "test_message",
        recipientKind: "visitor",
        to: "lost@example.com",
        payload: { orgName: "Acme" },
        status: "queued",
        attempts: 0,
        idempotencyKey: "lost",
        createdAt: Date.now() - HOUR,
      });
    });
    await t.mutation(internal.notificationsCron.retryStale, {});
    await drain(t);
    expect((await outbox(t))[0]).toMatchObject({ status: "sent" });
  });
});

describe("delivery receipts webhook", () => {
  const SECRET = "whsec_test_secret";

  async function sentMessage(t: T) {
    const s = await setup(t);
    await s.arrive();
    const [row] = await outbox(t);
    return { s, row: row! };
  }

  async function post(t: T, body: string, headers: Record<string, string>) {
    return await t.fetch("/webhooks/notifications", { method: "POST", body, headers });
  }

  async function signed(body: string, ts = String(Math.floor(Date.now() / 1000))) {
    return { "x-wageni-timestamp": ts, "x-wageni-signature": await signWebhook(SECRET, ts, body) };
  }

  test("route does not exist without a configured secret", async () => {
    const t = newTest();
    const res = await post(t, "{}", {});
    expect(res.status).toBe(404);
  });

  test("accepts a valid signature, updates status, and ignores replays and regressions", async () => {
    process.env.NOTIFY_WEBHOOK_SECRET = SECRET;
    const t = newTest();
    const { row } = await sentMessage(t);
    const body = JSON.stringify({ providerMessageId: row.providerMessageId, status: "delivered" });
    const res = await post(t, body, await signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await outbox(t))[0]!.deliveryStatus).toBe("delivered");

    // Replay of the same request, and an out-of-order "failed" after delivery, change nothing.
    await post(t, body, await signed(body));
    const failed = JSON.stringify({ providerMessageId: row.providerMessageId, status: "failed" });
    await post(t, failed, await signed(failed));
    expect((await outbox(t))[0]).toMatchObject({ deliveryStatus: "delivered", status: "sent" });

    const read = JSON.stringify({ providerMessageId: row.providerMessageId, status: "read" });
    await post(t, read, await signed(read));
    expect((await outbox(t))[0]!.deliveryStatus).toBe("read");
  });

  test("a failed receipt marks the message failed", async () => {
    process.env.NOTIFY_WEBHOOK_SECRET = SECRET;
    const t = newTest();
    const { row } = await sentMessage(t);
    const body = JSON.stringify({ providerMessageId: row.providerMessageId, status: "failed" });
    expect((await post(t, body, await signed(body))).status).toBe(200);
    expect((await outbox(t))[0]).toMatchObject({ status: "failed", deliveryStatus: "failed", lastError: "delivery_failed" });
  });

  test("rejects bad signatures, missing headers and stale timestamps with a generic 4xx", async () => {
    process.env.NOTIFY_WEBHOOK_SECRET = SECRET;
    const t = newTest();
    const { row } = await sentMessage(t);
    const body = JSON.stringify({ providerMessageId: row.providerMessageId, status: "delivered" });
    const good = await signed(body);

    const cases: [string, Record<string, string>][] = [
      ["wrong signature", { ...good, "x-wageni-signature": "0".repeat(64) }],
      ["no headers", {}],
      ["no signature", { "x-wageni-timestamp": good["x-wageni-timestamp"] }],
      ["stale timestamp (replay)", await signed(body, String(Math.floor(Date.now() / 1000) - 3600))],
      ["future timestamp", await signed(body, String(Math.floor(Date.now() / 1000) + 3600))],
    ];
    for (const [name, headers] of cases) {
      const res = await post(t, body, headers);
      expect(res.status, name).toBe(401);
      expect(await res.json(), name).toEqual({ error: "invalid_request" });
    }
    const tampered = await post(t, body.replace("delivered", "read"), good);
    expect(tampered.status).toBe(401);
    expect((await outbox(t))[0]!.deliveryStatus).toBeUndefined();
  });

  test("malformed payloads are 400; unknown ids look identical to known ones and leak nothing", async () => {
    process.env.NOTIFY_WEBHOOK_SECRET = SECRET;
    const t = newTest();
    await sentMessage(t);
    for (const bad of ["not json", JSON.stringify({ status: "delivered" }), JSON.stringify({ providerMessageId: "x", status: "weird" })]) {
      expect((await post(t, bad, await signed(bad))).status).toBe(400);
    }
    const unknown = JSON.stringify({ providerMessageId: "nope", status: "delivered" });
    const res = await post(t, unknown, await signed(unknown));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });
});

describe("tenant isolation and permissions", () => {
  test("outbox history, stats, retry and settings never cross organizations", async () => {
    const t = newTest();
    const a = await setup(t, "acme");
    const b = await setup(t, "beta");
    await a.arrive();
    await b.arrive();
    const listA = await a.owner.as.query(api.notifications.listOutbox, a.orgArg);
    const listB = await b.owner.as.query(api.notifications.listOutbox, b.orgArg);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0]!._id).not.toBe(listB[0]!._id);
    expect((await a.owner.as.query(api.notifications.stats, a.orgArg)).total.sent).toBe(1);

    // A member of org A cannot read org B's data by passing B's id.
    await expectCode(a.owner.as.query(api.notifications.listOutbox, b.orgArg), "NOT_FOUND");
    await expectCode(a.owner.as.query(api.notifications.getOrgSettings, b.orgArg), "NOT_FOUND");
    await expectCode(
      a.owner.as.mutation(api.notifications.retry, { ...b.orgArg, outboxId: listB[0]!._id }),
      "NOT_FOUND",
    );
    // Using A's own org with B's row is NOT_FOUND as well.
    const failedB = listB[0]!._id;
    await t.run((ctx) => ctx.db.patch(failedB, { status: "failed" }));
    await expectCode(a.owner.as.mutation(api.notifications.retry, { ...a.orgArg, outboxId: failedB }), "NOT_FOUND");

    // Settings are per organization.
    await a.owner.as.mutation(api.notifications.updateOrgSettings, {
      ...a.orgArg,
      enabledChannels: ["email", "whatsapp"],
      senderName: "Acme Reception",
      templateOverrides: {},
    });
    expect((await b.owner.as.query(api.notifications.getOrgSettings, b.orgArg)).enabledChannels).toEqual(["email"]);
  });

  test("enqueue refuses staff who are not active members of the organization", async () => {
    const t = newTest();
    const a = await setup(t, "acme");
    const outsider = await signIn(t, "outsider");
    const ids = await t.run((ctx) =>
      enqueueNotification(ctx, {
        organizationId: a.organizationId,
        eventType: "test_message",
        recipient: { kind: "user", userId: outsider.userId },
        data: { orgName: "Acme" },
        key: "x",
      }),
    );
    expect(ids).toEqual([]);
    // Disabled members are skipped too.
    await t.run((ctx) => ctx.db.patch(a.host.membershipId, { status: "disabled" }));
    await a.arrive();
    expect(await outbox(t)).toHaveLength(0);
  });

  test("history is masked: no full addresses, bodies or provider ids", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.arrive();
    const rows = await s.owner.as.query(api.notifications.listOutbox, s.orgArg);
    const json = JSON.stringify(rows);
    expect(rows[0]).toMatchObject({ to: "a***@example.com", recipient: "acme-hana", label: "Visitor arrived (to host)" });
    expect(json).not.toContain("acme-hana@example.com");
    expect(json).not.toContain("dry-email");
  });

  test("permissions: history for managers, settings and tests for integrations:manage only", async () => {
    const t = newTest();
    const s = await setup(t);
    for (const who of [s.host, s.guard, s.staff]) {
      await expectCode(who.as.query(api.notifications.listOutbox, s.orgArg), "FORBIDDEN");
      await expectCode(who.as.query(api.notifications.stats, s.orgArg), "FORBIDDEN");
    }
    await s.reception.as.query(api.notifications.listOutbox, s.orgArg);
    const settings = await s.reception.as.query(api.notifications.getOrgSettings, s.orgArg);
    expect(settings.canEdit).toBe(false);

    const update = { ...s.orgArg, enabledChannels: ["email" as const], templateOverrides: {} };
    await expectCode(s.reception.as.mutation(api.notifications.updateOrgSettings, update), "FORBIDDEN");
    await expectCode(s.host.as.mutation(api.notifications.updateOrgSettings, update), "FORBIDDEN");
    await s.admin.as.mutation(api.notifications.updateOrgSettings, update);

    await expectCode(s.reception.as.query(api.notifications.channelConfig, s.orgArg), "FORBIDDEN");
    await expectCode(s.reception.as.mutation(api.notifications.sendTest, { ...s.orgArg, channel: "email" }), "FORBIDDEN");
    await expectCode(s.staff.as.mutation(api.notifications.sendTest, { ...s.orgArg, channel: "email" }), "FORBIDDEN");

    // Everyone can read and edit their own preferences.
    for (const who of [s.host, s.guard, s.staff, s.reception]) {
      await who.as.query(api.notifications.myPreferences, s.orgArg);
    }
  });

  test("template overrides are limited to safe placeholders", async () => {
    const t = newTest();
    const s = await setup(t);
    const base = { ...s.orgArg, enabledChannels: ["email" as const] };
    await expectCode(
      s.owner.as.mutation(api.notifications.updateOrgSettings, {
        ...base,
        templateOverrides: { visitor_arrived: { body: "{{visitorName}} {{purpose}}" } },
      }),
      "VALIDATION",
    );
    await expectCode(
      s.owner.as.mutation(api.notifications.updateOrgSettings, {
        ...base,
        templateOverrides: { not_an_event: { body: "hi" } },
      }),
      "VALIDATION",
    );
    await s.owner.as.mutation(api.notifications.updateOrgSettings, {
      ...base,
      templateOverrides: { visitor_arrived: { body: "{{visitorName}} is here" } },
    });
    expect((await s.owner.as.query(api.notifications.getOrgSettings, s.orgArg)).templateOverrides).toEqual({
      visitor_arrived: { body: "{{visitorName}} is here" },
    });
  });

  test("channel configuration shows modes from env and never secret values", async () => {
    const t = newTest();
    const s = await setup(t);
    process.env.NOTIFY_EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_super_secret_value";
    const cfg = await s.owner.as.query(api.notifications.channelConfig, s.orgArg);
    expect(cfg.channels.email).toMatchObject({ mode: "dry_run", requested: true, missing: ["NOTIFY_EMAIL_FROM"] });
    expect(JSON.stringify(cfg)).not.toContain("re_super_secret_value");
    expect(cfg.webhookConfigured).toBe(false);
  });

  test("test-send goes to the caller's own address, needs a valid phone for SMS, and is limited", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.owner.as.mutation(api.notifications.sendTest, { ...s.orgArg, channel: "email" });
    await expectCode(s.owner.as.mutation(api.notifications.sendTest, { ...s.orgArg, channel: "sms" }), "VALIDATION");
    await s.owner.as.mutation(api.notifications.sendTest, { ...s.orgArg, channel: "sms", phone: PHONE });
    await drain(t);
    const rows = await outbox(t);
    expect(rows.map((r) => [r.channel, r.to]).sort()).toEqual([
      ["email", "acme-owner@example.com"],
      ["sms", PHONE],
    ]);
    expect(rows.every((r) => r.status === "sent" && r.mode === "dry_run")).toBe(true);
    for (let i = 0; i < 3; i++) await s.owner.as.mutation(api.notifications.sendTest, { ...s.orgArg, channel: "email" });
    await expectCode(s.owner.as.mutation(api.notifications.sendTest, { ...s.orgArg, channel: "email" }), "RATE_LIMITED");
  });
});

describe("crons", () => {
  test("appointment reminders go out once per appointment time", async () => {
    const t = newTest();
    const s = await setup(t);
    const soon = await s.appointment({ start: Date.now() + 30 * 60_000 });
    await s.appointment({ start: Date.now() + 5 * HOUR }); // too early
    await s.appointment({ start: Date.now() + 20 * 60_000, status: "pending_approval" }); // not approved
    await t.mutation(internal.notificationsCron.scanReminders, {});
    await t.mutation(internal.notificationsCron.scanReminders, {});
    await drain(t);
    const rows = await outbox(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: "appointment_reminder", to: "jane@example.com", status: "sent" });
    expect(Object.keys(rows[0]!.payload).sort()).toEqual(["firstName", "hostName", "orgName", "when"]);

    // Rescheduling to another time earns a fresh reminder.
    await t.run((ctx) => ctx.db.patch(soon, { scheduledStart: Date.now() + 45 * 60_000 }));
    await t.mutation(internal.notificationsCron.scanReminders, {});
    await drain(t);
    expect(await outbox(t)).toHaveLength(2);
  });

  test("missed clock-out reminder and the manager alert for stale corrections", async () => {
    const t = newTest();
    const s = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("attendanceEvents", {
        organizationId: s.organizationId,
        siteId: s.siteId,
        userId: s.staff.userId,
        type: "clock_in",
        at: Date.now() - 14 * HOUR,
        source: "app",
        createdAt: Date.now(),
      });
      // Clocked in recently: no reminder.
      await ctx.db.insert("attendanceEvents", {
        organizationId: s.organizationId,
        siteId: s.siteId,
        userId: s.guard.userId,
        type: "clock_in",
        at: Date.now() - 2 * HOUR,
        source: "app",
        createdAt: Date.now(),
      });
      await ctx.db.insert("attendanceCorrections", {
        organizationId: s.organizationId,
        siteId: s.siteId,
        userId: s.staff.userId,
        requestedBy: s.staff.userId,
        proposedType: "clock_out",
        proposedAt: Date.now() - 20 * HOUR,
        reason: "Forgot",
        status: "pending",
        createdAt: Date.now() - 26 * HOUR,
      });
    });
    await t.mutation(internal.notificationsCron.scanStaff, {});
    await drain(t);
    await t.mutation(internal.notificationsCron.scanStaff, {});
    await drain(t);
    const rows = await outbox(t);
    const missed = rows.filter((r) => r.eventType === "missed_clock_out");
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ recipientUserId: s.staff.userId, status: "sent" });
    const alerts = rows.filter((r) => r.eventType === "corrections_pending");
    // Owner and admin hold staff_attendance:correct; each alerted once.
    expect(alerts.map((r) => r.recipientUserId).sort()).toEqual([s.owner.userId, s.admin.userId].sort());
    expect(alerts.every((r) => r.payload.count === "1")).toBe(true);
  });

  test("settled outbox rows are purged after retention", async () => {
    const t = newTest();
    const s = await setup(t);
    const old = await t.run((ctx) =>
      ctx.db.insert("notificationOutbox", {
        organizationId: s.organizationId,
        channel: "email",
        eventType: "test_message",
        templateKey: "test_message",
        recipientKind: "visitor",
        to: "old@example.com",
        payload: {},
        status: "sent",
        attempts: 1,
        idempotencyKey: "old",
        createdAt: Date.now() - 100 * 24 * HOUR,
      }),
    );
    await s.arrive();
    await t.mutation(internal.notificationsCron.purgeOld, {});
    await drain(t);
    const ids = (await outbox(t)).map((r) => r._id as Id<"notificationOutbox">);
    expect(ids).not.toContain(old);
    expect(ids).toHaveLength(1);
  });
});
