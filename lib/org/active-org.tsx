"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { FullPageSpinner } from "@/components/layout/full-page-spinner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import type { Permission } from "@/lib/permissions";

type OrgDetails = FunctionReturnType<typeof api.organizations.get>;
type OrgSummary = FunctionReturnType<typeof api.organizations.mine>[number];

type ActiveOrgValue = {
  org: OrgDetails;
  organizationId: Id<"organizations">;
  organizations: OrgSummary[];
  can: (permission: Permission) => boolean;
  switchTo: (id: Id<"organizations">) => void;
};

const ActiveOrgContext = createContext<ActiveOrgValue | null>(null);

// Only the organization id is remembered (not sensitive). The backend
// re-verifies membership on every request regardless of what is stored here.
const STORAGE_KEY = "wageni.activeOrganizationId";

function readStored(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function rememberActiveOrganization(id: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage unavailable (private mode etc.): selection lasts for this tab only.
  }
}

export function ActiveOrgProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const organizations = useQuery(api.organizations.mine);
  // Rendered only client-side (behind AuthGate), so storage is available here.
  const [selected, setSelected] = useState<string | null>(readStored);

  const organizationId = useMemo(() => {
    if (!organizations || organizations.length === 0) return null;
    const match = organizations.find((o) => o.organizationId === selected);
    return (match ?? organizations[0]!).organizationId;
  }, [organizations, selected]);

  useEffect(() => {
    if (organizations && organizations.length === 0) router.replace("/onboarding");
  }, [organizations, router]);

  const org = useQuery(api.organizations.get, organizationId ? { organizationId } : "skip");

  const switchTo = useCallback((id: Id<"organizations">) => {
    rememberActiveOrganization(id);
    setSelected(id);
  }, []);

  const value = useMemo<ActiveOrgValue | null>(() => {
    if (!org || !organizationId || !organizations) return null;
    const perms = new Set(org.membership.permissions);
    return { org, organizationId, organizations, can: (p) => perms.has(p), switchTo };
  }, [org, organizationId, organizations, switchTo]);

  if (!value) return <FullPageSpinner />;
  return <ActiveOrgContext.Provider value={value}>{children}</ActiveOrgContext.Provider>;
}

export function useActiveOrg() {
  const ctx = useContext(ActiveOrgContext);
  if (!ctx) throw new Error("useActiveOrg must be used inside ActiveOrgProvider");
  return ctx;
}
