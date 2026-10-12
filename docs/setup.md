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
