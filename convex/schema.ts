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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_user", ["userId"])
    .index("by_org_user", ["organizationId", "userId"]),

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
    actorUserId: v.id("users"),
    gateId: v.optional(v.id("gates")),
    at: v.number(),
  }).index("by_visit", ["visitId", "at"]),

  auditLogs: defineTable({
    organizationId: v.id("organizations"),
    actorUserId: v.id("users"),
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
  })
    .index("by_org", ["organizationId"])
    .index("by_gate", ["gateId"])
    .index("by_token_hash", ["tokenHash"]),
  // --- end K1
});
