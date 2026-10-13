import type { Channel, EventType } from "./templates";

/**
 * Delivery adapters. One interface, one implementation per provider. The
 * default is the dry-run adapter, which sends nothing. Real adapters are thin
 * `fetch` wrappers selected by environment variables (set in the Convex
 * dashboard); secrets are read from env only and never logged or returned.
 */
export type SendInput = {
  /** Email address, or phone number in international format. */
  to: string;
  template: { key: EventType; subject: string; body: string };
  /** Raw placeholder values (used by providers that send templated messages). */
  data: Record<string, string>;
  senderName?: string;
};

export type SendResult = { providerMessageId: string; status: "sent" | "queued" };

export interface NotificationChannel {
  readonly channel: Channel;
  /** "dry_run" adapters record instead of sending. */
  readonly mode: "dry_run" | "live";
  readonly provider: string;
  send(input: SendInput): Promise<SendResult>;
}

export type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

/** Provider errors carry a status only: response bodies may echo recipients or credentials. */
export class ChannelError extends Error {}

/**
 * Dry-run adapter: returns a synthetic id and sends nothing. Test hook: an
 * address starting with `fail@` (or the phone `+15550000000`) throws, so retry
 * and failure paths can be exercised without a provider.
 */
export function dryRunChannel(channel: Channel): NotificationChannel {
  return {
    channel,
    mode: "dry_run",
    provider: "dry-run",
    async send({ to }) {
      if (/^fail@/i.test(to) || to === "+15550000000") throw new ChannelError("dry-run simulated failure");
      return { providerMessageId: `dry-${channel}-${crypto.randomUUID()}`, status: "sent" };
    },
  };
}

function need(env: Env, ...names: string[]): string[] | null {
  const values = names.map((n) => env[n]?.trim());
  return values.every(Boolean) ? (values as string[]) : null;
}

function resendEmail(env: Env, doFetch: Fetch): NotificationChannel | null {
  const cfg = need(env, "RESEND_API_KEY", "NOTIFY_EMAIL_FROM");
  if (!cfg) return null;
  const [apiKey, from] = cfg as [string, string];
  return {
    channel: "email",
    mode: "live",
    provider: "resend",
    async send({ to, template, senderName }) {
      const res = await doFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: senderName ? `${senderName.replace(/[<>"\r\n]/g, "")} <${from}>` : from,
          to: [to],
          subject: template.subject,
          text: template.body,
        }),
      });
      if (!res.ok) throw new ChannelError(`email provider returned ${res.status}`);
      const json = (await res.json().catch(() => ({}))) as { id?: string };
      if (!json.id) throw new ChannelError("email provider returned no message id");
      return { providerMessageId: json.id, status: "queued" };
    },
  };
}

/** Africa's Talking bulk SMS API. */
function africasTalkingSms(env: Env, doFetch: Fetch): NotificationChannel | null {
  const cfg = need(env, "AT_USERNAME", "AT_API_KEY");
  if (!cfg) return null;
  const [username, apiKey] = cfg as [string, string];
  const senderId = env.AT_SENDER_ID?.trim();
  const host = env.AT_SANDBOX === "true" ? "api.sandbox.africastalking.com" : "api.africastalking.com";
  return {
    channel: "sms",
    mode: "live",
    provider: "africastalking",
    async send({ to, template }) {
      const form = new URLSearchParams({ username, to, message: template.body });
      if (senderId) form.set("from", senderId);
      const res = await doFetch(`https://${host}/version1/messaging`, {
        method: "POST",
        headers: { apiKey, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      });
      if (!res.ok) throw new ChannelError(`sms provider returned ${res.status}`);
      const json = (await res.json().catch(() => ({}))) as {
        SMSMessageData?: { Recipients?: { messageId?: string; statusCode?: number }[] };
      };
      const first = json.SMSMessageData?.Recipients?.[0];
      if (!first?.messageId || (first.statusCode !== undefined && first.statusCode >= 400)) {
        throw new ChannelError("sms provider rejected the message");
      }
      return { providerMessageId: first.messageId, status: "queued" };
    },
  };
}

/**
 * WhatsApp Cloud API. Business-initiated messages must use an approved
 * template named `wageni_<eventKey>` whose body variables are the event's
 * placeholders in the order listed in `lib/notifications/templates.ts`.
 */
function whatsappCloud(env: Env, doFetch: Fetch, order: (key: EventType) => readonly string[]): NotificationChannel | null {
  const cfg = need(env, "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN");
  if (!cfg) return null;
  const [phoneId, token] = cfg as [string, string];
  return {
    channel: "whatsapp",
    mode: "live",
    provider: "whatsapp-cloud",
    async send({ to, template, data }) {
      const res = await doFetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(phoneId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: to.replace(/^\+/, ""),
          type: "template",
          template: {
            name: `wageni_${template.key}`,
            language: { code: "en" },
            components: [
              {
                type: "body",
                parameters: order(template.key).map((p) => ({ type: "text", text: data[p] ?? "" })),
              },
            ],
          },
        }),
      });
      if (!res.ok) throw new ChannelError(`whatsapp provider returned ${res.status}`);
      const json = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[] };
      const id = json.messages?.[0]?.id;
      if (!id) throw new ChannelError("whatsapp provider returned no message id");
      return { providerMessageId: id, status: "queued" };
    },
  };
}

/**
 * Pick the adapter for a channel from environment variables. Anything not
 * fully configured, or with the provider set to anything but its real name,
 * falls back to dry-run. Never throws and never reads secrets into results.
 */
export function getChannel(
  channel: Channel,
  env: Env,
  opts: { fetch?: Fetch; placeholderOrder?: (key: EventType) => readonly string[] } = {},
): NotificationChannel {
  const doFetch = opts.fetch ?? fetch;
  const real =
    channel === "email" && env.NOTIFY_EMAIL_PROVIDER === "resend"
      ? resendEmail(env, doFetch)
      : channel === "sms" && env.NOTIFY_SMS_PROVIDER === "africastalking"
        ? africasTalkingSms(env, doFetch)
        : channel === "whatsapp" && env.NOTIFY_WHATSAPP_PROVIDER === "cloudapi"
          ? whatsappCloud(env, doFetch, opts.placeholderOrder ?? (() => []))
          : null;
  return real ?? dryRunChannel(channel);
}

/** Configuration status for the UI. Reports names and modes only, never values. */
export function channelStatus(env: Env): Record<
  Channel,
  { mode: "dry_run" | "live"; provider: string; requested: boolean; missing: string[] }
> {
  const spec: Record<Channel, { flag: string; value: string; vars: string[] }> = {
    email: { flag: "NOTIFY_EMAIL_PROVIDER", value: "resend", vars: ["RESEND_API_KEY", "NOTIFY_EMAIL_FROM"] },
    sms: { flag: "NOTIFY_SMS_PROVIDER", value: "africastalking", vars: ["AT_USERNAME", "AT_API_KEY"] },
    whatsapp: {
      flag: "NOTIFY_WHATSAPP_PROVIDER",
      value: "cloudapi",
      vars: ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN"],
    },
  };
  const out = {} as ReturnType<typeof channelStatus>;
  for (const ch of Object.keys(spec) as Channel[]) {
    const s = spec[ch];
    const requested = env[s.flag] === s.value;
    const missing = requested ? s.vars.filter((n) => !env[n]?.trim()) : [];
    const live = requested && missing.length === 0;
    out[ch] = { mode: live ? "live" : "dry_run", provider: live ? s.value : "dry-run", requested, missing };
  }
  return out;
}
