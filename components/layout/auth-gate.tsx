"use client";

import { RedirectToSignIn } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { useStoreUser } from "@/lib/auth/use-store-user";
import { FullPageSpinner } from "./full-page-spinner";

/**
 * Renders children only once the user is signed in and their Convex user
 * record exists. Purely a UX gate — Convex functions enforce access.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, error } = useStoreUser();
  if (error) {
    return (
      <main className="flex flex-1 items-center justify-center p-6 text-center">
        <p className="text-destructive">We could not finish signing you in. Please reload the page.</p>
      </main>
    );
  }
  if (isLoading) return <FullPageSpinner label="Signing you in…" />;
  if (!isAuthenticated) return <RedirectToSignIn />;
  return <>{children}</>;
}
