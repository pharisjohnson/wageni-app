"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { CheckCircle2, Loader2, Smartphone, XCircle } from "lucide-react";
import { useState } from "react";
import { toastError } from "@/components/billing/plan-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TIER_LABELS, TIER_RANK, type PaidPlanKey, type SubscriptionStatus } from "@/lib/billing/entitlements";
import { normalizeKenyanMobile } from "@/lib/billing/phone";
import { formatKes, priceFor, type BillingPeriod } from "@/lib/billing/pricing";
import { PERIOD_DAYS } from "@/lib/billing/subscription";
import { cn } from "@/lib/utils";

const date = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

const PLAN_BLURB: Record<PaidPlanKey, string> = {
  business: "Multiple sites and gates, custom forms, notifications, audit log.",
  enterprise: "Everything in Business, plus webhooks, custom retention and unlimited limits.",
};

const FAILURE_TEXT: Record<string, string> = {
  not_completed: "The payment was not completed (cancelled, wrong PIN or not enough balance). You were not charged.",
  timed_out: "We did not get a response in time. If money left your M-Pesa, it will be applied automatically within a day; otherwise you were not charged.",
  cancelled: "You stopped this payment. If you already entered your PIN it will still be applied once it is confirmed.",
  provider_unavailable: "The payment service is not reachable right now. You were not charged. Please try again in a few minutes.",
  rejected: "The payment service did not accept this request. You were not charged. Check the number and try again.",
  verification_mismatch: "We could not match this payment to your order, so it was not applied. Please contact support with the time and amount.",
};

type Sub = { planKey: PaidPlanKey | null; status: SubscriptionStatus | null; currentPeriodEnd: number | null };

export function CheckoutPanel({
  organizationId,
  subscription,
  simulationAllowed,
  paymentsMode,
}: {
  organizationId: Id<"organizations">;
  subscription: Sub;
  simulationAllowed: boolean;
  paymentsMode: "dry-run" | "live";
}) {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const [plan, setPlan] = useState<PaidPlanKey | null>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [paymentId, setPaymentId] = useState<Id<"billingPayments"> | null>(null);
  const startCheckout = useAction(api.billing.startCheckout);

  if (paymentId) {
    return (
      <PaymentWatcher
        organizationId={organizationId}
        paymentId={paymentId}
        simulationAllowed={simulationAllowed}
        onRetry={() => setPaymentId(null)}
        onDone={() => {
          setPaymentId(null);
          setPlan(null);
          setPhone("");
        }}
      />
    );
  }

  const parsed = normalizeKenyanMobile(phone);
  const amount = plan ? priceFor(plan, period) : null;
  const running = subscription.status === "active" && subscription.currentPeriodEnd !== null;
  const blockedDowngrade =
    plan !== null && running && subscription.planKey !== null && TIER_RANK[plan] < TIER_RANK[subscription.planKey];
  const isUpgrade =
    plan !== null && running && subscription.planKey !== null && TIER_RANK[plan] > TIER_RANK[subscription.planKey];

  async function pay() {
    if (!plan || !parsed) return;
    setBusy(true);
    try {
      const res = await startCheckout({ organizationId, planKey: plan, period, phone });
      setPaymentId(res.paymentId);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change or renew your plan</CardTitle>
        <CardDescription>
          Pay with M-Pesa (KES). You pay once for each period; it does not renew by itself, so you pay again when the
          period ends. Cards are not supported here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {paymentsMode === "dry-run" && (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" role="status">
            Test mode: no real M-Pesa request is sent.
          </p>
        )}
        <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label="Billing period">
          {(["monthly", "annual"] as const).map((p) => (
            <Button
              key={p}
              type="button"
              size="sm"
              variant={period === p ? "default" : "ghost"}
              aria-pressed={period === p}
              onClick={() => setPeriod(p)}
            >
              {p === "monthly" ? "Monthly" : "Annual"}
            </Button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {(["business", "enterprise"] as const).map((key) => {
            const price = priceFor(key, period);
            const current = subscription.planKey === key && running;
            return (
              <div key={key} className={cn("space-y-3 rounded-xl border p-4", plan === key && "ring-2 ring-primary")}>
                <div>
                  <p className="font-medium">{TIER_LABELS[key]}</p>
                  <p className="text-sm text-muted-foreground">{PLAN_BLURB[key]}</p>
                </div>
                <p className="text-lg font-semibold">
                  {price === null ? "KES price to be announced" : `${formatKes(price)} / ${period === "monthly" ? "month" : "year"}`}
                </p>
                <Button
                  type="button"
                  variant={plan === key ? "default" : "outline"}
                  disabled={price === null}
                  onClick={() => setPlan(key)}
                >
                  {price === null ? "Not available yet" : current ? "Renew" : `Choose ${TIER_LABELS[key]}`}
                </Button>
              </div>
            );
          })}
        </div>

        {plan && amount !== null && (
          <form
            className="space-y-4 rounded-xl border bg-muted/30 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void pay();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="mpesa-phone">M-Pesa phone number</Label>
              <Input
                id="mpesa-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="0712 345 678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                aria-invalid={phone.length > 0 && !parsed}
                maxLength={20}
              />
              <p className="text-xs text-muted-foreground">
                {phone.length > 0 && !parsed
                  ? "Enter a Safaricom number like 0712 345 678."
                  : "The prompt is sent to this number. Use the number of the person who will enter the PIN."}
              </p>
            </div>
            <div className="space-y-1 text-sm">
              <p>
                You will pay <strong>{formatKes(amount)}</strong> for <strong>{TIER_LABELS[plan]}</strong> (
                {period === "monthly" ? "monthly" : "annual"}, {PERIOD_DAYS[period]} days).
              </p>
              {running && !isUpgrade && !blockedDowngrade && subscription.currentPeriodEnd !== null && (
                <p className="text-muted-foreground">
                  Your current period ends on {date(subscription.currentPeriodEnd)}; the new period starts after it, so no days are lost.
                </p>
              )}
              {isUpgrade && (
                <p className="text-amber-700 dark:text-amber-400">
                  Upgrading starts {TIER_LABELS[plan]} immediately. Time left on your current plan is not credited.
                </p>
              )}
              {blockedDowngrade && subscription.planKey && subscription.currentPeriodEnd !== null && (
                <p className="text-destructive">
                  {TIER_LABELS[subscription.planKey]} is paid until {date(subscription.currentPeriodEnd)}. You can switch to {TIER_LABELS[plan]} after
                  that.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={!parsed || busy || blockedDowngrade}>
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Smartphone aria-hidden />}
                Pay {formatKes(amount)} with M-Pesa
              </Button>
              <Button type="button" variant="ghost" onClick={() => setPlan(null)}>
                Back
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function PaymentWatcher({
  organizationId,
  paymentId,
  simulationAllowed,
  onRetry,
  onDone,
}: {
  organizationId: Id<"organizations">;
  paymentId: Id<"billingPayments">;
  simulationAllowed: boolean;
  onRetry: () => void;
  onDone: () => void;
}) {
  const p = useQuery(api.billing.paymentStatus, { organizationId, paymentId });
  const cancel = useMutation(api.billing.cancelPayment);
  const simulate = useMutation(api.billing.simulatePayment);

  if (p === undefined) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-8" role="status">
          <Loader2 className="animate-spin" aria-hidden /> Starting your payment...
        </CardContent>
      </Card>
    );
  }

  if (p.status === "pending") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Loader2 className="size-5 animate-spin" aria-hidden /> Check your phone
          </CardTitle>
          <CardDescription role="status">
            Enter your M-Pesa PIN on the prompt sent to the number ending {p.phoneLast4} to pay {formatKes(p.amountKes)}. This page
            updates by itself.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => cancel({ organizationId, paymentId }).catch(toastError)}
          >
            Cancel
          </Button>
          {simulationAllowed && p.mode === "dry-run" && (
            <>
              <Button onClick={() => simulate({ organizationId, paymentId, outcome: "success" }).catch(toastError)}>
                Simulate success
              </Button>
              <Button variant="outline" onClick={() => simulate({ organizationId, paymentId, outcome: "failure" }).catch(toastError)}>
                Simulate failure
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  if (p.status === "success") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-primary" aria-hidden /> Payment received
          </CardTitle>
          <CardDescription role="status">
            {formatKes(p.amountKes)} for {TIER_LABELS[p.planKey]}.
            {p.mpesaReceipt ? ` M-Pesa code: ${p.mpesaReceipt}.` : ""} A receipt was sent to the billing managers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onDone}>Done</Button>
        </CardContent>
      </Card>
    );
  }

  const reason = FAILURE_TEXT[p.failureReason ?? p.status] ?? FAILURE_TEXT.not_completed;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <XCircle className="size-5 text-destructive" aria-hidden />
          {p.status === "timed_out" ? "Payment timed out" : p.status === "cancelled" ? "Payment stopped" : "Payment not completed"}
        </CardTitle>
        <CardDescription role="status">{reason}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button onClick={onRetry}>Try again</Button>
        <p className="w-full text-xs text-muted-foreground">
          To protect your account and your number, there is a short wait between attempts and a limit on attempts per hour.
        </p>
      </CardContent>
    </Card>
  );
}
