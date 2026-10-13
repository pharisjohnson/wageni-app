"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { FEATURE_LABELS, minTierFor, TIER_LABELS, tierHasFeature, type Feature } from "@/lib/billing/entitlements";
import { useActiveOrg } from "@/lib/org/active-org";

/** Plan facts for the active organization (undefined while loading). Server enforcement is authoritative. */
export function useEntitlements() {
  const { organizationId } = useActiveOrg();
  return useQuery(api.billing.entitlements, { organizationId });
}

/** Shown where a feature or limit is not part of the current plan. */
export function UpgradeNotice({ title, message }: { title?: string; message: string }) {
  const { can } = useActiveOrg();
  return (
    <div role="status" className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
      <Lock className="size-5 text-muted-foreground" aria-hidden />
      <p className="font-medium">{title ?? "Upgrade your plan"}</p>
      <p className="max-w-prose text-sm text-muted-foreground">{message}</p>
      {can("billing:manage") ? (
        <Link href="/app/billing" className={buttonVariants()}>
          View plans
        </Link>
      ) : (
        <p className="text-sm text-muted-foreground">Ask the organization owner to upgrade the plan.</p>
      )}
    </div>
  );
}

/** Renders children only when the plan includes `feature`; otherwise an upgrade prompt. */
export function FeatureGate({ feature, children }: { feature: Feature; children: ReactNode }) {
  const ent = useEntitlements();
  if (ent === undefined) return null;
  if (ent.enforced && !tierHasFeature(ent.tier, feature)) {
    return (
      <UpgradeNotice
        title={`${FEATURE_LABELS[feature]} is not in your plan`}
        message={`${FEATURE_LABELS[feature]} is available on ${TIER_LABELS[minTierFor(feature)]} and above.`}
      />
    );
  }
  return <>{children}</>;
}
