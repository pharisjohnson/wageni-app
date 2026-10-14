# Billing: plans, entitlements and PayHero M-Pesa (Phase 7)

Operator checklist. **No real PayHero account, STK push or payment has been used** to build or test this: the code was written from PayHero's published documentation (https://docs.payhero.co.ke) and covered by tests that mock `fetch`. Response fields beyond the documented ones are unverified. Work through "Go live" and "Test it" below before charging anyone.

Clerk Billing was evaluated and removed: it is USD/Stripe only, has no M-Pesa and fails 3D Secure payments. PayHero is now the single payment source.

## How it works

- Wageni tenants are Convex `organizations`. **A subscription belongs to the organization** (`subscriptions`, one row per organization). It is created or extended by a verified M-Pesa payment, by a free trial, or by a platform operator's manual grant.
- `convex/lib/entitlements.ts` resolves organization -> subscription -> tier on every restricted call (`requireFeature`, `requireWithinLimit`). Tiers, features and limits live in `lib/billing/entitlements.ts` and also feed the marketing copy and the billing page.
- **Enforcement is OFF by default.** Until `BILLING_ENFORCEMENT=on`, every organization has full Enterprise entitlements. Demo organizations (`isDemo`) always do.
- Access is **derived from time**, not from the cron: an active period grants its plan; after it ends the plan stays for a 7-day grace period (`past_due`); then the organization is on Starter. The lifecycle cron only tidies the stored status and sends reminders.
- Downgrades never delete data. Over-limit organizations keep what they have and cannot create more; extra sites are read-only.

## Tiers

| | Starter (`free`) | Business | Enterprise |
| --- | --- | --- | --- |
| Features | none | `multi_site`, `custom_forms`, `notifications`, `audit_log` | all six, adds `webhooks_integrations`, `custom_retention` |
| Sites | 1 | 10 | unlimited |
| Gates | 3 | 50 | unlimited |
| Staff (active members) | 10 | 200 | unlimited |
| Custom forms | 0 | 25 | unlimited |
| Visits per month | 200 (metered, never blocks a visitor) | 5,000 | unlimited |
| Live messages per month | 0 (dry-run only) | 2,000 | unlimited |

These numbers are product decisions in `TIER_LIMITS` (`lib/billing/entitlements.ts`).

## Prices and trial (you must set these)

Open `lib/billing/pricing.ts`:

```ts
export const PLAN_PRICES_KES = {
  business:   { monthly: null, annual: null },
  enterprise: { monthly: null, annual: null },
};
export const BUSINESS_TRIAL_DAYS: number | null = null;
```

- Prices are whole KES. **`null` means not set**: checkout for that plan and period is disabled and every page says "KES price to be announced". Nothing is invented.
- The amount charged is read from this file on the server when a payment is created and stored on the payment row. The browser and PayHero's callback never choose the amount.
- `BUSINESS_TRIAL_DAYS` (null = no trial): the organization owner (`billing:manage`) can start a Business trial without paying, **once per organization**. It is a `trialing` subscription row; it ends by itself (the cron marks it `ended`, and access stops at the trial end regardless) and the organization returns to Starter unless it pays.
- Period length is fixed: **monthly = 30 days, annual = 365 days**.

## Operator checklist: go live

1. **PayHero account.** Create one at https://payhero.co.ke and complete their onboarding.
2. **API credentials.** Dashboard -> **API Keys** -> Add new API Key. Copy the ready-made **Basic Authorization token** (with or without the `Basic ` prefix; both work).
3. **Payment channel.** Register your M-Pesa paybill or till as a payment channel in PayHero and note its numeric **channel id**.
4. **Convex environment variables** (Convex dashboard -> Settings -> Environment Variables, on the production deployment):

   | Variable | Value |
   | --- | --- |
   | `PAYHERO_MODE` | `live`. Unset or anything else = **dry-run** (no real requests). With `BILLING_ENFORCEMENT=on`, dry-run checkout is **refused** ("Payments are not set up yet") unless `ALLOW_DRY_RUN_BILLING=true`, so a production deployment that forgot this variable fails loudly instead of looking like it works. |
   | `PAYHERO_AUTH_TOKEN` | The Basic authorization token from step 2. |
   | `PAYHERO_CHANNEL_ID` | The integer channel id from step 3. |
   | `PAYHERO_CALLBACK_BASE` | Your Convex **HTTP actions** URL, the `.convex.site` one (not `.convex.cloud`), e.g. `https://happy-otter-123.convex.site`. Must be `https`. |
   | `BILLING_ENFORCEMENT` | `on` when you want limits enforced. |
   | `APP_BASE_URL` | Public app URL, so reminder emails link to `/app/billing`. |
   | `BILLING_HASH_PEPPER` | **Required in live mode**: a random secret of at least 16 characters (use 32+ bytes, e.g. `openssl rand -base64 32`) keying the phone-number hashes. Kenyan numbers are a small space, so the key is what stops anyone with database access from recovering numbers by enumeration. No fallback. Changing it later only resets the per-number retry history (24 h). |
   | `ALLOW_DRY_RUN_BILLING` | **Never set in production.** Dev only: lets dry-run checkout run while `BILLING_ENFORCEMENT=on`. |
   | `ALLOW_BILLING_SIMULATION` | **Never set in production.** Dev only, see below. |

   With `PAYHERO_MODE=live` and any of the first four, or `BILLING_HASH_PEPPER`, missing or malformed, checkout refuses with "Payments are not set up yet" and nothing is sent.
5. **Set prices** in `lib/billing/pricing.ts` and deploy.
6. Make sure notifications are configured (see `docs/setup.md`): receipts and reminders are sent through the notification system (email by default).

## Test it

1. **Dry-run first** (default; leave `PAYHERO_MODE` unset on a dev deployment). Checkout records a payment and shows the "Check your phone" screen, but nothing is sent. Settle it either from the CLI:
   `npx convex run billingPayhero:simulate '{"paymentId":"<id>","outcome":"success"}'`
   or, on a dev deployment only, set `ALLOW_BILLING_SIMULATION=true` and use the Simulate buttons on the billing page. Simulation refuses payments created by the live provider and refuses to run when `PAYHERO_MODE=live`.
2. **Then one real payment of KES 1 to 10.** Temporarily put a small price (for example 10) in `pricing.ts` on a staging deployment, switch to `PAYHERO_MODE=live`, and pay from `/app/billing` with your own number. Confirm: the STK prompt arrives; after the PIN the page flips to "Payment received" with the M-Pesa code; the subscription end date moved by 30 days; a receipt email arrived; the PayHero dashboard shows the transaction. Then test a cancelled prompt and a wrong PIN, and test with the callback blocked (see reconciliation) to see the cron settle it within about a minute.
3. Revert the test price before launch.

### Live sandbox test script (run before charging real customers)

PayHero has no separate sandbox for M-Pesa, so this runs on a **staging** Convex deployment (or production before announcing) with live credentials and a temporary KES 1 to 10 price in `lib/billing/pricing.ts`. Use your own Safaricom number and keep the PayHero dashboard open. Stay under the limits: at most 3 attempts per number per hour and one pending payment at a time (wait 30 s between attempts). Tick each box.

Setup: `PAYHERO_MODE=live`, `PAYHERO_AUTH_TOKEN`, `PAYHERO_CHANNEL_ID`, `PAYHERO_CALLBACK_BASE`, `BILLING_HASH_PEPPER` (16+ chars), `BILLING_ENFORCEMENT=on`; `ALLOW_DRY_RUN_BILLING` and `ALLOW_BILLING_SIMULATION` unset. `/platform/usage` shows no red billing warning. Create a test organization and sign in as its owner.

1. [ ] **Happy path.** `/app/billing` -> pick Business monthly -> enter your number -> Pay. Expect: STK prompt within seconds; enter the PIN; the page flips to "Payment received" with a 10-character M-Pesa code; plan end date = now + 30 days; one receipt message; the PayHero dashboard shows the transaction with the same reference. In the Convex dashboard the `billingPayments` row has `status: success`, `payheroReference`, `mpesaReceipt` and **no full phone number** (only `phoneLast4`).
2. [ ] **Cancelled STK.** Start a payment and dismiss the prompt on the phone (or ignore it). Expect: the page keeps waiting, then after at most about 10 minutes (or via "Cancel") shows a not-completed state; no plan change. Wait 30 s before retrying.
3. [ ] **Wrong PIN.** Start a payment and enter a wrong PIN. Expect: a failed state with a friendly message; no plan change; the attempt counts toward the per-number limits (3 per hour, block after 5 failures in a row).
4. [ ] **Callback replay.** After step 1, POST the callback again three times to `<PAYHERO_CALLBACK_BASE>/webhooks/payhero/<token>` (take the token from the PayHero dashboard's callback log; once with a body claiming `Amount: 1`, once with garbage JSON). Expect: `200 {"ok":true}` (400 for garbage); the subscription end date and the receipt count **do not change**; exactly one `billing.payment_applied` audit row exists.
5. [ ] **Forged callback.** While a prompt is unanswered, POST a "success" body to that payment's callback URL. Expect: nothing is credited (PayHero still says queued).
6. [ ] **Lost callback.** Make the callback unreachable (temporarily set `PAYHERO_CALLBACK_BASE` to a wrong https host such as `https://example.invalid`; restore it afterwards) and pay with the PIN. Expect: no instant flip, but within about a minute the reconcile cron settles it as success with the right receipt.
7. [ ] **Late payment.** Start a payment, let it time out (10 minutes) or Cancel it, then complete the still-open prompt if possible. Expect: the next reconcile cycle credits it (late successes are honoured for 24 hours).
8. [ ] **Status API reality check.** For the step 1 payment, look at PayHero's `transaction-status` answer (`curl` with your token). Note the field names for the M-Pesa code, amount, `reference` and `CheckoutRequestID`. If the code or amount use other names, receipts show PayHero's reference instead; crediting is unaffected. If `reference` is the M-Pesa code, confirm the payment still credited (the `CheckoutRequestID` must match).
9. [ ] **Cleanup.** Restore the real prices and `PAYHERO_CALLBACK_BASE`; refund test payments in PayHero if wanted (manual). Confirm `/platform/usage` shows no billing warning.

## Payment flow and security design

PayHero's callback carries **no signature or authentication**, so it cannot be trusted. The design treats it as a hint:

1. `billing.startCheckout` (an action) checks the caller's `billing:manage` permission and limits, takes the amount from `pricing.ts`, and creates a `billingPayments` row (`pending`) with a random 256-bit **callback token** (only its SHA-256 is stored). It then calls PayHero `POST /api/v2/payments` with `callback_url = PAYHERO_CALLBACK_BASE/webhooks/payhero/<token>` and our `external_reference`.
2. The **phone number is never stored**: it exists only in the action's memory. The row keeps its last four digits and an HMAC (used for per-number retry limits).
3. When PayHero calls the callback URL, the route (`convex/http.ts`) caps the body at 8 KB, rejects malformed tokens, finds the payment by token hash, ignores a callback naming a different `ExternalReference`, and then **asks PayHero itself** (`GET /api/v2/transaction-status?reference=<stored reference>`, server to server, with our credentials). It credits only if the API says `SUCCESS` and the returned reference, `CheckoutRequestID` and (if present) amount match what we stored. The plan and amount come from our row. Every well-formed request gets the same `200 {"ok":true}` whatever it matched, so the endpoint reveals nothing. Tokens, phone numbers and callback bodies are never logged.
4. Applying a payment is **idempotent**: a payment is credited once (`appliedAt`), so replays and duplicate callbacks change nothing. Status checks per payment are throttled (3 s) so a callback flood cannot hammer PayHero.
5. **Reconciliation cron** (`billing payment reconcile`, every minute): pending payments older than 30 s are checked with PayHero (so a lost callback still resolves); those still unanswered after 10 minutes are marked `timed_out`. Timed-out and cancelled payments are still re-checked for 24 hours, so a customer who paid late is credited rather than left out of pocket.
6. One real transaction can credit **one payment only**: a PayHero reference or an M-Pesa receipt already belonging to another payment is never credited again (audited as a mismatch), and a reference PayHero hands out twice is rejected at checkout (`reference_reused`). The receipt shown from the (untrusted) callback body is dropped if another payment already owns it. If PayHero reports the M-Pesa code as `reference`, the answer is accepted only when its `CheckoutRequestID` equals the one stored for the payment; a `FAILED` answer about a different reference is ignored.
7. Production safety: with `BILLING_ENFORCEMENT=on`, dry-run checkout is refused unless `ALLOW_DRY_RUN_BILLING=true`; live mode refuses to run without `BILLING_HASH_PEPPER`. `/platform/usage` shows a red banner for unsafe combinations (enforcement on with dry-run, simulation switch on, missing live variables).
8. A verified success that does **not** match our record is not credited, marked `failed` (`verification_mismatch`) and written to the audit log for you to investigate in PayHero.

## Subscription arithmetic

- First payment, or the plan had ended, or it was in the grace period, or it was a trial: the new period starts **now**.
- Early renewal of the same plan: the new period starts at the **current end**, so days are never lost. Monthly -> annual works the same way.
- Upgrade (Business -> Enterprise) while running: Enterprise starts **now**; the unused remainder of the old plan is **not credited** (no proration; the billing page warns before paying).
- Downgrade (Enterprise -> Business) is refused while the higher plan is paid; it can be bought after the period ends.

## Abuse protection

PayHero blocks a phone for 24 h after more than 10 consecutive failed STK requests, and restricts the whole account for hours after more than 50 failures in 6 h. Our limits stay well below that (`PAYMENT_LIMITS` in `lib/billing/provider.ts`):

- 1 pending payment per organization; 30 s cooldown between attempts; 6 attempts per organization per hour.
- 3 attempts per phone number per hour (across organizations); a number with 5 failed/cancelled/timed-out attempts in a row within 24 h is blocked on our side until one succeeds or a day passes.
- If 40 or more attempts failed account-wide in 6 hours, new checkouts pause. Each organization counts for **at most 3** of those, so one tenant cannot pause everyone alone (it takes failures spread over about 14 organizations), and an organization that already pays us (active payment subscription) is never paused, so renewals keep working during an incident. Anyone can still create many organizations: if payments pause, check `/platform/usage` and PayHero's dashboard.

The UI shows friendly messages for each.

## Lifecycle and notifications

- Renewal reminders go to everyone who can manage billing (owners by default) **7, 3 and 1 days** before the period ends (only the tightest threshold reached is sent), with a link to `/app/billing` and a note that M-Pesa must be paid again (no auto-renew).
- When a period ends: status `past_due` and a notice with the grace end date; after 7 days: `ended` and the organization is on Starter. Nothing is deleted.
- Each successful payment sends a receipt (amount, M-Pesa code, new end date).
- Manual grants get no reminders.
- Crons: `billing payment reconcile` (1 min), `billing subscription lifecycle` (30 min).

## Manual and invoiced customers

A platform administrator can give an organization a plan until a date without payment: `/platform/usage` -> **Grant plan** (`platform.grantPlan({ organizationId, planKey, until, reason })`). It replaces the organization's current subscription row, requires a reason and is audit-logged. After the date the usual 7-day grace applies, then Starter.

## Known limits (read before launch)

- **KES only.** M-Pesa STK push only; **cards and other methods are not covered** by this integration.
- **No automatic recurring M-Pesa.** PayHero offers no subscription or auto-debit product; every period is a new payment and customers are reminded.
- **No tax invoicing from this system.** Receipts here are payment confirmations, not tax invoices. **Check your KRA / eTIMS (and VAT) obligations with an accountant** before charging customers.
- **Refunds are done in PayHero**, manually; this system does not reverse a subscription when you refund (end it with a manual grant or contact engineering).
- PayHero's status response is documented without an amount or M-Pesa code field; the code reads `provider_reference` for the code and an `amount` field if present, and shows the code only if it looks like an M-Pesa code (10 uppercase letters/digits). If PayHero returns these under other names, receipts show PayHero's reference instead; credit decisions are unaffected.
- Not verified against a live account: request/response field names beyond those in PayHero's docs, behavior when the status API is queried before the transaction is registered (treated as "unknown" and retried), PayHero's retry behavior for callbacks.
- **Lost payment if PayHero times out while accepting the STK push.** If our request times out or errors after PayHero actually sent the prompt, we have no reference to check: the payment is recorded as failed and a customer who pays anyway is not credited automatically. Look in PayHero's dashboard for transactions without a matching `billingPayments.payheroReference` and use **Grant plan** (reason: the M-Pesa code).
- **The phone number is not verified against PayHero's answer** (the documented status response does not return it). Anyone with `billing:manage` can send an STK prompt to any Safaricom number; per-number limits (3 per hour, 5 failures in a row) bound the nuisance but cannot stop it.
- **The amount is checked only when PayHero reports one** (a number or numeric string). The payment is bound to our own reference, whose amount we set when creating it.
- Free trials are once per organization, not per person: someone can create more organizations. Set `BUSINESS_TRIAL_DAYS` only if that is acceptable.
- Visits are metered but never blocked at the gate, whatever the plan.
