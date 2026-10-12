import { mutation, query } from "./_generated/server";
import { appError } from "./lib/errors";

/**
 * Create or refresh the caller's user record from their verified identity.
 * Called by the client right after sign-in. Idempotent.
 */
export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError("UNAUTHENTICATED");
    const now = Date.now();
    const profile = {
      email: identity.email,
      name: identity.name ?? identity.nickname,
      imageUrl: identity.pictureUrl,
    };
    const existing = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { ...profile, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      ...profile,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** The caller's own profile, or null when signed out / not yet stored. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (!user) return null;
    return {
      _id: user._id,
      name: user.name ?? null,
      email: user.email ?? null,
      imageUrl: user.imageUrl ?? null,
      isPlatformAdmin: user.platformRole === "super_admin",
    };
  },
});
