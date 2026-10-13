# Billing: plans, entitlements and Clerk Billing (Phase 7)

Operator checklist. Nothing here has been exercised against a real Clerk or Stripe account: code and tests were written from Clerk's published docs and the `@clerk/backend` TypeScript types, then covered by `convex-test` with locally generated Svix signatures. Follow the verification section at the end before charging anyone.

## How it works

- Wageni tenants are Convex `organizations` + `memberships`, **not** Clerk Organizations. Billing therefore uses **Clerk Billing for users**: the subscription belongs to the Clerk user who **owns** the Wageni organization (the earliest active `owner` membership). An organization's plan is its owner's active subscription; one owner subscription covers every organization they own.
- Clerk sends `subscriptionItem.*` webhooks to Convex (`POST <convex site url>/webhooks/clerk-billing`). They are stored in the `subscriptions` table (one row per Clerk subscription item, Clerk user id and plan facts only, no names or emails).
- `convex/lib/entitlements.ts` resolves owner -> subscription -> tier on every restricted call. The tier tables (features, numeric limits, slug mapping) live in `lib/billing/entitlements.ts` and feed the marketing copy (`lib/plans.ts`), the billing page and enforcement.
- **Enforcement is OFF by default.** Until `BILLING_ENFORCEMENT=on`, every organization has full Enterprise entitlements. Demo organizations (`isDemo`) always do.

## Tiers

| | Starter (`free`) | Business | Enterprise |
| --- | --- | --- | --- |
| Clerk plan slug | none / default free plan | `business` | `enterprise` |
| Features | none | `multi_site`, `custom_forms`, `notifications`, `audit_log` | all six, adds `webhooks_integrations`, `custom_retention` |
| Sites | 1 | 10 | unlimited |
| Gates | 3 | 50 | unlimited |
| Staff (active members) | 10 | 200 | unlimited |
| Custom forms | 0 | 25 | unlimited |
| Visits / month | 200 (metered, never blocks a check-in) | 5000 (same) | unlimited |
| Live messages / month | 0 (dry-run only) | 2000 | unlimited |

These numbers are product decisions: edit `TIER_LIMITS` in `lib/billing/entitlements.ts`. Nothing else needs to change.

Downgrade rules: canceled plans last until the paid period ends; past-due plans keep access for **7 days** (`PAST_DUE_GRACE_MS`) after Clerk reports `past_due_at`; ended plans drop to Starter at once. Downgrades never delete data. Over-limit organizations keep everything readable; they cannot create more, extra sites (beyond the oldest N active) and their gates become read-only (deactivating them is allowed), existing published forms keep being served, and nobody is ever refused at the gate because of billing.

## Operator checklist (Clerk Dashboard)

Do the development instance first, then repeat on production.

1. **Enable Billing for users.** Dashboard -> Configure -> Billing -> Settings, or `npx clerk@latest enable billing --for users` (the `--for users` flag is from Clerk's overview page; confirm it with `npx clerk@latest enable billing --help`).
2. **Create the features** (Billing -> Plans for Users -> Features). Use these exact slugs (the slug is derived from the name; check it in the feature's detail, change it if needed):
   `multi_site`, `custom_forms`, `notifications`, `audit_log`, `webhooks_integrations`, `custom_retention`.
3. **Create the plans** (Plans for Users -> Add Plan):
   - `business`: publicly available; features `multi_site`, `custom_forms`, `notifications`, `audit_log`; set the USD price (monthly, optionally annual).
   - `enterprise`: **not publicly available** (sales-assisted: assign it to the customer from the dashboard); all six features. Webhooks never include a plan's feature list in Clerk's typed payload, so the plan **slug** (`business` / `enterprise`) is what Wageni maps. If you name plans differently, edit `PLAN_SLUG_TIER` in `lib/billing/entitlements.ts`.
   - Starter needs no paid plan: leave the Clerk default free plan (slug `free_user`) or none at all; no row means Starter.
4. **Free trial for Business**: Business plan -> enable free trial -> set days (1 to 365). Decide whether a payment method is required to start a trial (Billing Settings; Clerk's default is that one **is** required; turning it off means trials end silently on Starter). A user gets one trial per application and needs a verified primary email. Optionally set `BUSINESS_TRIAL_DAYS` in `lib/plans.ts` so marketing copy shows the number; it is display-only.
5. **Stripe**: development instances use Clerk's shared Stripe sandbox. For production connect your own Stripe account (Billing -> Settings). Dev and prod Stripe accounts are separate; a development Stripe account cannot be used in production.
6. **Webhook endpoint** (Webhooks -> Add Endpoint):
   - URL: `https://<your-deployment>.convex.site/webhooks/clerk-billing` (the Convex **site** URL, not `.convex.cloud`).
   - Subscribe to: `subscriptionItem.created` (if offered), `subscriptionItem.active`, `subscriptionItem.updated`, `subscriptionItem.canceled`, `subscriptionItem.upcoming`, `subscriptionItem.ended`, `subscriptionItem.abandoned`, `subscriptionItem.incomplete`, `subscriptionItem.pastDue`, `subscriptionItem.freeTrialEnding`. Other families (`subscription.*`, `paymentAttempt.*`) are acknowledged and ignored, so subscribing is harmless but unnecessary.
   - Copy the **Signing Secret** (`whsec_...`).
7. **Convex dashboard -> Settings -> Environment Variables** (per deployment): `CLERK_WEBHOOK_SECRET=<signing secret>`; when ready to charge, `BILLING_ENFORCEMENT=on`. Unset `CLERK_WEBHOOK_SECRET` and the webhook route returns 404.
8. **Existing customers**: before turning enforcement on, give every owner who should keep paid features a subscription (or put demo organizations on `isDemo`). Owners without one become Starter: extra sites become read-only, notifications become dry-run, forms/audit are blocked. Check `/platform/usage` first; it shows each organization's resolved plan.

## Testing

- Development instance: sign in, open `/app/billing`, pick Business in the pricing table, pay with Stripe test card `4242 4242 4242 4242` (any future date, any CVC). The Clerk development gateway needs no Stripe account. Test failure paths with Stripe's decline cards from <https://docs.stripe.com/testing>.
- Watch the Clerk Dashboard -> Webhooks -> endpoint -> Message attempts (200 = applied or acknowledged; 401 = signature/timestamp problem; 404 = `CLERK_WEBHOOK_SECRET` not set in Convex). Use "Replay"/"Resend" to exercise idempotency: a repeated `svix-id` is a no-op.
- Locally you can sign a request yourself with `signSvix` from `lib/billing/svix.ts` (see `tests/convex/billing.test.ts`).
- With `BILLING_ENFORCEMENT=on`, an owner on Starter should see "Upgrade" prompts: second site, custom forms, audit log, custom retention; messages stay dry-run.

## Known limits (tell customers)

- **3D Secure / SCA payments fail (launch risk).** Clerk Billing "does not currently support payment methods that require additional authentication, such as 3D Secure". Many Kenyan and other cards require it, and their issuers will decline the checkout. Until Clerk supports it, plan on invoicing such customers by hand (assign the plan from the Clerk Dashboard) or reconsider the provider before launch. Test with real local cards in production before announcing.
- USD only. No M-Pesa or other local methods; cards via Stripe only.
- No tax or VAT calculation. No refunds in Clerk Billing (refund in Stripe directly; it will not update the Clerk subscription).
- Clerk is **not** the Merchant of Record: you are responsible for tax registration and invoicing law.
- Checkout is web only. Not available in Brazil, India, Malaysia, Mexico, Singapore, Thailand.
- Plans and subscriptions created in Clerk do not sync to Stripe's own catalogue.
- Clerk's billing APIs are labelled beta/experimental; pin `@clerk/nextjs` and review changelogs before upgrading.

## Webhook handling reference

Verified against `@clerk/backend` 3.23 types (`BillingSubscriptionItemWebhookEventJSON`) and Clerk's docs; **not** against live deliveries.

- Envelope: `type`, `object: "event"`, `timestamp` (ms), `data`.
- Fields used from `data`: `id` (subscription item id), `status` (`active`, `canceled`, `ended`, `expired`, `past_due`, `upcoming`, `abandoned`, `incomplete`), `period_end`, `canceled_at`, `past_due_at`, `plan.slug`, `payer.user_id`, and `is_free_trial` (documented by Clerk for `subscriptionItem.active`; absent from the SDK type, so read defensively).
- Mapping: `active` -> `active` (or `trialing` when `is_free_trial`), `past_due` -> `past_due`, `canceled` -> `canceled`, `ended`/`expired` -> `ended`; `upcoming`/`abandoned`/`incomplete` create no entitlement (an existing row is set to `ended`). Organization payers (no `payer.user_id`) are ignored.
- Verification: Svix scheme (`svix-id`, `svix-timestamp`, `svix-signature` `v1,<base64>`; HMAC-SHA256 over `id.timestamp.body` with the base64-decoded secret after `whsec_`), constant-time compare, 5 minute replay window, 256 KB body cap, generic 4xx responses. Idempotent on `svix-id` (kept 7 days, swept daily). An event older than the stored row's last event timestamp is ignored.
- The Clerk user id is matched to the Convex user via `users.tokenIdentifier` (`<issuer>|<clerk user id>`).

## Usage metering

`usageCounters` holds per organization, per UTC month: `visits`, `notifications` (live sends), `files`, `fileBytes` (uploaded). They are incremented in the mutation paths (`convex/lib/usage.ts`), never by scanning. `/app/billing` shows them against limits; `/platform/usage` shows all organizations (platform admins only, counts and plan names only).

## Verify before launch

1. Real test-mode checkout end to end, then confirm a `subscriptions` row appears in the Convex dashboard and the organization's plan changes.
2. Confirm the actual webhook payload (Webhooks -> Message attempts) contains `data.plan.slug`, `data.payer.user_id`, `data.period_end` and (on trials) `data.is_free_trial`; adjust `lib/billing/events.ts` if names differ.
3. Confirm feature slugs and plan slugs match this document.
4. Test a 3D Secure card (Stripe `4000 0027 6000 3184`) to see the failure users would see.
5. Cancel, let a period end, and test a failed renewal (Stripe `4000 0000 0000 0341`) to see `past_due` and the 7 day grace.
