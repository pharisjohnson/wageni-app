# Agent plan: consolidating Wageni

Goal: finish Phases 2–8 in `docs/status.md` with parallel agents that don't
collide, starting with the two gaps found in the first sign-in review (kiosk
flows, navigation).

## Ground rules for every agent

- Read `AGENTS.md` and the relevant guide in `node_modules/next/dist/docs/`
  before writing Next.js code (Next 16: `proxy.ts`, async `params`, Cache Components).
- Every tenant function goes through `orgQuery` / `orgMutation`; every
  permission lives in `lib/permissions`. No ad-hoc role checks.
- Append-only tables (`visitEvents`, attendance) are never patched or deleted.
- Each screen below the top level has a Back control (`PageHeader back=…` in
  the app, `KioskNav` at the kiosk). New screens must use them.
- Each agent works in its own git worktree/branch, adds Convex tests for new
  backend behaviour, and finishes with `pnpm typecheck && pnpm lint && pnpm test`.
- **`convex/schema.ts` and `convex/validators.ts` are shared.** Agents add
  tables in their own block and rebase before merging. Merge in wave order.

## Done in this pass

- Sidebar nav scrolls independently of the page (`components/layout/app-shell.tsx`).
- Kiosk: Back / Start over on every sub-screen; Visitor hub (appointment,
  new visitor, leaving) and Staff hub (check in, check out) with a
  "ask reception" fallback. The five leaf screens are placeholders.
- Home page expanded into a long-form sales page for early users (see below).
- `PageHeader` / `ComingSoon` accept a `back` link; visit and appointment
  detail pages use it.

## Decisions needed before Wave 1 (recommendations in bold)

1. **How a public kiosk is trusted.** Recommend a per-gate *kiosk device token*
   created by an admin in Sites & gates and stored on the device. Public
   mutations require slug + token, are rate limited, and return minimal data.
   Anyone can open `/kiosk/<slug>`, so the URL alone must never authorise writes.
2. **How staff identify at the kiosk.** Recommend a staff PIN (hashed, lockout
   after failures) with QR badge as a later option. Choosing "Staff" grants nothing.
3. **How a visitor checks out.** Three routes, all writing the same
   append-only `visitEvents`: the host (below), the gate/receptionist, and the
   kiosk (badge code, or phone number plus the last 4 digits of the code).
4. **"By a receptionist".** Recommend the signed-in Visits page is the
   receptionist desk (walk-in, appointment check-in, check-out, staff
   check-in on behalf), and the kiosk is self-service only.

## Host check-out (proof of the meeting)

The host ends the visit from their own screen so the visitor can leave the
gate without waiting for a guard to process them.

- New permission `visits:check_out_own`: a host may check out only visits where
  `hostUserId` is themselves (enforced in Convex, like `appointments:read_own`).
  Guards and receptionists keep `visits:check_out` for any visit at their sites.
- `checkOut` currently requires a `gateId`. Make it optional and record how the
  checkout happened (`method: host | gate | reception | kiosk`).
- New event type `meeting_ended` (host confirmation) separate from
  `checked_out`: it records *who confirmed and when*, which is the meeting
  proof. Both events are append-only and shown on the visit timeline and in
  reports (meeting duration = check-in → host confirmation).
- The gate's on-site list updates live (Convex subscription) and shows
  "cleared by host", so guards can let the visitor through at once.
- Host screen: "My visitors" on the dashboard and the Visits page, with a
  one-tap "Meeting done / check out", plus an optional note.
- Owner: R1 (receptionist desk) with a Convex change in `convex/visits.ts`.

## Form builder and ID capture

Admins design the data each kind of person is asked for (visitor, staff,
per site or per purpose). Forms are versioned: a visit stores the form
version it was answered with, so old records never change.

Field types: short text, long text, number, phone, email, date/time, single
choice, multiple choice, dropdown, yes/no, consent checkbox (with the exact
text shown), signature, file upload, **photo (camera)**, **ID scan**, and
**face photo**. Each field has: required, help text, visibility rules
(show if…), who may see the answer (permission), and a retention period.

**ID scan with autofill.** The visitor photographs their ID at the kiosk or on
their phone; the form reads name, ID number, date of birth and expiry and
pre-fills the matching fields for the visitor to confirm. Always editable,
never trusted blindly.
- Reading text: an OCR provider behind one interface (`lib/ocr`), so the
  engine can be swapped. Options are an on-device library (nothing leaves the
  device) or a cloud API (more accurate on Kenyan IDs and passports). Pick
  after a spike on real sample IDs.
- The image is stored only if the form says so (Convex file storage, private,
  short-lived signed URLs, deleted on the retention date). "Read and discard"
  should be the default.
- Fields are mapped to the ID by the admin in the form builder
  (e.g. "Full name ← ID name").

**Face capture.** Phase A is a *photo* for the badge and the visit record.
Phase B, *face matching* (e.g. match a returning visitor or the ID photo), is a
separate opt-in feature. Faces and ID numbers are sensitive personal data under
the Kenya Data Protection Act (and GDPR for other markets): before any of this
ships we need a consent step with a plain-language purpose, a per-organization
switch that is off by default, a stated retention period, a delete-on-request
path, and an audit entry for every view. We treat matching as its own
decision, not a free add-on.

Owner: F1, building on K2. It extends the Phase 4 scope with the field
types above. Needs a decision on OCR provider and a legal check on face data.

## Wave 1: foundations (run in parallel)

| Agent | Scope | Owns |
| --- | --- | --- |
| **K1 Kiosk trust** | `kioskDevices` table, token issue/revoke UI in Sites & gates, `kioskQuery`/`kioskMutation` builders (token check, rate limit, audit), tests that the URL alone cannot read or write | `convex/lib/kiosk.ts`, `convex/kiosk*.ts`, `app/app/sites` |
| **R1 Receptionist desk** | Finish Phase 2 UI: visit detail with event timeline, appointment detail with approval history and reschedule, check-out and staff-on-behalf entry points on Visits; **host check-out** ("My visitors" + `meeting_ended` event) | `app/app/visits/**`, `app/app/appointments/**` |
| **Q1 Navigation and QA audit** | Walk every route signed in and out, confirm Back/Home, scroll and focus order, mobile sheet nav, add Playwright coverage for kiosk navigation | `tests/e2e`, small fixes anywhere in `components/layout`, `components/kiosk` |

## Wave 2: flows (needs K1; R1 can finish alongside)

| Agent | Scope | Owns |
| --- | --- | --- |
| **K2 Visitor kiosk** | Appointment lookup and check-in, walk-in form (validated with `lib/validation/visits`), check-out, confirmation screen with badge code, idle reset | `app/kiosk/*/visitor/**` |
| **A1 Staff attendance (Phase 3)** | Append-only `attendanceEvents`, clock in/out, correction requests with approval, `/app/attendance` and `/app/staff` pages, kiosk staff check-in/out via PIN | `convex/attendance*.ts`, `app/app/attendance`, `app/app/staff`, `app/kiosk/*/staff/**` |

K2 and A1 both read K1's builders and touch different kiosk subtrees, so they don't conflict.

## Wave 3: configuration and reach

| Agent | Scope |
| --- | --- |
| **F1 Forms and invitations (Phase 4)** | Versioned form builder with the full field-type list (photo, ID scan with autofill, face photo, signature, consent…); visitor and staff forms rendered at the kiosk (K2 switches from hard-coded fields to the published form); invitation links; approval and notification policy settings; OCR adapter and file storage with retention |
| **P1 Reports and audit (Phase 5)** | Reports, CSV export, audit log UI, retention settings |
| **N1 Notifications (Phase 6)** | Email/SMS/WhatsApp adapters behind one interface, host-arrival alerts, crons, webhooks, Messages page |

## Wave 4: business and release

| Agent | Scope |
| --- | --- |
| **B1 Plans and billing (Phase 7)** | Usage metering, plan limits enforced in Convex, billing provider, trials, platform Usage page |
| **H1 Hardening (Phase 8)** | Security review of every public (kiosk/invite) function, monitoring, backup and restore notes, deployment docs, CI run on GitHub |

## Merge order and checks

K1 → R1 → Q1 → K2 → A1 → F1 → P1 → N1 → B1 → H1. After each merge: full test
run, update `docs/status.md`, and a Q1-style navigation pass on the new screens.

## Needs the user

Convex (`pnpm convex:dev`) and Clerk JWT integration must be live for any
agent to verify signed-in flows in a browser; until then only `convex-test`
coverage is possible.
