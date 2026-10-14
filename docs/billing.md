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
   | `PAYHERO_MODE` | `live`. Unset or anything else = **dry-run** (no real requests). |
   | `PAYHERO_AUTH_TOKEN` | The Basic authorization token from step 2. |
   | `PAYHERO_CHANNEL_ID` | The integer channel id from step 3. |
   | `PAYHERO_CALLBACK_BASE` | Your Convex **HTTP actions** URL, the `.convex.site` one (not `.convex.cloud`), e.g. `https://happy-otter-123.convex.site`. Must be `https`. |
   | `BILLING_ENFORCEMENT` | `on` when you want limits enforced. |
   | `APP_BASE_URL` | Public app URL, so reminder emails link to `/app/billing`. |
   | `BILLING_HASH_PEPPER` | Optional secret for hashing phone numbers; defaults to `PAYHERO_AUTH_TOKEN`. Do not change it after launch (it resets the per-number retry history). |
   | `ALLOW_BILLING_SIMULATION` | **Never set in production.** Dev only, see below. |

   With `PAYHERO_MODE=live` and any of the first four missing or malformed, checkout refuses with "Payments are not set up yet" and nothing is sent.
5. **Set prices** in `lib/billing/pricing.ts` and deploy.
6. Make sure notifications are configured (see `docs/setup.md`): receipts and reminders are sent through the notification system (email by default).

## Test it

1. **Dry-run first** (default; leave `PAYHERO_MODE` unset on a dev deployment). Checkout records a payment and shows the "Check your phone" screen, but nothing is sent. Settle it either from the CLI:
   `npx convex run billingPayhero:simulate '{"paymentId":"<id>","outcome":"success"}'`
   or, on a dev deployment only, set `ALLOW_BILLING_SIMULATION=true` and use the Simulate buttons on the billing page. Simulation refuses payments created by the live provider and refuses to run when `PAYHERO_MODE=live`.
2. **Then one real payment of KES 1 to 10.** Temporarily put a small price (for example 10) in `pricing.ts` on a staging deployment, switch to `PAYHERO_MODE=live`, and pay from `/app/billing` with your own number. Confirm: the STK prompt arrives; after the PIN the page flips to "Payment received" with the M-Pesa code; the subscription end date moved by 30 days; a receipt email arrived; the PayHero dashboard shows the transaction. Then test a cancelled prompt and a wrong PIN, and test with the callback blocked (see reconciliation) to see the cron settle it within about a minute.
3. Revert the test price before launch.

## Payment flow and security design

PayHero's callback carries **no signature or authentication**, so it cannot be trusted. The design treats it as a hint:

1. `billing.startCheckout` (an action) checks the caller's `billing:manage` permission and limits, takes the amount from `pricing.ts`, and creates a `billingPayments` row (`pending`) with a random 256-bit **callback token** (only its SHA-256 is stored). It then calls PayHero `POST /api/v2/payments` with `callback_url = PAYHERO_CALLBACK_BASE/webhooks/payhero/<token>` and our `external_reference`.
2. The **phone number is never stored**: it exists only in the action's memory. The row keeps its last four digits and an HMAC (used for per-number retry limits).
3. When PayHero calls the callback URL, the route (`convex/http.ts`) caps the body at 8 KB, rejects malformed tokens, finds the payment by token hash, ignores a callback naming a different `ExternalReference`, and then **asks PayHero itself** (`GET /api/v2/transaction-status?reference=<stored reference>`, server to server, with our credentials). It credits only if the API says `SUCCESS` and the returned reference, `CheckoutRequestID` and (if present) amount match what we stored. The plan and amount come from our row. Every well-formed request gets the same `200 {"ok":true}` whatever it matched, so the endpoint reveals nothing. Tokens, phone numbers and callback bodies are never logged.
4. Applying a payment is **idempotent**: a payment is credited once (`appliedAt`), so replays and duplicate callbacks change nothing. Status checks per payment are throttled (3 s) so a callback flood cannot hammer PayHero.
5. **Reconciliation cron** (`billing payment reconcile`, every minute): pending payments older than 30 s are checked with PayHero (so a lost callback still resolves); those still unanswered after 10 minutes are marked `timed_out`. Timed-out and cancelled payments are still re-checked for 24 hours, so a customer who paid late is credited rather than left out of pocket.
6. A verified success that does **not** match our record is not credited, marked `failed` (`verification_mismatch`) and written to the audit log for you to investigate in PayHero.

## Subscription arithmetic

- First payment, or the plan had ended, or it was in the grace period, or it was a trial: the new period starts **now**.
- Early renewal of the same plan: the new period starts at the **current end**, so days are never lost. Monthly -> annual works the same way.
- Upgrade (Business -> Enterprise) while running: Enterprise starts **now**; the unused remainder of the old plan is **not credited** (no proration; the billing page warns before paying).
- Downgrade (Enterprise -> Business) is refused while the higher plan is paid; it can be bought after the period ends.

## Abuse protection

PayHero blocks a phone for 24 h after more than 10 consecutive failed STK requests, and restricts the whole account for hours after more than 50 failures in 6 h. Our limits stay well below that (`PAYMENT_LIMITS` in `lib/billing/provider.ts`):

- 1 pending payment per organization; 30 s cooldown between attempts; 6 attempts per organization per hour.
- 3 attempts per phone number per hour (across organizations); a number with 5 failed/cancelled/timed-out attempts in a row within 24 h is blocked on our side until one succeeds or a day passes.
- If 40 or more attempts failed account-wide in 6 hours, new checkouts pause for everyone.

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
- Visits are metered but never blocked at the gate, whatever the plan.
