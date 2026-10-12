# Security notes

Status: **Phase 1, not reviewed.** This document records the controls that
exist today and the known gaps. The product hasn't had an independent
security or legal review. Do not claim compliance with Kenya's Data Protection
Act 2019 (or any other regime) until one has been done.

## In place

- **Server-side authorization** on every tenant function (`orgQuery` /
  `orgMutation` → `requireMembership` → `ctx.require(permission)`), covered by
  `tests/convex/*`.
- **Tenant isolation.** Ids from the client are always re-checked against the
  caller's organization and site access. Foreign records return `NOT_FOUND`.
- **Privilege escalation guards.** No self-modification, rank-based role
  assignment, grant-only-what-you-hold overrides, bounded site access.
- **Platform separation.** The operator role sees organization metadata only.
  Status changes need a reason and are audited in the tenant's log.
- **Input validation.** Convex validators plus shared Zod schemas (slug,
  time zone, lengths, https-only logo URLs, hex colours).
- **Safe errors.** Coded `ConvexError`s with user-facing messages only.
- **Kiosk privacy.** The public lookup returns branding only. Kiosk
  sub-screens reset after 90 s of inactivity, and no personal data is written to
  browser storage (only the active organization id is remembered in the app).
- **Secrets.** None in the repo. `.env*` is git-ignored except `.env.example`.
  The Clerk issuer is configured in the Convex dashboard.
- **Bounded queries.** Index-backed reads with `take(n)` caps or cursor
  pagination.
- **Abuse limit.** Each account may own at most 5 organizations.

## Known gaps / backlog

- Rate limiting for public endpoints (kiosk registration arrives in Phase 2,
  and `@convex-dev/rate-limiter` should go in alongside it).
- Invitations (Phase 4). Members can currently only be added through the
  data layer.
- Content Security Policy and security headers in `next.config.ts`.
- Retention policies and data-subject request tooling (Phase 5).
- Signed outbound webhooks with SSRF protection (Phase 6).
- Monitoring and alerting (Sentry or equivalent) (Phase 8).
- Backup/restore procedure for Convex (export and import) still needs to be documented and rehearsed.
- The operator console uses a browser prompt to collect a suspension reason;
  this should be replaced with an in-page dialog.
