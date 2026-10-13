import { describe, expect, test } from "vitest";
import {
  canAssignRole,
  canGrantOverrides,
  effectivePermissions,
  ORG_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
} from "@/lib/permissions";

describe("role defaults", () => {
  test("owners hold every permission", () => {
    expect([...effectivePermissions("owner")].sort()).toEqual([...PERMISSIONS].sort());
  });

  test("admins do not hold owner-only permissions", () => {
    const admin = effectivePermissions("admin");
    expect(admin.has("billing:manage")).toBe(false);
    expect(admin.has("organization:manage")).toBe(false);
    expect(admin.has("members:manage")).toBe(true);
  });

  test("receptionist defaults match the spec", () => {
    const r = effectivePermissions("receptionist");
    expect(r.has("appointments:create")).toBe(true);
    expect(r.has("visitors:register_walk_in")).toBe(true);
    for (const p of [
      "billing:manage",
      "members:manage",
      "integrations:manage",
      "forms:manage",
      "settings:manage",
      "appointments:approve",
      "visits:check_in",
    ] as const) {
      expect(r.has(p), p).toBe(false);
    }
  });

  test("guards cannot book appointments or export", () => {
    const g = effectivePermissions("guard");
    expect(g.has("appointments:create")).toBe(false);
    expect(g.has("reports:export")).toBe(false);
    expect(g.has("visits:check_in")).toBe(true);
    expect(g.has("visits:check_out")).toBe(true);
  });

  test("check-out scopes: hosts only their own, reception any, staff none", () => {
    const host = effectivePermissions("host");
    expect(host.has("visits:check_out_own")).toBe(true);
    expect(host.has("visits:check_out")).toBe(false);
    expect(effectivePermissions("receptionist").has("visits:check_out")).toBe(true);
    expect(effectivePermissions("receptionist").has("visits:check_out_own")).toBe(false);
    expect(effectivePermissions("staff").has("visits:check_out_own")).toBe(false);
    expect(effectivePermissions("admin").has("visits:check_out_own")).toBe(true);
  });

  test("staff cannot correct attendance", () => {
    const s = effectivePermissions("staff");
    expect(s.has("staff_attendance:correct")).toBe(false);
    expect(s.has("staff_attendance:create")).toBe(true);
  });

  test("every role only references known permissions", () => {
    for (const role of ORG_ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
    }
  });
});

describe("overrides", () => {
  test("grants add and revokes remove, revokes win", () => {
    const perms = effectivePermissions("receptionist", {
      grant: ["appointments:approve", "visits:check_in"],
      revoke: ["visits:check_in", "appointments:create"],
    });
    expect(perms.has("appointments:approve")).toBe(true);
    expect(perms.has("visits:check_in")).toBe(false);
    expect(perms.has("appointments:create")).toBe(false);
  });

  test("actors may only grant what they hold", () => {
    const admin = effectivePermissions("admin");
    expect(canGrantOverrides(admin, { grant: ["visits:check_in"], revoke: [] })).toBe(true);
    expect(canGrantOverrides(admin, { grant: ["billing:manage"], revoke: [] })).toBe(false);
  });
});

describe("role assignment", () => {
  test("owners may assign any role", () => {
    expect(canAssignRole("owner", "admin", "owner")).toBe(true);
  });
  test("admins may only assign roles below their own, to members below them", () => {
    expect(canAssignRole("admin", "guard", "receptionist")).toBe(true);
    expect(canAssignRole("admin", "guard", "admin")).toBe(false);
    expect(canAssignRole("admin", "admin", "guard")).toBe(false);
    expect(canAssignRole("admin", "owner", "guard")).toBe(false);
  });
  test("receptionists cannot promote anyone to their level or above", () => {
    expect(canAssignRole("receptionist", "staff", "receptionist")).toBe(false);
  });
});
