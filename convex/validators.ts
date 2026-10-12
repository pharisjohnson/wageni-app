import { v } from "convex/values";
import { ORG_ROLES, PERMISSIONS } from "../lib/permissions";

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
  v.literal("checked_out"),
);
