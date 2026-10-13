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
    .index("by_host_start", ["hostUserId", "scheduledStart"]),

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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId", "createdAt"])
    .index("by_site_status", ["siteId", "status"])
    .index("by_appointment", ["appointmentId"]),

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
  }).index("by_org_at", ["organizationId", "at"]),

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
});
