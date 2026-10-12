"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import type { ReactNode } from "react";
import { appConfig } from "@/lib/config";

// Created once at module scope (not during render) — the client generates
// random ids, which Cache Components forbids inside a prerender.
const convex = appConfig.convexUrl ? new ConvexReactClient(appConfig.convexUrl) : null;

/**
 * Connects Convex to the auth provider. This and the sign-in/user-menu
 * components are the only places that know the provider is Clerk.
 */
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (!convex) return <>{children}</>;
  return (
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
