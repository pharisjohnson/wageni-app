import { ConvexError } from "convex/values";

/** Extract the safe, user-facing message from a Convex function error. */
export function errorMessage(error: unknown, fallback = "Something went wrong. Please try again.") {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: unknown } | string;
    if (typeof data === "string") return data;
    if (typeof data?.message === "string") return data.message;
  }
  return fallback;
}

export function errorCode(error: unknown): string | null {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: unknown };
    if (typeof data?.code === "string") return data.code;
  }
  return null;
}

export type PlanLimitInfo = {
  kind: "feature" | "limit";
  key: string;
  message: string;
  limit?: number;
  requiredTier?: string;
};

/** Details of a PLAN_LIMIT error (a feature or limit the plan does not include), else null. */
export function planLimitInfo(error: unknown): PlanLimitInfo | null {
  if (!(error instanceof ConvexError)) return null;
  const d = error.data as Partial<PlanLimitInfo> & { code?: unknown };
  if (d?.code !== "PLAN_LIMIT" || typeof d.message !== "string") return null;
  return {
    kind: d.kind === "limit" ? "limit" : "feature",
    key: typeof d.key === "string" ? d.key : "",
    message: d.message,
    limit: typeof d.limit === "number" ? d.limit : undefined,
    requiredTier: typeof d.requiredTier === "string" ? d.requiredTier : undefined,
  };
}

export const isPlanLimit = (error: unknown) => planLimitInfo(error) !== null;
