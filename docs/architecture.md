# Architecture

## Stack

Next.js 16 (App Router, Cache Components, Turbopack) · React 19 · TypeScript
(strict, `noUncheckedIndexedAccess`) · Tailwind CSS 4 · shadcn/ui (Base UI) ·
Convex (database, functions, realtime, crons) · Clerk (authentication) · Zod +
React Hook Form · Vitest + convex-test · Playwright.

## Layout

```
app/                    Routes
  page.tsx, pricing/    Public marketing site
  sign-in/, sign-up/    Clerk-hosted auth UI
  onboarding/           Create an organization
  app/                  Organization workspace (auth + membership required)
  kiosk/[organizationSlug]/  Public, branded kiosk (no sign-in)
  platform/             SaaS operator console (platform role required)
components/
  ui/                   shadcn/ui primitives
  layout/               App shell, gates, shared page parts
  kiosk/, marketing/, platform/, forms/
convex/
  schema.ts             Tables and indexes
  lib/auth.ts           requireUser / requireMembership / requireSite / requirePlatformAdmin
  lib/functions.ts      orgQuery / orgMutation builders
  lib/audit.ts          Audit log writer
  *.ts                  Functions by domain (organizations, sites, gates, memberships, …)
lib/
  permissions/          Permission list, role matrix, resolver (shared by Convex and UI)
  validation/           Zod schemas (shared by forms and Convex)
  auth/                 Auth provider wiring and helpers
  org/active-org.tsx    Active organization context (UI only)
tests/
  unit/                 Pure logic tests
  convex/               Backend tests against an in-memory Convex
  e2e/                  Playwright
```

## Multi-tenancy

- Every tenant-owned table has `organizationId` and a `by_org` index;
  site-scoped tables also carry `siteId`.
- **All tenant data goes through `orgQuery` / `orgMutation`.** These builders
  take `organizationId` as an argument, then `requireMembership` resolves the
  caller from the verified JWT (`ctx.auth.getUserIdentity()`), loads their
  membership in that organization, and rejects inactive members or suspended
  organizations. The handler receives the verified context as `ctx.oc`.
- Handlers then call `ctx.require("<permission>")`.
- Any record loaded by id is checked against `ctx.oc.org._id`. Site-scoped
  records also go through `requireSite`, which enforces the member's
  `siteAccess`.
- Foreign or missing records produce `NOT_FOUND`, so other tenants'
  records can't be discovered by probing.
- The client's "active organization" is only a UI preference. The server
  re-verifies membership on every call.

## Identity and roles

- `users`: one per authenticated identity, keyed by `tokenIdentifier`. The client
  calls `users.store` after sign-in (`useStoreUser`) and renders org pages only after it succeeds.
- `memberships`: `(organizationId, userId)` → `role`, `permissionOverrides`
  `{grant, revoke}`, `siteAccess` (`"all"` or a list of site ids), `status`.
- `users.platformRole = "super_admin"`: the SaaS operator. Platform functions
  return organization metadata only. Operators get no tenant data unless they
  also hold a membership.

### Permission resolution (`lib/permissions`)

`effective = ROLE_PERMISSIONS[role] ∪ grant − revoke` (revoke wins).

Guardrails, enforced in `convex/memberships.ts`:

- Nobody can modify their own membership.
- Non-owners can only manage members ranked below them and assign roles below
  their own (`ROLE_RANK`). Only owners create or demote owners.
- Overrides can only grant permissions the actor holds themselves.
- Site access can't be widened beyond the actor's own.

Default matrix highlights: receptionists book and manage appointments, but they
can't approve, check in, or manage billing, members, forms or integrations. Guards
check visitors in and out, but can't book. Hosts book and approve their own
visits. Staff record their own attendance.

## Errors

Convex functions throw `ConvexError({ code, message })` with codes
`UNAUTHENTICATED | FORBIDDEN | NOT_FOUND | VALIDATION | CONFLICT` and
user-safe messages (`convex/lib/errors.ts`). The UI shows `message` via
`lib/auth/errors.ts`.

## Auditing

Every write in Phase 1 appends to `auditLogs` in the same transaction
(`writeAudit`). Metadata never contains secrets or unnecessary personal data.

## Auth provider abstraction

Clerk is referenced in only a few places: `app/layout.tsx`
(`ClerkProvider`), `lib/auth/convex-client-provider.tsx`, `proxy.ts`, the
sign-in/up pages, `components/layout/auth-gate.tsx` and `user-menu.tsx`.
Convex functions only use the generic `ctx.auth.getUserIdentity()`, so switching
providers doesn't touch backend authorization.

## Deployment models

- **Shared cloud (current):** Vercel (Next.js) + Convex Cloud. Tenants are
  isolated by the backend checks above.
- **Dedicated (future, not available):** the same codebase deployed to a
  separate Convex deployment and Vercel project per customer. Organization
  configuration is portable data. Provisioning, monitoring, backups and
  support procedures still have to be built and tested before this is offered.
