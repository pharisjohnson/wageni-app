import { query } from "./_generated/server";

/**
 * Liveness probe for the health endpoint (app/api/health). Public, takes no
 * arguments, reads nothing and returns a constant, so it exposes no tenant
 * data and costs one empty function call.
 */
export const ping = query({
  args: {},
  handler: async () => ({ ok: true as const }),
});
