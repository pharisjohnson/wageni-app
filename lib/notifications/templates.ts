/**
 * Notification events and message templates, all in one place.
 *
 * - English first. `messages` is keyed by locale so Swahili (`sw`) can be added
 *   per event later without touching delivery code; a missing locale falls
 *   back to English.
 * - Templates use `{{placeholder}}`. Each event lists the placeholders it may
 *   use (`placeholders`); anything else renders as empty, and organization
 *   overrides may only use that list (see `validateOverride`).
 * - Visitor-facing messages carry the minimum: first name, organization, time
 *   and host name. Never purpose, company, phone, email, badge code or ids.
 */
export const CHANNELS = ["email", "sms", "whatsapp"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export const LOCALES = ["en", "sw"] as const;
export type Locale = (typeof LOCALES)[number];

export type Audience = "staff" | "visitor";

type Message = { subject: string; body: string };

export type TemplateDef = {
  audience: Audience;
  label: string;
  /** Placeholders the template (and any organization override) may use. */
  placeholders: readonly string[];
  /** Placeholders holding secrets (links). Redacted from the outbox once delivery is settled. */
  sensitive?: readonly string[];
  messages: { en: Message } & Partial<Record<Exclude<Locale, "en">, Message>>;
};

export const TEMPLATES = {
  visitor_arrived: {
    audience: "staff",
    label: "Visitor arrived (to host)",
    placeholders: ["visitorName", "siteName"],
    messages: {
      en: {
        subject: "Your visitor has arrived",
        body: "{{visitorName}} has arrived at {{siteName}} to see you.",
      },
    },
  },
  visitor_awaiting_admit: {
    audience: "staff",
    label: "Walk-in waiting (to host)",
    placeholders: ["visitorName", "siteName"],
    messages: {
      en: {
        subject: "A visitor is asking for you",
        body: "{{visitorName}} is at {{siteName}} asking for you and is waiting to be admitted.",
      },
    },
  },
  appointment_requested: {
    audience: "staff",
    label: "Appointment needs approval (to host)",
    placeholders: ["visitorName", "when", "siteName"],
    messages: {
      en: {
        subject: "Appointment request to approve",
        body: "{{visitorName}} is booked to see you at {{siteName}} on {{when}}. Please approve or decline it.",
      },
    },
  },
  appointment_approved: {
    audience: "visitor",
    label: "Appointment approved (to visitor)",
    placeholders: ["firstName", "orgName", "when", "hostName"],
    messages: {
      en: {
        subject: "Your visit to {{orgName}} is confirmed",
        body: "Hello {{firstName}}, your visit to {{orgName}} on {{when}} is confirmed. You will be meeting {{hostName}}.",
      },
    },
  },
  appointment_declined: {
    audience: "visitor",
    label: "Appointment declined (to visitor)",
    placeholders: ["firstName", "orgName"],
    messages: {
      en: {
        subject: "Your visit request to {{orgName}}",
        body: "Hello {{firstName}}, we are sorry, your visit request to {{orgName}} could not be accepted. Please contact them to arrange another time.",
      },
    },
  },
  appointment_cancelled: {
    audience: "visitor",
    label: "Appointment cancelled (to visitor)",
    placeholders: ["firstName", "orgName", "when"],
    messages: {
      en: {
        subject: "Your visit to {{orgName}} was cancelled",
        body: "Hello {{firstName}}, your visit to {{orgName}} planned for {{when}} has been cancelled.",
      },
    },
  },
  appointment_rescheduled: {
    audience: "visitor",
    label: "Appointment rescheduled (to visitor)",
    placeholders: ["firstName", "orgName", "when", "hostName"],
    messages: {
      en: {
        subject: "Your visit to {{orgName}} has a new time",
        body: "Hello {{firstName}}, your visit to {{orgName}} has moved to {{when}}. You will be meeting {{hostName}}.",
      },
    },
  },
  appointment_cancelled_host: {
    audience: "staff",
    label: "Appointment cancelled (to host)",
    placeholders: ["visitorName", "when"],
    messages: {
      en: {
        subject: "Appointment cancelled",
        body: "The appointment with {{visitorName}} planned for {{when}} was cancelled.",
      },
    },
  },
  appointment_rescheduled_host: {
    audience: "staff",
    label: "Appointment rescheduled (to host)",
    placeholders: ["visitorName", "when"],
    messages: {
      en: {
        subject: "Appointment time changed",
        body: "The appointment with {{visitorName}} has moved to {{when}}.",
      },
    },
  },
  appointment_reminder: {
    audience: "visitor",
    label: "Appointment reminder (to visitor)",
    placeholders: ["firstName", "orgName", "when", "hostName"],
    messages: {
      en: {
        subject: "Reminder: your visit to {{orgName}}",
        body: "Hello {{firstName}}, a reminder of your visit to {{orgName}} on {{when}}. You will be meeting {{hostName}}.",
      },
    },
  },
  missed_clock_out: {
    audience: "staff",
    label: "Missed clock-out (to staff)",
    placeholders: ["siteName", "since"],
    messages: {
      en: {
        subject: "Did you forget to clock out?",
        body: "You clocked in at {{siteName}} on {{since}} and have not clocked out. If you forgot, request a correction.",
      },
    },
  },
  corrections_pending: {
    audience: "staff",
    label: "Corrections waiting (to managers)",
    placeholders: ["count"],
    messages: {
      en: {
        subject: "Attendance corrections need a decision",
        body: "{{count}} attendance correction(s) are waiting for your decision.",
      },
    },
  },
  invitation_created: {
    audience: "visitor",
    label: "Invitation (to invitee)",
    placeholders: ["firstName", "orgName", "link"],
    sensitive: ["link"],
    messages: {
      en: {
        subject: "You are invited to {{orgName}}",
        body: "Hello {{firstName}}, you have been invited by {{orgName}}. Open this link to continue: {{link}}",
      },
    },
  },
  billing_renewal_reminder: {
    audience: "staff",
    label: "Plan renewal reminder (to billing managers)",
    placeholders: ["orgName", "planName", "endDate", "daysLeft", "link"],
    messages: {
      en: {
        subject: "Your {{planName}} plan ends in {{daysLeft}} day(s)",
        body: "The {{planName}} plan for {{orgName}} ends on {{endDate}}. M-Pesa is paid once per period and does not renew automatically, so please pay again before then to keep the plan: {{link}}",
      },
    },
  },
  billing_payment_received: {
    audience: "staff",
    label: "Payment receipt (to billing managers)",
    placeholders: ["orgName", "planName", "amount", "receipt", "endDate"],
    messages: {
      en: {
        subject: "Payment received for {{orgName}}",
        body: "We received {{amount}} (M-Pesa code {{receipt}}) for the {{planName}} plan of {{orgName}}. It is paid until {{endDate}}. Thank you.",
      },
    },
  },
  billing_plan_expired: {
    audience: "staff",
    label: "Plan expired (to billing managers)",
    placeholders: ["orgName", "planName", "graceEnd", "link"],
    messages: {
      en: {
        subject: "Your {{planName}} plan has ended",
        body: "The {{planName}} plan for {{orgName}} has ended. You keep it until {{graceEnd}}; after that {{orgName}} moves to Starter. Nothing is deleted. Pay again to keep it: {{link}}",
      },
    },
  },
  test_message: {
    audience: "staff",
    label: "Test message",
    placeholders: ["orgName"],
    messages: {
      en: {
        subject: "Wageni test message",
        body: "This is a test message from {{orgName}} on Wageni. If you can read it, this channel works.",
      },
    },
  },
} as const satisfies Record<string, TemplateDef>;

export type EventType = keyof typeof TEMPLATES;
export const EVENT_TYPES = Object.keys(TEMPLATES) as EventType[];

/** Events a member can switch on or off per channel (staff-facing, not tests). */
export const PREFERENCE_EVENTS = EVENT_TYPES.filter(
  (e) => TEMPLATES[e].audience === "staff" && e !== "test_message",
);

export function isEventType(value: string): value is EventType {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}

/** Placeholders redacted from stored payloads once a message is settled. */
export function sensitivePlaceholders(event: EventType): readonly string[] {
  const def: TemplateDef = TEMPLATES[event];
  return def.sensitive ?? [];
}

export const MAX_SUBJECT = 120;
export const MAX_BODY = 600;
const MAX_VALUE = 200;
const TOKEN = /\{\{\s*(\w+)\s*\}\}/g;

/** Strip control characters and cap length so a placeholder value cannot reshape a message. */
export function cleanValue(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, MAX_VALUE);
}

function fill(text: string, allowed: readonly string[], data: Record<string, string>) {
  return text.replace(TOKEN, (_m, name: string) => (allowed.includes(name) ? cleanValue(data[name]) : ""));
}

export type Override = { subject?: string; body?: string };

/** Render a template with data. `override` (organization) replaces the default text when set. */
export function renderTemplate(
  event: EventType,
  data: Record<string, string>,
  opts: { locale?: Locale; override?: Override } = {},
): { subject: string; body: string } {
  const def: TemplateDef = TEMPLATES[event];
  const base = def.messages[opts.locale ?? "en"] ?? def.messages.en;
  const subject = opts.override?.subject?.trim() || base.subject;
  const body = opts.override?.body?.trim() || base.body;
  return { subject: fill(subject, def.placeholders, data), body: fill(body, def.placeholders, data) };
}

/** Returns an error message, or null when the override is safe to save. */
export function validateOverride(event: EventType, override: Override): string | null {
  const def: TemplateDef = TEMPLATES[event];
  for (const [field, text, max] of [
    ["subject", override.subject, MAX_SUBJECT],
    ["body", override.body, MAX_BODY],
  ] as const) {
    if (text === undefined) continue;
    if (text.length > max) return `The ${field} must be at most ${max} characters.`;
    for (const m of text.matchAll(TOKEN)) {
      if (!def.placeholders.includes(m[1]!)) {
        return `{{${m[1]}}} is not available in this message. Use: ${def.placeholders.map((p) => `{{${p}}}`).join(", ")}.`;
      }
    }
    if (/<[a-z/!][^>]*>/i.test(text)) return `The ${field} cannot contain HTML.`;
  }
  return null;
}
