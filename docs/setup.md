# Local setup

## Prerequisites

- Node.js 22+
- pnpm 11 (`corepack enable` or `npm i -g pnpm`)
- A [Convex](https://dashboard.convex.dev) account (free tier is fine)
- A [Clerk](https://dashboard.clerk.com) application

## 1. Install

```bash
pnpm install
cp .env.example .env.local
```

The public site (`/`, `/pricing`) works at this point with `pnpm dev`. Signed-in
areas show a "Backend not configured" notice until the steps below are done.

## 2. Clerk

1. Create a Clerk application and copy its keys into `.env.local`:
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
2. In Clerk → **Configure → Integrations**, activate the **Convex** integration
   (or create a JWT template named exactly `convex`). Note the **Issuer** URL
   (e.g. `https://your-app.clerk.accounts.dev`).

## 3. Convex

```bash
pnpm convex:dev
```

On first run this logs you in, creates a dev deployment, writes
`CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL` to `.env.local`, pushes the
schema and functions, and regenerates `convex/_generated/`. Keep it running.

Then set the Clerk issuer on the Convex deployment:

```bash
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://your-app.clerk.accounts.dev
```

## 4. Run

```bash
pnpm dev
```

Open http://localhost:3000, sign up, and you will be sent to `/onboarding` to
create your first organization.

## 5. Invitation links, per-IP limits (F2)

The public invitation page does not call Convex directly: it goes through the
Next.js route handlers in `app/api/invite/*`, which rate limit per client IP
and then call Convex with a shared secret. Set these once:

| Variable | Where | Value |
| --- | --- | --- |
| `INVITE_PROXY_SECRET` | **Next env** (`.env.local`, Vercel project) **and Convex dashboard** (Settings, Environment Variables) | The same random string in both, at least 32 characters. Generate with `openssl rand -base64 36`. |
| `APP_BASE_URL` | **Convex dashboard** only | The public app URL, e.g. `https://app.example.com`. Makes invitation links absolute (email/SMS). Recommended in production. |
| `CLIENT_IP_HEADER` | Next env, optional | Only when not hosted on Vercel: a header your proxy sets to the client address. |
| `ALLOW_UNPROXIED_INVITES` | Next env **and** Convex, development only | `true` lets the invite page work without a secret (one shared limit for everyone). Never in production. |
| `ALLOW_LOCAL_ORIGIN` | Convex, development only | `true` accepts `http://localhost:3000` as the origin of invitation links. |

```bash
SECRET=$(openssl rand -base64 36)
npx convex env set INVITE_PROXY_SECRET "$SECRET"
# and add the same value as INVITE_PROXY_SECRET to .env.local / the Vercel project
npx convex env set APP_BASE_URL https://app.example.com
```

With `INVITE_PROXY_SECRET` unset, invitation links show "not available"
(fail closed). For local development without a secret:

```bash
npx convex env set ALLOW_UNPROXIED_INVITES true
npx convex env set ALLOW_LOCAL_ORIGIN true
echo "ALLOW_UNPROXIED_INVITES=true" >> .env.local
```

Without `APP_BASE_URL`, the signed-in browser sends its own origin when an
invitation is created; the server accepts it only if it is a clean `https`
origin (or `http://localhost` with `ALLOW_LOCAL_ORIGIN`). Anything with
credentials, a path, query or fragment is ignored and the link stays a path.

## 6. Billing (optional, Phase 7)

Paid plans use PayHero (M-Pesa STK push, KES). Nothing is required to develop: with `BILLING_ENFORCEMENT` unset every
organization has every feature, and without `PAYHERO_MODE=live` payments run in **dry-run** (nothing is sent to PayHero).
Set in the **Convex dashboard** when you want to test or launch billing:

| Variable | Purpose |
| --- | --- |
| `PAYHERO_MODE` | `live` sends real STK pushes. Unset (default) = dry-run. |
| `PAYHERO_AUTH_TOKEN` | Basic authorization token from PayHero's dashboard -> API Keys (with or without the `Basic ` prefix). |
| `PAYHERO_CHANNEL_ID` | Numeric id of your registered M-Pesa payment channel. |
| `PAYHERO_CALLBACK_BASE` | The Convex `.convex.site` URL (https), where PayHero posts payment callbacks. |
| `BILLING_ENFORCEMENT` | `on` enforces plan limits. Anything else (default) = full access. |
| `BILLING_HASH_PEPPER` | Required in live mode: random secret, 16+ characters, keys the phone-number hashes. |
| `ALLOW_DRY_RUN_BILLING` | `true` allows dry-run checkout while `BILLING_ENFORCEMENT=on`. Development only, never in production. |
| `ALLOW_BILLING_SIMULATION` | `true` shows dry-run "Simulate" buttons. Development only, never in production. |

Prices and the trial length are set in `lib/billing/pricing.ts` (unset = checkout disabled). Full checklist: `docs/billing.md`.

## Deploying

Production setup (Vercel, Convex production deployment, Clerk production instance,
variables per environment, backups, runbook, launch checklist) is in
`docs/deployment.md`.

## Optional

**Platform operator.** After signing in once:

```bash
npx convex run platform:grantSuperAdmin '{"email":"you@example.com"}'
```

**Demo data** (development deployments only; clearly labelled "Demo"):

```bash
npx convex env set ALLOW_DEMO_SEED true
npx convex run seed:demo '{"ownerEmail":"you@example.com"}'
```

## Checks

| Command | What it does | Needs credentials |
| --- | --- | --- |
| `pnpm typecheck` | TypeScript (app + Convex) | No |
| `pnpm lint` | ESLint | No |
| `pnpm test` | Vitest: permission unit tests + Convex tenant-isolation tests (in-memory via `convex-test`) | No |
| `pnpm test:e2e` | Playwright on desktop/tablet/mobile viewports (builds and starts the app) | No (public pages only) |
| `pnpm build` | Production build | No |

First-time Playwright users: `pnpm exec playwright install chromium`.

## `convex/_generated`

These files are normally written by `npx convex dev`. Before a deployment
exists (fresh clone, CI), regenerate them with:

```bash
pnpm convex:codegen-offline
```

It uses Convex's own templates. Add new Convex modules → rerun it (or keep
`convex dev` running).
