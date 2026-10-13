import { describe, expect, test, vi } from "vitest";
import { maskAddress, normalizeEmail, normalizePhone } from "../../lib/notifications/address";
import { ChannelError, channelStatus, dryRunChannel, getChannel } from "../../lib/notifications/channels";
import { inQuietHours } from "../../lib/notifications/quiet-hours";
import {
  EVENT_TYPES,
  renderTemplate,
  TEMPLATES,
  validateOverride,
  type TemplateDef,
} from "../../lib/notifications/templates";
import { constantTimeEqual, signWebhook, verifyWebhook } from "../../lib/notifications/webhook";

describe("templates", () => {
  test("renders placeholders and blanks unknown or disallowed ones", () => {
    const out = renderTemplate("visitor_arrived", { visitorName: "Jane", siteName: "HQ", phone: "+254700" });
    expect(out.body).toBe("Jane has arrived at HQ to see you.");
    const custom = renderTemplate(
      "visitor_arrived",
      { visitorName: "Jane", siteName: "HQ", phone: "+254700" },
      { override: { body: "Hi {{visitorName}} {{phone}}|" } },
    );
    expect(custom.body).toBe("Hi Jane |");
  });

  test("values cannot inject line breaks or grow without bound", () => {
    const out = renderTemplate("visitor_arrived", { visitorName: "A\r\nBcc: x\n" + "z".repeat(500), siteName: "HQ" });
    expect(out.body).not.toMatch(/[\r\n]/);
    expect(out.body.length).toBeLessThan(300);
  });

  test("overrides may only use the event's placeholders and no HTML", () => {
    expect(validateOverride("visitor_arrived", { body: "{{visitorName}} at {{siteName}}" })).toBeNull();
    expect(validateOverride("visitor_arrived", { body: "{{purpose}}" })).toMatch(/not available/);
    expect(validateOverride("visitor_arrived", { subject: "<b>hi</b>" })).toMatch(/HTML/);
    expect(validateOverride("visitor_arrived", { body: "x".repeat(601) })).toMatch(/at most/);
  });

  test("Swahili falls back to English until it exists", () => {
    expect(renderTemplate("test_message", { orgName: "Acme" }, { locale: "sw" }).body).toContain("Acme");
  });

  test("visitor-facing templates use only minimal placeholders", () => {
    const allowed = new Set(["firstName", "orgName", "when", "hostName", "link"]);
    for (const e of EVENT_TYPES) {
      const def: TemplateDef = TEMPLATES[e];
      if (def.audience !== "visitor") continue;
      for (const p of def.placeholders) expect(allowed.has(p), `${e}.${p}`).toBe(true);
    }
  });
});

describe("quiet hours", () => {
  // 2026-03-10 is a Tuesday; Nairobi is UTC+3 with no DST.
  const at = (utcHour: number) => Date.UTC(2026, 2, 10, utcHour, 0);
  test("window wrapping midnight", () => {
    const start = 22 * 60;
    const end = 6 * 60;
    expect(inQuietHours(at(20), "Africa/Nairobi", start, end)).toBe(true); // 23:00 local
    expect(inQuietHours(at(2), "Africa/Nairobi", start, end)).toBe(true); // 05:00 local
    expect(inQuietHours(at(3), "Africa/Nairobi", start, end)).toBe(false); // 06:00 local, end exclusive
    expect(inQuietHours(at(12), "Africa/Nairobi", start, end)).toBe(false);
  });
  test("same-day window and unset window", () => {
    expect(inQuietHours(at(10), "Africa/Nairobi", 12 * 60, 14 * 60)).toBe(true); // 13:00
    expect(inQuietHours(at(10), "Africa/Nairobi", undefined, undefined)).toBe(false);
    expect(inQuietHours(at(10), "Africa/Nairobi", 600, 600)).toBe(false);
  });
});

describe("webhook signature", () => {
  const secret = "test-secret-value";
  const body = JSON.stringify({ providerMessageId: "m1", status: "delivered" });
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);

  test("accepts a valid signature inside the window", async () => {
    const signature = await signWebhook(secret, ts, body);
    expect(await verifyWebhook({ secret, timestamp: ts, signature, body, nowMs: now })).toBe(true);
    expect(await verifyWebhook({ secret, timestamp: ts, signature: signature.toUpperCase(), body, nowMs: now })).toBe(true);
  });

  test("rejects wrong secret, tampered body, missing parts and stale or future timestamps", async () => {
    const signature = await signWebhook(secret, ts, body);
    const base = { secret, timestamp: ts, signature, body, nowMs: now };
    expect(await verifyWebhook({ ...base, secret: "other" })).toBe(false);
    expect(await verifyWebhook({ ...base, body: body + " " })).toBe(false);
    expect(await verifyWebhook({ ...base, signature: null })).toBe(false);
    expect(await verifyWebhook({ ...base, timestamp: null })).toBe(false);
    expect(await verifyWebhook({ ...base, timestamp: "abc" })).toBe(false);
    expect(await verifyWebhook({ ...base, signature: signature.slice(0, -2) })).toBe(false);
    expect(await verifyWebhook({ ...base, nowMs: now + 301_000 })).toBe(false); // replay
    expect(await verifyWebhook({ ...base, nowMs: now - 301_000 })).toBe(false); // future
    expect(await verifyWebhook({ ...base, secret: "" })).toBe(false);
  });

  test("constantTimeEqual", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("addresses", () => {
  test("emails must be a single plain address", () => {
    expect(normalizeEmail(" Jane@Example.com ")).toBe("jane@example.com");
    for (const bad of ["a@b", "a b@c.com", "a@b.com, c@d.com", "a@b.com\r\nBcc: x@y.com", "", undefined]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
  test("phones become E.164", () => {
    expect(normalizePhone("+254 700 111 222")).toBe("+254700111222");
    expect(normalizePhone("0700111222", "254")).toBe("+254700111222");
    expect(normalizePhone("0700111222")).toBeNull();
    expect(normalizePhone("00254700111222")).toBe("+254700111222");
    expect(normalizePhone("abc")).toBeNull();
  });
  test("masking hides most of the address", () => {
    expect(maskAddress("jane@example.com")).toBe("j***@example.com");
    expect(maskAddress("+254700111222")).toBe("+254***222");
  });
});

describe("channel adapters", () => {
  const input = {
    to: "jane@example.com",
    template: { key: "test_message" as const, subject: "S", body: "B" },
    data: { orgName: "Acme" },
  };

  test("dry-run is the default and sends nothing", async () => {
    const fetchSpy = vi.fn();
    for (const ch of ["email", "sms", "whatsapp"] as const) {
      const adapter = getChannel(ch, {}, { fetch: fetchSpy as unknown as typeof fetch });
      expect(adapter.mode).toBe("dry_run");
      expect((await adapter.send(input)).providerMessageId).toMatch(/^dry-/);
    }
    // A provider flag without credentials also stays dry-run.
    expect(getChannel("email", { NOTIFY_EMAIL_PROVIDER: "resend" }).mode).toBe("dry_run");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("dry-run failure hook", async () => {
    await expect(dryRunChannel("email").send({ ...input, to: "fail@example.com" })).rejects.toBeInstanceOf(ChannelError);
  });

  test("resend adapter builds the request from env and never echoes the key in errors", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    const env = { NOTIFY_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_secret_key", NOTIFY_EMAIL_FROM: "no-reply@x.test" };
    const adapter = getChannel("email", env, { fetch: fetchMock as unknown as typeof fetch });
    expect(adapter.mode).toBe("live");
    expect((await adapter.send({ ...input, senderName: "Acme" })).providerMessageId).toBe("re_1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_secret_key");
    expect(JSON.parse(init.body as string)).toMatchObject({ from: "Acme <no-reply@x.test>", to: ["jane@example.com"] });

    const failing = getChannel("email", env, {
      fetch: (async () => new Response("re_secret_key leaked", { status: 401 })) as unknown as typeof fetch,
    });
    const err = await failing.send(input).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect((err as Error).message).toBe("email provider returned 401");
  });

  test("sms and whatsapp adapters parse provider ids", async () => {
    const sms = getChannel(
      "sms",
      { NOTIFY_SMS_PROVIDER: "africastalking", AT_USERNAME: "u", AT_API_KEY: "k" },
      {
        fetch: (async () =>
          new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ messageId: "ATXid_1", statusCode: 101 }] } }))) as unknown as typeof fetch,
      },
    );
    expect((await sms.send({ ...input, to: "+254700111222" })).providerMessageId).toBe("ATXid_1");
    const wa = getChannel(
      "whatsapp",
      { NOTIFY_WHATSAPP_PROVIDER: "cloudapi", WHATSAPP_PHONE_NUMBER_ID: "123", WHATSAPP_ACCESS_TOKEN: "t" },
      {
        fetch: (async () => new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }))) as unknown as typeof fetch,
        placeholderOrder: (k) => TEMPLATES[k].placeholders,
      },
    );
    expect((await wa.send({ ...input, to: "+254700111222" })).providerMessageId).toBe("wamid.1");
  });

  test("channelStatus reports modes and missing variable names, never values", () => {
    const status = channelStatus({
      NOTIFY_EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_secret_key",
      NOTIFY_SMS_PROVIDER: "africastalking",
      AT_USERNAME: "u",
    });
    expect(status.email).toMatchObject({ mode: "dry_run", requested: true, missing: ["NOTIFY_EMAIL_FROM"] });
    expect(status.sms.mode).toBe("dry_run");
    expect(status.sms.missing).toEqual(["AT_API_KEY"]);
    expect(status.whatsapp).toMatchObject({ mode: "dry_run", requested: false });
    expect(JSON.stringify(status)).not.toContain("re_secret_key");
  });
});
