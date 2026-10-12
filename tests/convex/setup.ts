/// <reference types="vitest/importMeta" />
import { convexTest } from "convex-test";
import { expect } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import type { OrgRole } from "../../lib/permissions";

export const modules = import.meta.glob("../../convex/**/*.*s");

export function newTest() {
  return convexTest(schema, modules);
}

export type T = ReturnType<typeof newTest>;

/** Sign in as a new user and create their user record. */
export async function signIn(t: T, name: string) {
  const as = t.withIdentity({
    subject: name,
    tokenIdentifier: `test|${name}`,
    name,
    email: `${name}@example.com`,
  });
  const userId = await as.mutation(api.users.store, {});
  return { as, userId };
}

/** A signed-in owner with a fresh organization (and its default site). */
export async function createOrgWithOwner(t: T, name: string, slug: string) {
  const owner = await signIn(t, `${slug}-owner`);
  const { organizationId, siteId } = await owner.as.mutation(api.organizations.create, {
    name,
    slug,
    timeZone: "Africa/Nairobi",
    siteName: "Head Office",
  });
  return { owner, organizationId, siteId };
}

/**
 * Add a member directly. Invitations arrive in Phase 4; until then tests
 * insert memberships the same way the invitation flow will.
 */
export async function addMember(
  t: T,
  organizationId: Id<"organizations">,
  name: string,
  role: OrgRole,
  siteAccess: "all" | Id<"sites">[] = "all",
) {
  const member = await signIn(t, name);
  const membershipId = await t.run(async (ctx) =>
    ctx.db.insert("memberships", {
      organizationId,
      userId: member.userId,
      role,
      permissionOverrides: { grant: [], revoke: [] },
      siteAccess,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { ...member, membershipId };
}

/** Assert a Convex call fails with one of our safe AppError codes. */
export async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((e: unknown) => {
    const data = (e as { data?: { code?: string } }).data;
    return data?.code === code;
  });
}
