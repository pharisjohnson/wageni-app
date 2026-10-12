import { PERMISSIONS, type Permission } from "./permissions";

/** Organization-level roles. The SaaS platform role lives on `users.platformRole`. */
export const ORG_ROLES = [
  "owner",
  "admin",
  "receptionist",
  "guard",
  "host",
  "staff",
] as const;

export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: "Owner",
  admin: "Administrator",
  receptionist: "Receptionist",
  guard: "Guard",
  host: "Host",
  staff: "Staff member",
};

const OWNER_ONLY: readonly Permission[] = ["billing:manage", "organization:manage"];

/**
 * Default permissions per role. Organizations may adjust individual
 * memberships with overrides (see `resolve.ts`), never by editing this table.
 */
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((p) => !OWNER_ONLY.includes(p)),
  receptionist: [
    "appointments:create",
    "appointments:read_site",
    "appointments:read_own",
    "appointments:update",
    "appointments:cancel",
    "visitors:register_walk_in",
    "visits:read_site",
    "members:read",
    "sites:read",
    "reports:read",
    "staff_attendance:read_own",
    "staff_attendance:create",
  ],
  guard: [
    "appointments:read_site",
    "visits:read_site",
    "visits:check_in",
    "visits:check_out",
    "sites:read",
    "staff_attendance:read_own",
    "staff_attendance:create",
  ],
  host: [
    "appointments:create",
    "appointments:read_own",
    "appointments:approve",
    "appointments:cancel",
    "staff_attendance:read_own",
    "staff_attendance:create",
  ],
  staff: ["staff_attendance:read_own", "staff_attendance:create"],
};

/** Higher rank can manage lower rank. Used to stop privilege escalation. */
export const ROLE_RANK: Record<OrgRole, number> = {
  owner: 100,
  admin: 80,
  receptionist: 40,
  guard: 30,
  host: 30,
  staff: 10,
};
