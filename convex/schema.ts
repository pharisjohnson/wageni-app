import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vBranding,
  vGateType,
  vMembershipStatus,
  vOrgRole,
  vOrgStatus,
  vPermissionOverrides,
  vAppointmentStatus,
  vRecordStatus,
  vSiteAccess,
  vCheckOutMethod,
  vVisitEventType,
  vVisitStatus,
  vAttendanceType,
  vAttendanceSource,
  vCorrectionStatus,
  vAnswers,
  vFileKind,
  vVerifyStatus,
  vFormAudience,
  vFormField,
  vFormStatus,
  vInvitationStatus,
  vOrgPolicies,

  vRetention,
  vChannel,
  vNotificationStatus,
} from "./validators";

/**
 * Phase 1 schema. Every tenant-owned table carries `organizationId` and is
 * indexed by it; site-scoped tables also carry `siteId`. Later phases add
 * appointments, visits, attendance, forms, notifications and billing tables.
 */
export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    // SaaS operator role. Grants platform administration only, never
    // implicit access to organization data.
    platformRole: v.optional(v.literal("super_admin")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_email", ["email"]),

  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    branding: vBranding,
    timeZone: v.string(),
    status: vOrgStatus,
    isDemo: v.optional(v.boolean()),
    // --- F1: policy switches (face capture is OFF unless true; approval defaults to required)
    policies: v.optional(vOrgPolicies),
    // --- end F1
    // --- P1: retention periods in days (resolved + clamped by lib/retention.ts)
    retention: v.optional(vRetention),
    // --- end P1
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_created", ["createdAt"]),

  memberships: defineTable({
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    role: vOrgRole,
    permissionOverrides: vPermissionOverrides,
    siteAccess: vSiteAccess,
    status: vMembershipStatus,
    // A1: kiosk staff identifier (unique per organization, upper case).
    staffNumber: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_user", ["userId"])
    .index("by_org_user", ["organizationId", "userId"])
    .index("by_org_staff_number", ["organizationId", "staffNumber"]),

  sites: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    address: v.optional(v.string()),
    timeZone: v.string(),
    status: vRecordStatus,
    // --- F1: overrides the organization's approval policy for this site
    requireApproval: v.optional(v.boolean()),
    // --- end F1
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_org", ["organizationId"]),

  gates: defineTable({
    organizationId: v.id("organizations"),
    siteId: v.id("sites"),
    name: v.string(),
    type: vGateType,
    status: vRecordStatus,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_site", ["siteId"]),

  visitors: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    company: v.optional(v.string()),
    // P1: set by retention.purgeExpired once PII has been removed.
    anonymisedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_phone", ["organizationId", "phone"]),

  appointments: defineTable({
    organizationId: v.id("organizations"),
    siteId: v.id("sites"),
    visitorId: v.id("visitors"),
    hostUserId: v.id("users"),
    purpose: v.string(),
    scheduledStart: v.number(),
    scheduledEnd: v.number(),
    status: vAppointmentStatus,
    createdBy: v.id("users"),
    decidedBy: v.optional(v.id("users")),
    decisionNote: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_start", ["organizationId", "scheduledStart"])
    .index("by_site_start", ["siteId", "scheduledStart"])
    .index("by_host_start", ["hostUserId", "scheduledStart"])
    // P1
    .index("by_visitor", ["visitorId"])
    // N1: reminder scan across organizations
    .index("by_status_start", ["status", "scheduledStart"]),

  visits: defineTable({
    organizationId: v.id("organizations"),
    siteId: v.id("sites"),
    visitorId: v.id("visitors"),
    appointmentId: v.optional(v.id("appointments")),
    hostUserId: v.optional(v.id("users")),
    purpose: v.string(),
    status: vVisitStatus,
    badgeCode: v.optional(v.string()),
    checkedInAt: v.optional(v.number()),
    checkedInGateId: v.optional(v.id("gates")),
    checkedOutAt: v.optional(v.number()),
    checkedOutGateId: v.optional(v.id("gates")),
    checkedOutMethod: v.optional(vCheckOutMethod),
    // P1: set by retention.purgeExpired when the badge code is cleared.
    anonymisedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId", "createdAt"])
    .index("by_site_status", ["siteId", "status"])
    .index("by_appointment", ["appointmentId"])
    // --- P1: reports and retention
    .index("by_site_created", ["siteId", "createdAt"])
    .index("by_visitor", ["visitorId"])
    .index("by_org_anon", ["organizationId", "anonymisedAt", "createdAt"]),
    // --- end P1

  // Append-only: never patched or deleted.
  visitEvents: defineTable({
    organizationId: v.id("organizations"),
    siteId: v.id("sites"),
    visitId: v.id("visits"),
    type: vVisitEventType,
    // K2: exactly one of these is set. A signed-in user, or (self-service
    // kiosk) the paired device, which is the event's origin.
    actorUserId: v.optional(v.id("users")),
    kioskDeviceId: v.optional(v.id("kioskDevices")),
    gateId: v.optional(v.id("gates")),
    at: v.number(),
  }).index("by_visit", ["visitId", "at"]),

  auditLogs: defineTable({
    organizationId: v.id("organizations"),
    // K2: exactly one of actorUserId / kioskDeviceId is set.
    actorUserId: v.optional(v.id("users")),
    kioskDeviceId: v.optional(v.id("kioskDevices")),
    action: v.string(),
    resourceType: v.string(),
    resourceId: v.string(),
    metadata: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()))),
    at: v.number(),
  })
    .index("by_org_at", ["organizationId", "at"])
    // --- P1: audit log filters
    .index("by_org_actor_at", ["organizationId", "actorUserId", "at"])
    .index("by_org_action_at", ["organizationId", "action", "at"])
    .index("by_org_resource_at", ["organizationId", "resourceType", "at"]),
    // --- end P1

  // --- K1: kiosk device pairing. Only a SHA-256 hash of the token is stored.
  kioskDevices: defineTable({
    organizationId: v.id("organizations"),
    siteId: v.id("sites"),
    gateId: v.id("gates"),
    name: v.string(),
    tokenHash: v.string(),
    status: v.union(v.literal("active"), v.literal("revoked")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    lastSeenAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    // Fixed-window rate limit counters (see convex/lib/kiosk.ts).
    rateWindowStart: v.optional(v.number()),
    rateCount: v.optional(v.number()),
    // --- K2: failed-lookup throttle (appointment lookup, badge check-out).
    lookupWindowStart: v.optional(v.number()),
    lookupFailures: v.optional(v.number()),
    // --- end K2
  })
    .index("by_org", ["organizationId"])
    .index("by_gate", ["gateId"])
    .index("by_token_hash", ["tokenHash"]),
  // --- end K1

  // --- A1: staff attendance
  // Append-only: never patched or deleted. Corrections add NEW events that
  // reference the event they replace (`correctsEventId`).
  attendanceEvents: defineTable({
    organizationId: v.id("organizations"),
    siteId: v.id("sites"),
    userId: v.id("users"),
    type: vAttendanceType,
    at: v.number(),
    source: vAttendanceSource,
    gateId: v.optional(v.id("gates")),
    kioskDeviceId: v.optional(v.id("kioskDevices")),
    // Who entered it when it was not the person themselves (reception, manager).
    recordedBy: v.optional(v.id("users")),
    // Set only on events produced by an approved correction.
    correctionId: v.optional(v.id("attendanceCorrections")),
    correctsEventId: v.optional(v.id("attendanceEvents")),
    createdAt: v.number(),
  })
    .index("by_user_at", ["organizationId", "userId", "at"])
    .index("by_site_at", ["siteId", "at"]),

  // Requests only change `status` and the decision fields, once.
  attendanceCorrections: defineTable({
    organizationId: v.id("organizations"),
    siteId: v.id("sites"),
    userId: v.id("users"),
    requestedBy: v.id("users"),
    originalEventId: v.optional(v.id("attendanceEvents")),
    proposedType: vAttendanceType,
    proposedAt: v.number(),
    reason: v.string(),
    status: vCorrectionStatus,
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    decisionNote: v.optional(v.string()),
    resultEventId: v.optional(v.id("attendanceEvents")),
    createdAt: v.number(),
  })
    .index("by_org_status", ["organizationId", "status", "createdAt"])
    .index("by_user_status", ["organizationId", "userId", "status"])
    .index("by_original", ["originalEventId"]),

  // Kiosk PINs. Only a salted PBKDF2 hash is stored; never returned to clients.
  staffPins: defineTable({
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    pinHash: v.string(),
    salt: v.string(),
    iterations: v.number(),
    failedAttempts: v.number(),
    lockedUntil: v.optional(v.number()),
    setBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_org_user", ["organizationId", "userId"]),
  // --- end A1

  // --- F1: forms, immutable versions, responses, files, invitations
  // `draftFields` is the editable working copy. Publishing copies it into a
  // NEW `formVersions` row; version rows are never patched or deleted.
  forms: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    audience: vFormAudience,
    siteId: v.optional(v.id("sites")),
    purpose: v.optional(v.string()),
    status: vFormStatus,
    draftFields: v.array(vFormField),
    publishedVersionId: v.optional(v.id("formVersions")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId", "createdAt"])
    .index("by_org_audience_status", ["organizationId", "audience", "status"]),

  formVersions: defineTable({
    organizationId: v.id("organizations"),
    formId: v.id("forms"),
    version: v.number(),
    name: v.string(),
    audience: vFormAudience,
    siteId: v.optional(v.id("sites")),
    fields: v.array(vFormField),
    publishedAt: v.number(),
    publishedBy: v.id("users"),
  }).index("by_form", ["formId", "version"]),

  // A response permanently references the version it was answered with.
  // Exactly one subject: visitId (or appointmentId before the visit exists)
  // for visitor forms, userId for staff forms.
  formResponses: defineTable({
    organizationId: v.id("organizations"),
    siteId: v.optional(v.id("sites")),
    formId: v.id("forms"),
    formVersionId: v.id("formVersions"),
    visitId: v.optional(v.id("visits")),
    appointmentId: v.optional(v.id("appointments")),
    userId: v.optional(v.id("users")),
    // F2: the clock-in a staff response was given with.
    attendanceEventId: v.optional(v.id("attendanceEvents")),
    answers: vAnswers,
    // F2: when this row should next be looked at by the answer-retention job
    // (earliest field deadline, at most 30 days ahead; far future = nothing left to redact).
    nextRedactionCheck: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_visit", ["visitId"])
    .index("by_appointment", ["appointmentId"])
    .index("by_org_user", ["organizationId", "userId", "createdAt"])
    .index("by_org_redaction", ["organizationId", "nextRedactionCheck"]),

  // Private Convex storage objects. `deleteAfter` drives retention; the
  // record outlives the bytes (status "deleted") so answers can say "removed".
  files: defineTable({
    organizationId: v.id("organizations"),
    siteId: v.optional(v.id("sites")),
    storageId: v.optional(v.id("_storage")),
    kind: vFileKind,
    contentType: v.string(),
    size: v.number(),
    status: v.union(v.literal("pending"), v.literal("attached"), v.literal("deleted")),
    // Who uploaded: a paired kiosk device, or an invitation (public link).
    uploadedByDeviceId: v.optional(v.id("kioskDevices")),
    uploadedByInvitationId: v.optional(v.id("invitations")),
    responseId: v.optional(v.id("formResponses")),
    fieldId: v.optional(v.string()),
    // F2: magic-byte check result. A file can be opened only once "verified".
    verifyStatus: v.optional(vVerifyStatus),
    verifiedAt: v.optional(v.number()),
    rejectedReason: v.optional(v.string()),
    deleteAfter: v.number(),
    createdAt: v.number(),
  })
    .index("by_status_delete_after", ["status", "deleteAfter"])
    .index("by_storage", ["storageId"]),

  // F2: one row per upload URL handed out, cleared when the upload is
  // registered. Rows that expire uncleared mean a blob may be orphaned.
  uploadIntents: defineTable({
    organizationId: v.id("organizations"),
    kioskDeviceId: v.optional(v.id("kioskDevices")),
    invitationId: v.optional(v.id("invitations")),
    kind: vFileKind,
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_expires", ["expiresAt"])
    .index("by_device", ["kioskDeviceId", "createdAt"])
    .index("by_invitation", ["invitationId", "createdAt"]),

  // F2: tiny key/number store for background sweeps (e.g. the orphan-scan watermark).
  sweepState: defineTable({ key: v.string(), value: v.number() }).index("by_key", ["key"]),

  invitations: defineTable({
    organizationId: v.id("organizations"),
    siteId: v.id("sites"),
    hostUserId: v.id("users"),
    createdBy: v.id("users"),
    visitorName: v.optional(v.string()),
    visitorPhone: v.optional(v.string()),
    visitorEmail: v.optional(v.string()),
    purpose: v.string(),
    scheduledStart: v.number(),
    scheduledEnd: v.number(),
    // SHA-256 of the link token. The token itself is never stored.
    tokenHash: v.string(),
    status: vInvitationStatus,
    expiresAt: v.number(),
    formId: v.optional(v.id("forms")),
    appointmentId: v.optional(v.id("appointments")),
    // Pending-state writes (uploads) per invitation, to stop abuse of a leaked link.
    uploadCount: v.optional(v.number()),
    submittedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_org", ["organizationId", "createdAt"])
    .index("by_host", ["hostUserId", "createdAt"]),

  // Fixed-window counters for public (unauthenticated) endpoints.
  publicRateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_window", ["windowStart"]),
  // --- end F1

  // --- N1: notifications
  // One row per message per channel. `payload` holds placeholder values only
  // (no more personal data than the template needs); sensitive ones (links)
  // are redacted once the message is settled. `to` is the resolved address and
  // is purged with the row by the retention cron.
  notificationOutbox: defineTable({
    organizationId: v.id("organizations"),
    siteId: v.optional(v.id("sites")),
    channel: vChannel,
    eventType: v.string(),
    templateKey: v.string(),
    recipientKind: v.union(v.literal("user"), v.literal("visitor")),
    recipientUserId: v.optional(v.id("users")),
    to: v.optional(v.string()),
    payload: v.record(v.string(), v.string()),
    status: vNotificationStatus,
    attempts: v.number(),
    lastError: v.optional(v.string()),
    providerMessageId: v.optional(v.string()),
    mode: v.optional(v.union(v.literal("dry_run"), v.literal("live"))),
    // Receipt reported by the provider webhook.
    deliveryStatus: v.optional(v.union(v.literal("delivered"), v.literal("read"), v.literal("failed"))),
    idempotencyKey: v.string(),
    nextAttemptAt: v.optional(v.number()),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
  })
    .index("by_org_created", ["organizationId", "createdAt"])
    .index("by_org_status_created", ["organizationId", "status", "createdAt"])
    .index("by_org_idem", ["organizationId", "idempotencyKey"])
    .index("by_status_created", ["status", "createdAt"])
    .index("by_provider_message", ["providerMessageId"]),

  // Per member: which events reach them on which channel, an optional phone
  // for SMS/WhatsApp, and quiet hours (minutes after midnight, organization time zone).
  notificationPreferences: defineTable({
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    phone: v.optional(v.string()),
    events: v.record(
      v.string(),
      v.object({ email: v.optional(v.boolean()), sms: v.optional(v.boolean()), whatsapp: v.optional(v.boolean()) }),
    ),
    quietStartMin: v.optional(v.number()),
    quietEndMin: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_org_user", ["organizationId", "userId"]),

  notificationSettings: defineTable({
    organizationId: v.id("organizations"),
    enabledChannels: v.array(vChannel),
    senderName: v.optional(v.string()),
    templateOverrides: v.record(v.string(), v.object({ subject: v.optional(v.string()), body: v.optional(v.string()) })),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  }).index("by_org", ["organizationId"]),

  // Fixed one-hour window per organization (rate limit for outgoing messages).
  notificationUsage: defineTable({
    organizationId: v.id("organizations"),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_org", ["organizationId"]),
  // --- end N1
});
