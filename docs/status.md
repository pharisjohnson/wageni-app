# Implementation status

## Phase 1: Foundation ✅

| Area | Status |
| --- | --- |
| Next.js 16 + TS strict + Tailwind 4 + shadcn/ui scaffold | Done |
| Convex schema: users, organizations, memberships, sites, gates, auditLogs | Done |
| Centralized permissions (`lib/permissions`) shared by backend and UI | Done |
| `orgQuery`/`orgMutation` tenant guard, site-access checks, platform guard | Done |
| Organization onboarding (owner membership + default site + audit) | Done |
| Sites & gates CRUD, member role/status management, kiosk branding | Done |
| App shell (responsive sidebar, org switcher, permission-filtered nav) | Done |
| Branded public kiosk welcome screen with inactivity reset | Done (actions in Phases 2–3) |
| Platform console: organization list, suspend/reactivate with reason | Done |
| Tests: 33 Vitest (unit + tenant isolation), 12 Playwright smoke | Passing |
| CI workflow (typecheck, lint, tests, e2e) | Added, not yet run on GitHub |

## Phase 2: Visits (in progress)

| Area | Status |
| --- | --- |
| Schema: visitors, appointments, visits, append-only visitEvents | Done |
| Appointments: book (incl. on behalf of hosts), approve/decline, cancel, reschedule | Done (backend); list/book/approve/cancel/check-in UI |
| Gate check-in/out, walk-in registration, admit, badge codes | Done (backend); visits page UI |
| Tests: 9 Convex tests (flow, permissions, tenant and site isolation) | Passing |
| Host check-out: `visits:check_out_own`, `hostCheckOut`, `meeting_ended` event, `checkedOutMethod`, optional gate on `checkOut`, `myVisitors`, `recentCheckOuts` | Done (R1) |
| Visit and appointment detail pages (timeline, approval history, reschedule), "My visitors" and "Cleared by host" on visits page | Done (R1); staff-on-behalf is a link placeholder |
| Kiosk visitor flows | Done (K2); staff flows with A1 |

## Kiosk trust (K1)

| Area | Status |
| --- | --- |
| `kioskDevices` table, admin issue/list/revoke (audited, hash never returned) | Done |
| `kioskQuery` / `kioskMutation` builders with per-device rate limit | Done |
| Sites page "Kiosk devices" UI, `/kiosk/<slug>/setup` pairing, `useKioskDevice()` | Done |
| Convex tests (`tests/convex/kiosk.test.ts`) | Passing |
| Kiosk visitor/staff flows using the builders | Wave 2 |

## Visitor kiosk (K2)

| Area | Status |
| --- | --- |
| Appointment check-in by phone (`kioskVisitor.findAppointments` / `checkInAppointment`), badge confirmation, 20s return home | Done |
| Walk-in self-registration (`kioskVisitor.registerWalkIn`, `hosts`): creates an `expected` visit awaiting admit by guard/reception, privacy notice shown | Done |
| Self check-out by badge code + last 4 phone digits (`kioskVisitor.checkOut`, method `kiosk`) | Done |
| Failed-lookup throttle per device, generic responses, audit on lockout | Done |
| `visitEvents`/`auditLogs` accept a kiosk device as actor (`kioskDeviceId`); shared lifecycle logic in `convex/lib/visits.ts` | Done |
| `useKioskApi` (NOT_FOUND unpairs the device) + gate verifies token on mount | Done |
| Convex tests (`tests/convex/kioskVisitor.test.ts`), unit tests (`tests/unit/time.test.ts`) | Passing |
| Booking codes, forms (F1) | Not started (host notification on arrival: done, N1) |
| Browser verification of kiosk screens (needs Convex + Clerk + a paired device) | Not done |

## Staff attendance, Phase 3 (A1)

| Area | Status |
| --- | --- |
| Append-only `attendanceEvents`; clock in/out (CONFLICT on double clock-in), record on behalf (audited) | Done |
| `attendanceCorrections`: request (staff or manager), approve/reject; approving adds a NEW event referencing the original | Done |
| Queries: my status/history, site roster (who is in, daily hours in the site's time zone), person history, pending corrections | Done |
| Kiosk: staff number + PIN (`staffPins`, PBKDF2, 5 failures = 15 min lock), `/kiosk/<slug>/staff/check-in` and `check-out` | Done |
| `/app/attendance` (clock, history, corrections, own PIN) and `/app/staff` (roster, corrections queue, person page with staff number and PIN reset) | Done; not exercised in a browser |
| New permissions `staff_attendance:record_on_behalf`, `staff_attendance:manage_pins`; receptionist gains `read_site` | Done |
| Tests: `tests/convex/attendance.test.ts`, `tests/unit/attendance.test.ts` | Passing |

Not done: voiding an entry without a replacement, exports and reports of hours (Phase 5), manager notifications.

## Notifications, crons and webhooks, Phase 6 (N1)

| Area | Status |
| --- | --- |
| One `NotificationChannel` interface (`lib/notifications/channels.ts`); dry-run adapter is the default and records instead of sending; thin `fetch` adapters for Resend-style email, Africa's Talking SMS and WhatsApp Cloud API, chosen by env vars | Done; real adapters never exercised (no credentials), unit-tested against mocked `fetch` only |
| Tables `notificationOutbox`, `notificationPreferences`, `notificationSettings`, `notificationUsage`; idempotency keys, per-org hourly limit (300), quiet hours, retries after 1/5/30 min then `failed` | Done |
| Triggers: host on arrival (kiosk, guard admit, walk-in admitted at once), walk-in waiting, appointment requested/approved/declined/cancelled/rescheduled, reminder 1h before, missed clock-out, stale corrections alert, `notifications.onInvitationCreated` for F1 | Done |
| Crons: reminders (15 min), staff scan (30 min), outbox retry (10 min), outbox purge (daily, 90 days). P1's retention sweep is registered (daily 01:00 UTC); F1 file cleanup, the F2 upload sweep and the F2 stale rate-limit sweep are registered too | Done |
| Webhook `POST /webhooks/notifications` (HMAC, constant-time, 5 min replay window, generic 4xx) | Done |
| UI: `/app/messages` (stats, filters, retry), `/app/messages/settings` (channels, sender, wording), `/app/integrations` (mode per channel, test-send), notification preferences card on `/app/attendance` | Done; not exercised in a browser |
| New permission `messages:read` (owner, admin, receptionist); settings, retry and test-send use `integrations:manage` | Done |
| Tests: `tests/convex/notifications.test.ts`, `tests/unit/notifications.test.ts` | Passing |

Not done: Swahili text (structure ready), provider-specific webhook adapters (Resend, Africa's Talking and Meta sign differently, so a relay or per-provider mapping is needed), SMS/WhatsApp to staff needs a phone each member enters themselves, per-recipient rate limits, visitor opt-out.

Integration notes. F1: call `ctx.scheduler.runAfter(0, internal.notifications.onInvitationCreated, { organizationId, siteId?, invitee: { name?, email?, phone? }, link, idempotencyKey })`. The outbox holds addresses and first names for at most 90 days (`notificationsCron.purgeOld`); P1's `retention.purgeExpired` also deletes settled rows older than the organization's visitor-record period, so the effective window is the shorter of 90 days and that setting.

## Reports, audit and retention, Phase 5 (P1)

| Item | State |
| --- | --- |
| `convex/reports.ts` (`filterOptions`, `visits`, `onSite`, `appointments`, `hostMeetings`, `attendance`, `today`): `reports:read`, site-access aware, date ranges bounded (93 days, attendance 62), reads capped (3000 visits/appointments, 200 people) with a `truncated` flag | Done |
| Reports UI `/app/reports`: tabs, filter bar (presets, site, host/person), summary cards, SVG charts with text alternatives, tables, skeletons, empty states, attendance person drill-down with Back | Done |
| CSV: `reportsExport.csv` mutation (`reports:export`), BOM, RFC 4180 quoting, formula-injection prefixing (`lib/csv.ts`), 5000-row cap with message, audit entry per export, phone/email columns excluded unless `forms:read_sensitive` (not defined yet, so currently refused for everyone) | Done |
| Audit UI `/app/audit` (`audit:read`): filters (person, action, record type, dates), readable labels, kiosk-device and system actors, pagination; nav item | Done |
| Retention: settings section on Settings (defaults 365 / 730 / 2555 days; minimums 30 / 365 / 365), `retention.purgeExpired` (internal, `dryRun`, bounded batches, self-rescheduling), `retention.sweepAll` daily cron registered in `convex/crons.ts` via `registerRetentionCron` | Done |
| Dashboard: today's on site / expected / checked in / staff in (`reports.today`, per-permission) | Done |

Definitions to confirm with a product owner: a **no-show** is an approved appointment past its end that was never checked in; **late** is a first clock-in after 09:00 local on a weekday (`lateAfterMinutes` argument, no shift schedules exist yet); **absent** is a weekday with no clock-in before today, counted from the member's join date; visit **duration** is check-in to the host's `meeting_ended`, else check-out. Visits are ranged by creation time. "On site at time T" looks back 14 days for visits that started earlier.

Retention behaviour: visits are anonymised, never deleted (badge code cleared; the visitor's name/phone/email/company replaced once no un-anonymised visit or recent appointment references them; on-site visits are skipped; appointment text such as purpose and decision note is kept). Audit entries and attendance events/decided corrections past their period are deleted (a documented exception to append-only, never inside the minimum of one year). `visitEvents` hold no personal data and stay. Settled notification outbox rows follow the visitor-record period too.

## Forms and invitations, Phase 4 (F1)

| Area | Status |
| --- | --- |
| Shared field schema and answer validation (`lib/validation/forms.ts`): 17 field types, showIf, mapsTo, sensitive, retention, consent text | Done |
| `forms` (editable `draftFields`) + immutable `formVersions`; publishing inserts a new version, nothing edits one; archive/restore | Done |
| `formResponses` reference the version answered with; server re-validates every answer (required, type, options, showIf, sizes, consent text, file ownership) | Done |
| Sensitive answers: `forms:read_sensitive` (owner, admin); values never in queries, revealed by audited mutations (`forms.revealSensitive`, `forms.openFile`) | Done |
| Private file storage: kiosk-token or invitation-token upload, size/type limits, `deleteAfter` per file, `internal.files.purgeExpired` (daily cron wired) | Done |
| ID scan behind `lib/ocr` `IdReader`; **`stubIdReader` returns no fields** (no OCR vendor chosen). Full capture/preview/suggest/confirm UI; image kept only if `storeImage` | Done (reader stubbed) |
| Face photo: plain photo, needs required consent field, org switch `faceCaptureEnabled` (default off), no matching anywhere | Done |
| `/app/forms` list, builder (add/reorder with buttons/remove, options, showIf, mapsTo, sensitive, retention), live preview, publish, archive, version history | Done; not exercised in a browser |
| Kiosk walk-in renders the published visitor form for the device's site (fallback to fixed fields), `kioskForms.submitWalkIn` | Done |
| Visit detail shows form answers (sensitive hidden unless permitted) | Done |
| Invitations: `invitations.create/list/cancel`, public `/invite/<token>` (hashed token, generic errors, replay-proof), creates appointment per approval policy; link UI at `/app/appointments/invite` | Done |
| Policies: `requireApproval` per org with site override, `faceCaptureEnabled` (Settings card); applied to `appointments.create` and invitations | Done |
| Invitation delivery: scheduled `internal.notifications.onInvitationCreated` (N1). Set `APP_BASE_URL` in Convex for absolute links | Done |
| Tests: `tests/unit/forms.test.ts`, `tests/convex/forms.test.ts`, `tests/convex/invitations.test.ts` | Passing |

Not done / follow-ups: browser verification of builder, camera, signature and invite page. (The five F1 gaps are closed in F2, below.)

## Forms, uploads and invitations, follow-up (F2)

| Area | Status |
| --- | --- |
| Kiosk appointment check-in shows the published visitor form after the phone match and before the visit exists (`kioskForms.formForAppointment`, `checkInAppointmentWithForm`); `checkInAppointment` returns `form_required` while a form applies; known name/phone/email/company/purpose filled server side; skipped when already answered via the invitation; responses on the visit detail | Done |
| Staff forms: published per site, asked at clock-in at the kiosk (after PIN, no PIN rule changed) and on `/app/attendance`; stored with person, site and clock-in event; managers read them on `/app/staff/[userId]` with sensitive answers withheld; builder labels staff forms, hides visit mapping and file types, publish rules enforce it | Done; not exercised in a browser |
| Per-field answer retention for all answers: `formRetention.redactExpired` (tombstones, bounded batches, dry run, counts-only audit, org minimums enforced), run from the daily `retention.sweepAll` | Done |
| Upload sweep: `uploadIntents`, `files.sweepOrphans` every 30 minutes (expired intents, unclaimed pending files, never-registered blobs via a watermark scan) | Done |
| Content verification: `filesVerify.verify` action checks magic bytes, type and size; files `verified` or deleted and flagged `rejected`; `forms.openFile` needs `verified` | Done; the action is tested with `convex-test` against stored blobs, not against a real Convex deployment |
| Per-IP limits on the invite page via `app/api/invite/[action]` with `INVITE_PROXY_SECRET` and hashed IP; direct Convex calls refused; fails closed; dev flag | Done; trust in the platform's IP headers is an assumption (see security.md) |
| Absolute invitation links: validated browser origin, `APP_BASE_URL` wins | Done |
| Tests: `tests/convex/{kioskAppointmentForm,staffForms,formRetention,uploads,inviteProxy}.test.ts`, `tests/unit/{f2-lib,invite-proxy}.test.ts` | Passing |

Operational notes: set `INVITE_PROXY_SECRET` (Next env and Convex, same value) and `APP_BASE_URL` (Convex); see `docs/setup.md`. Files stored before F2 have no verification status and cannot be opened until `npx convex run filesVerify:requeueLegacy` has queued them (repeat while it returns 200). Existing form responses are picked up by the redaction job on its first run.

Still limited: per-IP limiting covers the invitation functions only (kiosk calls are per device); staff forms cannot hold files and clock-ins recorded on someone's behalf skip the form; verification does not validate that a file is well formed; none of the new browser screens (appointment form step, staff form at the kiosk and on Attendance, staff answers on the person page, invite page through the proxy) has been exercised in a browser; the Convex action and scheduler paths have only run under `convex-test`.

## Hardening and release readiness, Phase 8 (H1)

| Area | Status |
| --- | --- |
| Adversarial review of every unauthenticated entry point and the tenant boundary; inventory table in `docs/security.md` | Done (internal; not an independent pen test) |
| Kiosk check-out: per-visit lockout after 5 wrong digit attempts, 24 h badge expiry, CSPRNG badge codes | Done, tested |
| Escalating device locks (5 to 60 min) for lookups; per-device PIN-failure budget so one tablet cannot lock out staff at scale | Done, tested |
| Walk-in budgets: 250/day/device, 3/day/phone/organization, friendly errors | Done, tested |
| `getPublicBySlug` minimal, validated and re-checked on output; page-size caps on authenticated lists | Done, tested |
| Security headers and CSP (`next.config.ts`, `lib/security/headers.ts`), `proxy.ts` matchers reviewed, `/api/health` | Done; headers verified in a production build with Playwright; **CSP not verified against live Clerk** |
| Structured PII-free logging (`convex/lib/log.ts`), alert list, Sentry/log-drain hook points | Done (helper and events); no vendor installed; alerts not created |
| Tenant data export and visitor erasure (`convex/dataRights.ts`), backup/restore, data lifecycle, DPA procedure | Done in code and docs; **restore drill not run**, no UI |
| `docs/deployment.md`: environments, variables, Clerk/Convex/Vercel setup, migration and rollback, smoke test, runbook, checklist | Done |
| CI: typegen step (without it typecheck fails on a clean checkout), split jobs, caches, least-privilege permissions, `pnpm audit` informational | Done; **never run on GitHub** (same commands run locally) |
| Dependency audit | One high finding (`braces`, dev tooling, no patched release exists); see `docs/deployment.md` |
| Secrets scan of the working tree and all git history | Clean (key, token and private-key patterns; no `.env*` ever committed except `.env.example`) |
| Tests added: `tests/convex/{hardening,dataRights}.test.ts`, `tests/unit/{security-headers,log}.test.ts`, `tests/e2e/security.spec.ts` | Passing |

### What is verified and what is not

| Area | Verified how | Not verified |
| --- | --- | --- |
| Tenant isolation, permissions, site access, kiosk flows, forms, files, retention, notifications, reports | 568 Vitest tests (Convex functions run in-memory with `convex-test`) | Against a real Convex deployment (scheduler, actions, storage, cron timing behave differently from the test double) |
| Typecheck, lint, production build | Run locally and clean (one pre-existing lint warning in the forms builder) | GitHub Actions run |
| Public pages, headers, health, public routes stay public, invite API refuses bad calls | Playwright against a production build, desktop/tablet/mobile (security specs pass) | Behaviour with real Clerk keys |
| Pricing page e2e (`public.spec.ts`, `navigation.spec.ts`) | Were failing on `main` since the B1 merge (selectors out of date with the page copy); selectors updated in H1, now passing | |
| Sign-in, onboarding, every signed-in screen, kiosk screens with a paired device, invite page through the proxy | Backend logic by tests; UI by reading and typecheck | **Never exercised in a browser** (no Clerk or Convex credentials were available) |
| CSP with Clerk, Turnstile, Convex websockets, camera | Policy built and unit-tested | A browser against real services (do the report-only rollout in `docs/deployment.md`) |
| Notifications and receipts | Delivery logic with a fake channel; webhook signature code | Real Resend, Africa's Talking, WhatsApp or provider callbacks |
| File content verification | Magic-byte logic and the action under `convex-test` | Real storage blobs; malware scanning does not exist |
| Backup and restore | Procedure written from the CLI's documented behaviour | A drill |
| Alerts and uptime monitoring | Events and endpoints exist | Nothing is configured in any monitoring service |
| Billing | See the B2 follow-up below | |

### Pre-launch blockers

1. Run the app against a real Convex deployment and Clerk instance and walk the smoke
   test in `docs/deployment.md` section 7 (nothing signed-in has been seen in a browser).
2. Roll the CSP out in report-only on a preview with real Clerk keys, fix violations,
   then enforce.
3. Get CI green on GitHub and make it required (full local e2e: 58 pass, 5 skipped by design).
4. Set production variables and secrets (`INVITE_PROXY_SECRET`, `APP_BASE_URL`,
   `CLERK_JWT_ISSUER_DOMAIN`, ...), create the Vercel Firewall rules, turn on Convex
   backups and run the restore drill.
5. Create the alerts in `docs/deployment.md` section 8 and test-fire one.
6. Billing review after PayHero lands (checks listed in the H1 report and in
   `docs/billing.md`), including end-to-end payment test and webhook failure handling.
7. Independent penetration test, a Data Protection Impact Assessment and ODPC
   registration (legal); privacy notices that state retention and backup delay.
8. Decide on the open items in `docs/security.md` (Known gaps), notably real file
   scanning, a UI for export/erasure and organization deletion.

## Needs your credentials

- **Convex**: run `pnpm convex:dev` (creates the deployment and real codegen).
- **Clerk**: publishable and secret keys, plus the Convex JWT integration.
  Without these, signed-in flows have not been exercised in a browser.
  Backend behaviour is covered by `convex-test`.

## Not started (by phase)

4. Invitations, form builder (versioned), approval/notification policies
8. Dedicated per-customer deployments (hardening, monitoring, backups and deployment docs: see H1 above)

## Manual checks (signed-in layout, not automatable without Clerk/Convex credentials)

- App shell, desktop (>= md): the sidebar is `sticky h-svh` and its nav list scrolls on its own. At 1280x500, confirm the nav list scrolls without moving the page and that only one vertical scrollbar shows on the page.
- App shell: the top header stays pinned while the page scrolls; Tab from a fresh load shows the "Skip to main content" link first and it moves focus to the main region.
- Mobile (< md): the hamburger opens the navigation sheet, choosing a link closes it, and the active link has `aria-current="page"`.
- Platform console at 375px: the nav row sits under the title instead of being hidden; "Platform overview" back link shows on sub-pages; "Exit to app" works.
- Kiosk (needs a seeded organization): at iPad portrait and landscape no tile is clipped; Back and Start over are at least 48px tall on every sub-screen; Tab shows a visible ring on the Visitor/Staff tiles; 90 seconds idle on a sub-screen returns to the welcome screen.

## Plans, entitlements and billing (B1 + B2, Phase 7)

| Area | Status |
| --- | --- |
| Entitlement model (tiers, features, limits as data), `lib/plans.ts` derived from it | Done |
| Subscriptions per **organization** (`subscriptions`), paid with PayHero M-Pesa (`billingPayments`); Clerk Billing removed | Done (tests only) |
| PayHero STK push, unauthenticated callback treated as a hint + server-side status verification, idempotent apply, reconciliation cron, retry/abuse limits, dry-run provider behind a `PaymentProvider` interface | Done (tests with mocked `fetch`) |
| Prices (`PLAN_PRICES_KES`) and trial length (`BUSINESS_TRIAL_DAYS`) | **Unset by design**: checkout is disabled until the owner decides prices |
| Free Business trial (one per organization), renewal reminders (7/3/1 days), grace and downgrade, payment receipts | Done |
| Enforcement (server): sites, gates, staff re-activation, custom forms (+count), audit log, custom retention, live notifications (dry-run on Starter, monthly cap), read-only extra sites after downgrade | Done; `BILLING_ENFORCEMENT` off by default |
| `/app/billing` (plan, meters, M-Pesa checkout with live status, history, trial), `/platform/usage` with plan access and manual `grantPlan` (audit-logged) | Done |
| `PLAN_LIMIT` error + upgrade prompts (toast action, `UpgradeNotice`, `FeatureGate`) | Done |
| Operator checklist `docs/billing.md` | Done |
| Tests: `tests/unit/billing.test.ts`, `tests/unit/payments.test.ts`, `tests/convex/billing.test.ts`, `tests/convex/payhero.test.ts` | Passing |
| **A real PayHero account, a real STK push or payment, PayHero's actual callback/status payloads, the billing UI in a browser** | **Not done** (none was used; response fields beyond PayHero's documented ones are untested) |
| Known limits: KES only, no automatic recurring M-Pesa, cards not covered, no tax invoicing (check KRA/eTIMS with an accountant), refunds in PayHero | See `docs/billing.md` |
| Not enforced: visits per month (metered only), outbound webhooks/integrations (no backend yet), gating of kiosk/check-in at over-limit sites | By design / later |
