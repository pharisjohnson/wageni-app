/**
 * Public runtime configuration. Only NEXT_PUBLIC_* values may be read here,
 * because this module is imported by client components.
 */
export const appConfig = {
  name: process.env.NEXT_PUBLIC_APP_NAME || "Wageni",
  tagline: "Visitor management and staff attendance",
  url: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
  clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
};

/** Authentication + backend are both required for any signed-in feature. */
export const isBackendConfigured = Boolean(appConfig.convexUrl && appConfig.clerkPublishableKey);
