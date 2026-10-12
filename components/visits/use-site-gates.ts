"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useActiveOrg } from "@/lib/org/active-org";

/** Site selection plus that site's active gates, for check-in/out and booking forms. */
export function useSiteGates() {
  const { organizationId, can } = useActiveOrg();
  const sites = useQuery(api.sites.list, can("sites:read") ? { organizationId } : "skip");
  const [chosen, setChosen] = useState<Id<"sites"> | null>(null);
  const siteId = chosen ?? sites?.find((s) => s.status === "active")?._id ?? null;
  const gates = useQuery(
    api.gates.listBySite,
    siteId && can("sites:read") ? { organizationId, siteId } : "skip",
  );
  return {
    sites,
    siteId,
    setSiteId: setChosen,
    gates: gates?.filter((g) => g.status === "active"),
  };
}
