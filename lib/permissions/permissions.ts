/**
 * Every permission the application understands. Shared by Convex functions
 * (authoritative enforcement) and the UI (hiding controls only).
 */
export const PERMISSIONS = [
  "organization:manage",
  "appointments:create",
  "appointments:read_site",
  "appointments:read_own",
  "appointments:update",
  "appointments:cancel",
  "appointments:approve",
  "visitors:register_walk_in",
  "visits:read_site",
  "visits:check_in",
  "visits:check_out",
  "staff_attendance:create",
  "staff_attendance:read_own",
  "staff_attendance:read_site",
  "staff_attendance:correct",
  "reports:read",
  "reports:export",
  "audit:read",
  "forms:manage",
  "members:read",
  "members:manage",
  "sites:read",
  "sites:manage",
  "integrations:manage",
  "billing:manage",
  "settings:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}
