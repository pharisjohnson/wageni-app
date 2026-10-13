"use client";

import { PricingTable, useClerk } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import {
  FEATURE_LABELS,
  FEATURES,
  LIMIT_LABELS,
  TIER_LABELS,
  type Limit,
} from "@/lib/billing/entitlements";
import { useActiveOrg } from "@/lib/org/active-org";

const date = (ms: number | null) =>
  ms === null ? null : new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function Meter({ label, used, limit, format = String }: { label: string; used: number; limit: Limit; format?: (n: number) => string }) {
  const pct = limit === null ? 0 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  const over = limit !== null && used > limit;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {format(used)} of {limit === null ? "unlimited" : format(limit)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit ?? undefined}
        aria-valuenow={used}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full ${over || pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary"}`}
          style={{ width: `${limit === null ? 0 : pct}%` }}
        />
      </div>
      {over && (
        <p className="text-xs text-muted-foreground">
          Over the limit. Existing records are kept; you cannot add more until you upgrade or remove some.
        </p>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  active: "Active",
  trialing: "Free trial",
  past_due: "Payment overdue",
  canceled: "Canceled",
  ended: "Ended",
};

function Note({ children }: { children: ReactNode }) {
  return <li className="text-sm text-muted-foreground">{children}</li>;
}

export default function BillingPage() {
  const { organizationId, can } = useActiveOrg();
  const { openUserProfile } = useClerk();
  const allowed = can("billing:manage");
  const data = useQuery(api.billing.overview, allowed ? { organizationId } : "skip");

  if (!allowed) return <p className="text-muted-foreground">You do not have access to billing.</p>;
  if (data === undefined) return <Skeleton className="h-96 w-full" aria-label="Loading billing" />;

  const { subscription: sub } = data;
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" description="Your organization's plan, limits and usage." />

      {!data.enforced && (
        <p className="rounded-xl border bg-muted/40 p-4 text-sm" role="status">
          {data.bypassReason === "demo"
            ? "This is a demo organization: every feature is unlocked and plan limits do not apply."
            : "Plan limits are not switched on for this deployment yet, so every feature is unlocked. Plans below take effect once billing enforcement is enabled."}
        </p>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Current plan: {TIER_LABELS[data.tier]}</CardTitle>
            {sub.status && (
              <Badge variant={sub.status === "past_due" ? "destructive" : "secondary"}>{STATUS_TEXT[sub.status]}</Badge>
            )}
          </div>
          <CardDescription>
            {sub.isFreeTrial && sub.trialEndsAt
              ? `Your free trial ends on ${date(sub.trialEndsAt)}. After that the plan is charged to the card on file, or you return to Starter if there is none.`
              : sub.status === "canceled" && sub.accessEndsAt
                ? `Canceled. You keep this plan until ${date(sub.accessEndsAt)}, then move to Starter. Your data is never deleted.`
                : sub.status === "past_due" && sub.accessEndsAt
                  ? `The last payment failed. Update your card by ${date(sub.accessEndsAt)} to keep this plan; otherwise you move to Starter. Your data is never deleted.`
                  : sub.currentPeriodEnd
                    ? `Current period ends ${date(sub.currentPeriodEnd)}.`
                    : data.tier === "free"
                      ? "The free Starter plan."
                      : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Meter label={LIMIT_LABELS.sites} used={data.usage.sites} limit={data.limits.sites} />
            <Meter label={LIMIT_LABELS.gates} used={data.usage.gates} limit={data.limits.gates} />
            <Meter label={LIMIT_LABELS.staff} used={data.usage.staff} limit={data.limits.staff} />
            <Meter label={LIMIT_LABELS.forms} used={data.usage.forms} limit={data.limits.forms} />
            <Meter label={LIMIT_LABELS.visitsPerMonth} used={data.usage.visitsPerMonth} limit={data.limits.visitsPerMonth} />
            <Meter
              label={LIMIT_LABELS.notificationsPerMonth}
              used={data.usage.notificationsPerMonth}
              limit={data.limits.notificationsPerMonth}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Monthly figures are for {data.month} (UTC). Files uploaded this month: {data.filesThisMonth} ({mb(data.fileBytesThisMonth)}).
            Visits are counted but never blocked at the gate.
          </p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <li key={f} className="text-sm">
                <span aria-hidden>{data.features.includes(f) ? "✓" : "–"}</span>{" "}
                <span className={data.features.includes(f) ? "" : "text-muted-foreground"}>
                  {FEATURE_LABELS[f]}
                  {data.features.includes(f) ? "" : " (not in your plan)"}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {data.isSubscriptionHolder || !data.enforced ? (
        <Card>
          <CardHeader>
            <CardTitle>Change plan</CardTitle>
            <CardDescription>
              Plans are tied to your own account and apply to every organization you own. Checkout opens in this page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <PricingTable for="user" />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => openUserProfile()}>
                Open my account (payment methods and invoices)
              </Button>
              <span className="text-xs text-muted-foreground">Look for the Billing tab once billing is enabled.</span>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Who manages the plan</CardTitle>
            <CardDescription>
              This organization&apos;s plan belongs to its owner&apos;s account
              {data.ownerName ? ` (${data.ownerName})` : ""}. Only the owner can upgrade, downgrade or update the
              payment method, from their own Billing page.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Good to know</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5">
            <Note>Prices and payments are in US dollars (USD) only.</Note>
            <Note>Payment is by credit or debit card, processed by Stripe. M-Pesa and other local methods are not available.</Note>
            <Note>
              Cards that require extra verification (3D Secure) may be declined. If a payment fails, try another card or
              contact us.
            </Note>
            <Note>Tax or VAT is not added at checkout, and refunds are handled by contacting us.</Note>
            <Note>Downgrading never deletes your data. Anything over the new limits stays viewable; you just cannot add more.</Note>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
