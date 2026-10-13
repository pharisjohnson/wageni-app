import { v } from "convex/values";
import { ORG_ROLES, PERMISSIONS } from "../lib/permissions";
import { FIELD_TYPES, FILE_KINDS, FORM_AUDIENCES, ID_SOURCES, MAPS_TO } from "../lib/validation/forms";

export const vOrgRole = v.union(...ORG_ROLES.map((r) => v.literal(r)));
export const vPermission = v.union(...PERMISSIONS.map((p) => v.literal(p)));

export const vPermissionOverrides = v.object({
  grant: v.array(vPermission),
  revoke: v.array(vPermission),
});

export const vSiteAccess = v.union(v.literal("all"), v.array(v.id("sites")));

export const vOrgStatus = v.union(
  v.literal("trial"),
  v.literal("active"),
  v.literal("suspended"),
);

export const vMembershipStatus = v.union(
  v.literal("active"),
  v.literal("invited"),
  v.literal("disabled"),
);

export const vRecordStatus = v.union(v.literal("active"), v.literal("inactive"));

export const vGateType = v.union(
  v.literal("pedestrian"),
  v.literal("vehicle"),
  v.literal("reception"),
  v.literal("other"),
);

export const vBranding = v.object({
  logoUrl: v.optional(v.string()),
  primaryColor: v.optional(v.string()),
  welcomeText: v.optional(v.string()),
  privacyNotice: v.optional(v.string()),
});

export const vAppointmentStatus = v.union(
  v.literal("pending_approval"),
  v.literal("approved"),
  v.literal("declined"),
  v.literal("cancelled"),
  v.literal("checked_in"),
  v.literal("completed"),
);

/** `expected` = registered (e.g. walk-in at reception) but not yet admitted at a gate. */
export const vVisitStatus = v.union(
  v.literal("expected"),
  v.literal("on_site"),
  v.literal("checked_out"),
);

export const vVisitEventType = v.union(
  v.literal("registered"),
  v.literal("checked_in"),
  v.literal("meeting_ended"),
  v.literal("checked_out"),
);

/** Who ended the visit: the host, a gate guard, reception, or the kiosk. */
export const vCheckOutMethod = v.union(
  v.literal("host"),
  v.literal("gate"),
  v.literal("reception"),
  v.literal("kiosk"),
);

// --- A1: staff attendance
export const vAttendanceType = v.union(v.literal("clock_in"), v.literal("clock_out"));

/** `correction` events are written only when a correction request is approved. */
export const vAttendanceSource = v.union(
  v.literal("app"),
  v.literal("kiosk"),
  v.literal("reception"),
  v.literal("correction"),
);

export const vCorrectionStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
// --- end A1

// --- F1: forms, files, invitations
export const vFieldType = v.union(...FIELD_TYPES.map((t) => v.literal(t)));
export const vFormAudience = v.union(...FORM_AUDIENCES.map((t) => v.literal(t)));
export const vFileKind = v.union(...FILE_KINDS.map((t) => v.literal(t)));
export const vVerifyStatus = v.union(v.literal("pending"), v.literal("verified"), v.literal("rejected"));

/** Mirrors `formFieldSchema` (lib/validation/forms.ts), which is stricter. */
export const vFormField = v.object({
  id: v.string(),
  type: vFieldType,
  label: v.string(),
  helpText: v.optional(v.string()),
  required: v.boolean(),
  options: v.optional(v.array(v.string())),
  showIf: v.optional(v.object({ fieldId: v.string(), equals: v.string() })),
  sensitive: v.boolean(),
  retentionDays: v.optional(v.number()),
  mapsTo: v.optional(v.union(...MAPS_TO.map((t) => v.literal(t)))),
  consentText: v.optional(v.string()),
  storeImage: v.optional(v.boolean()),
  idSource: v.optional(v.union(...ID_SOURCES.map((t) => v.literal(t)))),
});

export const vFormStatus = v.union(v.literal("draft"), v.literal("published"), v.literal("archived"));

/** One stored answer. Files are referenced by `files` record, never by raw storage id. */
export const vAnswerValue = v.union(
  v.string(),
  v.number(),
  v.boolean(),
  v.array(v.string()),
  v.object({ fileId: v.id("files") }),
  v.object({ accepted: v.boolean(), text: v.string() }),
  v.object({ scanned: v.boolean() }),
  // F2: tombstone left by the answer-retention job (the response row stays).
  v.object({ redacted: v.literal(true) }),
);
export const vAnswers = v.record(v.string(), vAnswerValue);

/** Client-supplied answers: file ids arrive as plain strings and are verified server side. */
export const vRawAnswerValue = v.union(
  v.string(),
  v.number(),
  v.boolean(),
  v.array(v.string()),
  v.object({ fileId: v.string() }),
  v.object({ accepted: v.boolean(), text: v.string() }),
  v.object({ scanned: v.boolean() }),
);
export const vRawAnswers = v.record(v.string(), vRawAnswerValue);

export const vInvitationStatus = v.union(
  v.literal("pending"),
  v.literal("submitted"),
  v.literal("expired"),
  v.literal("cancelled"),
);

/** Organization-level policy switches (Settings). */
export const vOrgPolicies = v.object({
  faceCaptureEnabled: v.optional(v.boolean()),
  requireApproval: v.optional(v.boolean()),
});
// --- end F1
// --- P1: retention periods (days)
export const vRetention = v.object({
  visitRecordsDays: v.number(),
  auditLogDays: v.number(),
  attendanceDays: v.number(),
});
// --- end P1

// --- N1: notifications
export const vChannel = v.union(v.literal("email"), v.literal("sms"), v.literal("whatsapp"));
export const vNotificationStatus = v.union(
  v.literal("queued"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("skipped"),
);
// --- end N1

// --- B1: billing
export const vSubscriptionStatus = v.union(
  v.literal("active"),
  v.literal("trialing"),
  v.literal("past_due"),
  v.literal("canceled"),
  v.literal("ended"),
);
export const vUsageKey = v.union(
  v.literal("visits"),
  v.literal("notifications"),
  v.literal("files"),
  v.literal("fileBytes"),
);
// --- end B1
