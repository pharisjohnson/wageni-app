import { kioskMutation, kioskQuery } from "./lib/kiosk";

/**
 * Proof of the kiosk pattern: returns only what the screen needs to show.
 * Requires a valid device token (`{ slug, token }`); the URL alone is not enough.
 */
export const context = kioskQuery({
  args: {},
  handler: async (ctx) => ({
    siteName: ctx.kiosk.site.name,
    gateName: ctx.kiosk.gate.name,
  }),
});

/**
 * Lets a paired kiosk report that it is alive (updates lastSeenAt, subject to
 * the per-device rate limit). Also the reference kioskMutation.
 */
export const heartbeat = kioskMutation({
  args: {},
  handler: async () => ({ ok: true as const }),
});
