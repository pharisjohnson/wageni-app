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
| Booking codes, host notification on arrival (N1), forms (F1) | Not started |
| Browser verification of kiosk screens (needs Convex + Clerk + a paired device) | Not done |

## Needs your credentials

- **Convex**: run `pnpm convex:dev` (creates the deployment and real codegen).
- **Clerk**: publishable and secret keys, plus the Convex JWT integration.
  Without these, signed-in flows have not been exercised in a browser.
  Backend behaviour is covered by `convex-test`.

## Not started (by phase)

3. Staff attendance (append-only + corrections)
4. Invitations, form builder (versioned), approval/notification policies
5. Reports, CSV exports, audit UI, retention
6. Email/SMS/WhatsApp adapters, crons, webhooks
7. Plans, usage metering, billing provider, trials
8. Hardening, monitoring, backups, deployment docs, dedicated deployments

## Manual checks (signed-in layout, not automatable without Clerk/Convex credentials)

- App shell, desktop (>= md): the sidebar is `sticky h-svh` and its nav list scrolls on its own. At 1280x500, confirm the nav list scrolls without moving the page and that only one vertical scrollbar shows on the page.
- App shell: the top header stays pinned while the page scrolls; Tab from a fresh load shows the "Skip to main content" link first and it moves focus to the main region.
- Mobile (< md): the hamburger opens the navigation sheet, choosing a link closes it, and the active link has `aria-current="page"`.
- Platform console at 375px: the nav row sits under the title instead of being hidden; "Platform overview" back link shows on sub-pages; "Exit to app" works.
- Kiosk (needs a seeded organization): at iPad portrait and landscape no tile is clipped; Back and Start over are at least 48px tall on every sub-screen; Tab shows a visible ring on the Visitor/Staff tiles; 90 seconds idle on a sub-screen returns to the welcome screen.
