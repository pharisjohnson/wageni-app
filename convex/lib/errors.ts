import { ConvexError } from "convex/values";

export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PLAN_LIMIT";

/**
 * Errors safe to show to clients. Never put internal details in `message`.
 * Cross-tenant lookups deliberately surface as NOT_FOUND so record existence
 * in another organization is not revealed.
 */
export function appError(code: AppErrorCode, message?: string) {
  return new ConvexError({ code, message: message ?? DEFAULT_MESSAGES[code] });
}

const DEFAULT_MESSAGES: Record<AppErrorCode, string> = {
  UNAUTHENTICATED: "You must be signed in.",
  FORBIDDEN: "You do not have permission to perform this action.",
  NOT_FOUND: "The requested record was not found.",
  VALIDATION: "The submitted data is invalid.",
  CONFLICT: "This conflicts with an existing record.",
  RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
  PLAN_LIMIT: "Your current plan does not include this. Upgrade to continue.",
};

/**
 * A plan restriction. `kind` and `key` let the UI show an upgrade prompt for
 * the exact feature or limit; `message` is already user-facing.
 */
export function planLimitError(detail: {
  kind: "feature" | "limit";
  key: string;
  message: string;
  limit?: number;
  requiredTier?: string;
}) {
  return new ConvexError({ code: "PLAN_LIMIT" as const, ...detail });
}
