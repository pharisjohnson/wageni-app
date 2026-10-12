import type { Permission } from "./permissions";
import { ROLE_PERMISSIONS, ROLE_RANK, type OrgRole } from "./roles";

export type PermissionOverrides = {
  grant: readonly Permission[];
  revoke: readonly Permission[];
};

export const NO_OVERRIDES: PermissionOverrides = { grant: [], revoke: [] };

/** Role defaults, plus grants, minus revokes. Revokes win over grants. */
export function effectivePermissions(
  role: OrgRole,
  overrides: PermissionOverrides = NO_OVERRIDES,
): Set<Permission> {
  const result = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const p of overrides.grant) result.add(p);
  for (const p of overrides.revoke) result.delete(p);
  return result;
}

export function can(perms: ReadonlySet<Permission>, permission: Permission) {
  return perms.has(permission);
}

/**
 * Whether `actor` may assign `targetRole` to someone currently holding
 * `currentRole`. Only owners may create or demote owners; everyone else must
 * strictly outrank both the current and the new role.
 */
export function canAssignRole(
  actorRole: OrgRole,
  currentRole: OrgRole | null,
  targetRole: OrgRole,
): boolean {
  if (actorRole === "owner") return true;
  const actorRank = ROLE_RANK[actorRole];
  if (currentRole && ROLE_RANK[currentRole] >= actorRank) return false;
  return ROLE_RANK[targetRole] < actorRank;
}

/** An actor may only grant permissions they hold themselves. */
export function canGrantOverrides(
  actorPerms: ReadonlySet<Permission>,
  overrides: PermissionOverrides,
): boolean {
  return overrides.grant.every((p) => actorPerms.has(p));
}
