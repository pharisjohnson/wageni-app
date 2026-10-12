"use client";

import { useConvexAuth, useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Ensures the signed-in identity has a Convex user record before any
 * organization data is requested. Returns the auth state once that is done.
 */
export function useStoreUser() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const storeUser = useMutation(api.users.store);
  const [userId, setUserId] = useState<Id<"users"> | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    storeUser({})
      .then((id) => !cancelled && setUserId(id))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e : new Error("Sign-in failed")));
    return () => {
      cancelled = true;
      setUserId(null);
    };
  }, [isAuthenticated, storeUser]);

  return {
    isLoading: isLoading || (isAuthenticated && userId === null && error === null),
    isAuthenticated: isAuthenticated && userId !== null,
    error,
  };
}
