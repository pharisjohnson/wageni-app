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
| Crons: reminders (15 min), staff scan (30 min), outbox retry (10 min), outbox purge (daily, 90 days). `retention.purgeExpired` (P1) and F1 file cleanup are commented in `convex/crons.ts` until those functions exist | Done |
| Webhook `POST /webhooks/notifications` (HMAC, constant-time, 5 min replay window, generic 4xx) | Done |
| UI: `/app/messages` (stats, filters, retry), `/app/messages/settings` (channels, sender, wording), `/app/integrations` (mode per channel, test-send), notification preferences card on `/app/attendance` | Done; not exercised in a browser |
| New permission `messages:read` (owner, admin, receptionist); settings, retry and test-send use `integrations:manage` | Done |
| Tests: `tests/convex/notifications.test.ts`, `tests/unit/notifications.test.ts` | Passing |

Not done: Swahili text (structure ready), provider-specific webhook adapters (Resend, Africa's Talking and Meta sign differently, so a relay or per-provider mapping is needed), SMS/WhatsApp to staff needs a phone each member enters themselves, per-recipient rate limits, visitor opt-out.

Integration notes. F1: call `ctx.scheduler.runAfter(0, internal.notifications.onInvitationCreated, { organizationId, siteId?, invitee: { name?, email?, phone? }, link, idempotencyKey })`. P1/F1: uncomment their lines in `convex/crons.ts` once `internal.retention.purgeExpired` and `internal.files.purgeExpired` exist. The outbox holds addresses and first names for up to 90 days (`notificationsCron.purgeOld`); P1's retention settings should drive that window.

## Needs your credentials

- **Convex**: run `pnpm convex:dev` (creates the deployment and real codegen).
- **Clerk**: publishable and secret keys, plus the Convex JWT integration.
  Without these, signed-in flows have not been exercised in a browser.
  Backend behaviour is covered by `convex-test`.

## Not started (by phase)

4. Invitations, form builder (versioned), approval/notification policies
5. Reports, CSV exports, audit UI, retention
7. Plans, usage metering, billing provider, trials
8. Hardening, monitoring, backups, deployment docs, dedicated deployments

## Manual checks (signed-in layout, not automatable without Clerk/Convex credentials)

- App shell, desktop (>= md): the sidebar is `sticky h-svh` and its nav list scrolls on its own. At 1280x500, confirm the nav list scrolls without moving the page and that only one vertical scrollbar shows on the page.
- App shell: the top header stays pinned while the page scrolls; Tab from a fresh load shows the "Skip to main content" link first and it moves focus to the main region.
- Mobile (< md): the hamburger opens the navigation sheet, choosing a link closes it, and the active link has `aria-current="page"`.
- Platform console at 375px: the nav row sits under the title instead of being hidden; "Platform overview" back link shows on sub-pages; "Exit to app" works.
- Kiosk (needs a seeded organization): at iPad portrait and landscape no tile is clipped; Back and Start over are at least 48px tall on every sub-screen; Tab shows a visible ring on the Visitor/Staff tiles; 90 seconds idle on a sub-screen returns to the welcome screen.
