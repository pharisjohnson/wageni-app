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
