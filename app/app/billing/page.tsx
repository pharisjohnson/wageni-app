"use client";

import { useMutation, useQuery } from "convex/react";
import type { ReactNode } from "react";
import { CheckoutPanel } from "@/components/billing/checkout";
import { toastError } from "@/components/billing/plan-toast";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/convex/_generated/api";
import {
  FEATURE_LABELS,
  FEATURES,
  LIMIT_LABELS,
  TIER_LABELS,
  type Limit,
} from "@/lib/billing/entitlements";
import { formatKes } from "@/lib/billing/pricing";
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
  past_due: "Renewal overdue",
  canceled: "Canceled",
  ended: "Ended",
};

const PAYMENT_STATUS_TEXT: Record<string, string> = {
  pending: "Waiting",
  success: "Paid",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
};

function Note({ children }: { children: ReactNode }) {
  return <li className="text-sm text-muted-foreground">{children}</li>;
}

export default function BillingPage() {
  const { organizationId, can } = useActiveOrg();
  const startTrial = useMutation(api.billing.startTrial);
  const allowed = can("billing:manage");
  const data = useQuery(api.billing.overview, allowed ? { organizationId } : "skip");

  if (!allowed) return <p className="text-muted-foreground">You do not have access to billing.</p>;
  if (data === undefined) return <Skeleton className="h-96 w-full" aria-label="Loading billing" />;

  const { subscription: sub } = data;
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        description="Your organization's plan, limits and usage."
        back={{ href: "/app", label: "Back to dashboard" }}
      />

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
              ? `Your free trial ends on ${date(sub.trialEndsAt)}. After that you return to Starter unless you pay.`
              : sub.status === "past_due" && sub.accessEndsAt
                ? `Your plan period ended. You keep it until ${date(sub.accessEndsAt)}; pay again before then or you move to Starter. Your data is never deleted.`
                : sub.status === "active" && sub.currentPeriodEnd
                  ? `${sub.source === "manual" ? "Plan granted until" : "Paid until"} ${date(sub.currentPeriodEnd)}. M-Pesa does not renew automatically: pay again before then.`
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

      {data.trial.available && (
        <Card>
          <CardHeader>
            <CardTitle>Start your free trial</CardTitle>
            <CardDescription>
              Try Business free for {data.trial.days} days, no payment needed. It ends by itself and you return to Starter unless
              you pay. One trial per organization.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => startTrial({ organizationId }).catch(toastError)}>Start {data.trial.days}-day trial</Button>
          </CardContent>
        </Card>
      )}

      <CheckoutPanel
        organizationId={organizationId}
        subscription={{
          planKey: sub.planKey,
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd,
        }}
        simulationAllowed={data.payments.simulationAllowed}
        paymentsMode={data.payments.mode}
      />

      <Card>
        <CardHeader>
          <CardTitle>Payment history</CardTitle>
          <CardDescription>Your last payments with their M-Pesa receipt numbers.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.recentPayments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>M-Pesa code</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentPayments.map((p) => (
                    <TableRow key={p._id}>
                      <TableCell>{date(p.createdAt)}</TableCell>
                      <TableCell>
                        {TIER_LABELS[p.planKey]} ({p.period})
                      </TableCell>
                      <TableCell>{formatKes(p.amountKes)}</TableCell>
                      <TableCell>
                        <Badge variant={p.status === "success" ? "secondary" : p.status === "pending" ? "outline" : "destructive"}>
                          {PAYMENT_STATUS_TEXT[p.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono">{p.mpesaReceipt ?? "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Good to know</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5">
            <Note>Prices and payments are in Kenyan shillings (KES), paid with M-Pesa through PayHero.</Note>
            <Note>
              Each payment covers one period (30 days monthly, 365 days annual). There is no automatic renewal: you get
              reminders 7, 3 and 1 days before the period ends. Paying early adds to the end of your current period.
            </Note>
            <Note>Cards and other payment methods are not supported here. Contact us for invoiced or Enterprise arrangements.</Note>
            <Note>
              This page is not a tax invoice. Your M-Pesa confirmation message and the receipt code above are your proof of payment.
              Refunds are handled by contacting us.
            </Note>
            <Note>Downgrading never deletes your data. Anything over the new limits stays viewable; you just cannot add more.</Note>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
