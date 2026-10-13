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

## Kiosk trust (K1)

`/kiosk/<slug>` is a public URL, so the URL alone never authorises reads or
writes of tenant data. Each kiosk is paired with a per-gate **device token**:

- An admin (`sites:manage`) issues a token under Sites & gates > Kiosk devices.
  It is shown once; only its SHA-256 hash is stored (`kioskDevices.tokenHash`).
  Tokens are 256-bit random values. Issue and revoke are audit-logged.
- Kiosk-facing Convex functions must use `kioskQuery` / `kioskMutation`
  (`convex/lib/kiosk.ts`). They resolve the device from `{ slug, token }` and
  reject revoked devices, tokens for another organization, suspended
  organizations and inactive sites/gates, always with the same generic
  `NOT_FOUND`.
- `kioskMutation` applies a per-device fixed-window rate limit (60/minute) and
  touches `lastSeenAt` at most every 5 minutes. Queries are read-only so they
  are not rate limited; token entropy makes guessing infeasible.
- The browser stores the token in localStorage (device identity, no personal
  data). Revoking a device takes effect on its next call. The setup link puts
  the token in the URL fragment so it is not sent to servers or logged.
- A revoked or invalid token is handled on the client by `useKioskApi`
  (`lib/kiosk/use-kiosk-api.ts`): any `NOT_FOUND` from a kiosk call calls
  `unpair()` and the screen becomes "This kiosk is not set up".
  `KioskDeviceGate` also verifies a stored token once on mount.

## Visitor kiosk (K2)

Self-service flows in `convex/kioskVisitor.ts`, all `kioskQuery`/`kioskMutation`,
so the device token fixes org, site and gate; the visitor never supplies them.

- **Appointment check-in.** Lookup is by phone (last 9 digits compared, so
  `0700...` and `+254700...` match) against *approved appointments today at
  this site* (day computed in the site time zone). The response contains only
  `appointmentId`, first name, host name and start time for the caller's own
  matches: never a list of other people's appointments, no surname, phone,
  email or purpose. Check-in re-verifies the phone, so an appointment id alone
  is useless. Nothing matching (wrong phone, not approved, other day, other
  site, other tenant) yields one generic `no_match`.
- **Check-out.** 6-digit badge code plus last 4 phone digits, matched only
  among visits on site at the device's site. Wrong code and wrong digits are
  indistinguishable. Closes the visit with `checkedOutMethod: "kiosk"`.
- **Walk-in.** Shared Zod validation (`lib/validation/visits`) on client and
  server. Creates an `expected` visit (same as `visits.registerWalkIn` for a
  caller who cannot admit), so a guard/receptionist must admit it. A returning
  visitor is matched by phone but the public form never edits their stored
  record. The host list is names only (`userId`, `name`), limited to active
  members who can host at this site. The org privacy notice is shown before
  submit. Personal data is held in React state only.
- **Throttle.** Lookups never throw on "no match" (a throwing mutation rolls
  back its counter). They return a generic result and count a failure on the
  device: 8 failures in 5 minutes locks lookups on that device (`locked`, even
  for a correct guess) until the window ends. Reaching the limit writes a
  `kiosk.lookup_throttled` audit entry. The 60 calls/minute limit still applies.
- **Actor model.** `visitEvents` and `auditLogs` now have optional
  `actorUserId` plus optional `kioskDeviceId`; exactly one is set. Kiosk
  actions are attributed to the device (shown as "Kiosk: <device name>" on the
  visit timeline), with the gate recorded on the event and in audit metadata.
  Events stay append-only. Shared logic lives in `convex/lib/visits.ts`
  (`admitAppointment`, `registerVisit`, `completeCheckOut`) and is used by both
  the signed-in and kiosk paths.
- Residual risks: the badge code + 4 digits is a weak secret (about 10^10
  combinations) protected only by the per-device throttle, and an attacker with
  several paired devices multiplies attempts. A phone number is the only proof
  of identity for appointment check-in. Walk-in submissions are limited only by
  the 60/minute device rate limit. A visitor can learn whether a phone number
  has an appointment today by knowing that number (inherent to phone lookup).

## Staff attendance and kiosk PINs (A1)

- **Append-only.** `attendanceEvents` are only inserted. A correction request
  (`attendanceCorrections`) changes only its own status; approving inserts a new
  event (`source: "correction"`, `correctionId`, `correctsEventId`). The
  original stays and is merely excluded from hour totals. Nobody can decide a
  correction to their own attendance.
- **Identification at the kiosk** is staff number (per organization, set by a
  manager) plus PIN (4-6 digits, weak runs and repeats refused). The device
  token authorises the kiosk, the PIN authorises the person, and both are
  verified server-side on every call (`identify` and again on `record`). The
  client keeps them in React state only, never in storage.
- **PIN storage.** PBKDF2-HMAC-SHA256, 100k iterations, random 16-byte salt per
  user, constant-time compare. Never returned, logged or shown; managers can
  only reset (delete) a PIN, the person sets a new one while signed in.
- **Lockout.** 5 wrong PINs lock the person for 15 minutes; a reset or a new PIN
  unlocks. Kiosk functions RETURN `{ ok: false }` (not throw) so the counter
  is not rolled back. Unknown staff number, wrong PIN, no PIN, locked, disabled
  and no-site-access all return the identical result and burn comparable CPU.
  Lockout is audited (`attendance.pin_locked`, by device).
- **Residual risks.** A 4-6 digit PIN has little entropy: protection rests on the
  lockout, device token and rate limit. An attacker with a paired kiosk can lock
  out a known staff number (denial of service) for 15 minutes at a time.
  Staff numbers are not secret (printed on badges is fine). Correction times are
  entered in the device's time zone, not the site's.

## Notifications and webhooks (N1)

- **Secrets** come only from Convex environment variables (`.env.example`, N1 block). They are read inside the delivery action, never written to tables, logs, errors or query results. Provider error handling keeps the HTTP status only, since response bodies can echo recipients or keys. `notifications.channelConfig` returns modes and the names of missing variables, never values.
- **Dry-run by default.** Without full provider config a channel records the message and sends nothing; the UI says "Test mode".
- **Tenant isolation.** Every outbox, preferences and settings read goes through `orgQuery`/`orgMutation`. Staff recipients must hold an active membership in the same organization at enqueue time; visitor contacts are copied from that organization's own records. Tests cover cross-org list, stats, retry and settings.
- **Minimal data.** Payloads hold template placeholders only. Visitor-facing messages contain first name, organization, time and host name; never purpose, company, phone, email or badge code. Host messages carry the visitor's name and site. History responses mask addresses (`j***@x.com`) and omit bodies and provider ids.
- **Links are secrets.** `invitation_created` payloads hold the invite link only until the message settles (sent or failed), then it is replaced with `[redacted]`.
- **Retention.** Outbox rows (with the recipient address) are deleted after 90 days by `notificationsCron.purgeOld`, or sooner when the organization's visitor-record retention (P1) is shorter. Skipped rows store no address.
- **Abuse limits.** 300 messages per organization per hour (excess is recorded as `skipped: rate_limited`), 5 test sends per hour, addresses must be a single plain email or an E.164 phone (no header injection), placeholder values lose control characters and are length-capped, template overrides may only use each event's own placeholders and no HTML.
- **Idempotency.** Each trigger passes a stable key, and `(organization, key, channel, recipient)` is checked before insert, so repeats (retries, double clicks, overlapping crons) enqueue once. Delivery is at-least-once: a crash after a provider accepted a message but before the outcome was saved can send it twice. A 2 minute claim lock limits concurrent sends of the same row.
- **Triggers cannot break business actions.** Hooks are scheduled (`ctx.scheduler.runAfter(0, internal.notifications.onX)`), so an error in notification code never rolls back a check-in or booking.
- **Webhook** `POST /webhooks/notifications`: HMAC-SHA256 over `timestamp.body` with `NOTIFY_WEBHOOK_SECRET`, constant-time compare, 5 minute replay window (older or future timestamps rejected), 4 KB body cap, one generic 401/400 body for every failure, `200 {"ok":true}` whether or not the id matched (no probing), 404 when no secret is configured. Receipts only move forward (sent, delivered, read), so a replay inside the window is harmless; `failed` is ignored after delivered.
- **Residual risks.** The shared-secret scheme needs a relay for providers that sign differently. Quiet hours drop (not defer) messages, so a host may miss an arrival alert at night by choice. A staff member can enter any phone number as their own, which the org rate limit bounds. Provider message ids are assumed unique across tenants; an ambiguous match is ignored.

## Reports, exports, audit and retention (P1)

- **Access.** Every report is an `orgQuery` asserting `reports:read` (attendance also needs `staff_attendance:read_site`); the caller's site access and any site filter are applied in `reportScope`, and a foreign or inaccessible `siteId` is NOT_FOUND. Dashboard figures return null for anything the role cannot already see.
- **Bounded reads.** Date ranges are capped, row reads are capped, and a `truncated` flag is returned rather than silently partial totals.
- **Exports.** Generated server-side in a mutation so the audit entry (who, report, filters, row count, truncated, sensitive flag) commits with it. Needs `reports:export` (owner, admin). Cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`; fields are quoted per RFC 4180. Phone and email are marked sensitive and omitted by default; including them needs `forms:read_sensitive` (to be defined by F1; until then refused). On-screen reports never return contact details.
- **Audit log.** Readable only with `audit:read`; entries are enriched with the actor (person, paired kiosk device, or system) without exposing other tenants' devices. Nothing in the app edits entries.
- **Retention.** Settings need `settings:manage`; minimums (visitor records 30 days, audit and attendance 365 days, max 3650) are enforced when saving and again at purge time, so a stored shorter value is clamped. `retention.purgeExpired` is internal-only (not callable by clients), supports `dryRun`, works in bounded batches per organization, and writes a `retention.purged` audit entry with counts. Deleting audit and attendance rows past retention is the one sanctioned exception to append-only; it never goes below a year.
- **Residual risks.** Anonymisation does not rewrite free text in appointment purpose/decision notes or visit purpose, which staff may have typed names into. Anonymised visitors keep their id, so counts stay linkable to a (now unnamed) visit. Late/absent figures rest on default rules, not contractual shifts.

## Forms, files and invitations (F1)

- **Versions are immutable.** No function patches or deletes a `formVersions`
  row. Responses store `formVersionId`; the kiosk and invite page must post the
  currently served version or get CONFLICT. Consent answers must carry the exact
  text of that version.
- **Server-side validation** (`lib/validation/forms.ts`, re-run in Convex):
  unknown keys, required, type, option membership, showIf (hidden answers are
  dropped), size limits. Client checks are convenience only.
- **Sensitive data.** ID scans, face photos and ID numbers are forced
  `sensitive`. Queries never return sensitive values or file URLs. Reading
  needs `forms:read_sensitive` (owner, admin; overridable per member) via
  mutations that write an audit entry (`form_response.sensitive_read`,
  `file.read`; ids and field names only, never values). Denied reads are not
  logged. CSV export of sensitive columns needs the same permission and is off
  by default.
- **Files.** Private Convex storage; URLs only from audited, permission-checked
  mutations. Upload URLs need a valid kiosk token or a live invitation token,
  are rate limited (30 per 5 min per device; 10 per invitation), and
  `registerUpload` enforces size and an allowed content type, deleting
  violating bytes. A file can be attached once, only by the uploader (device or
  invitation), only for a field of the matching kind. Every file has
  `deleteAfter` (field `retentionDays`, default 90 days; unclaimed uploads 1 h);
  `internal.files.purgeExpired` runs daily. Limits: content type is declared by
  the uploader (not sniffed); never-registered uploads are not swept.
- **ID scan** is read-and-discard by default; OCR output is only a suggestion
  that the visitor must confirm. The OCR engine is a stub: when one is chosen,
  review whether the image leaves the device.
- **Face capture** is a plain photo, off per organization by default, requires
  an earlier required consent field, and is hidden from kiosks immediately when
  switched off. No face matching or recognition exists.
- **Invitations.** Token = 256 random bits, only its SHA-256 stored; shown once.
  Every failure (unknown, malformed, expired, cancelled, used, suspended org,
  inactive site) returns the same `{status:"unavailable"}`. Single use. Global
  public rate limit (120/min) protects the database; per-IP limits need the edge
  (Vercel Firewall), a hardening (H1) item. The page sets `noindex` and
  `no-referrer`. The raw link is passed to the notifications scheduler job once;
  N1 redacts it after sending.

## Known gaps / backlog

- Rate limiting for public endpoints (kiosk registration arrives in Phase 2,
  and `@convex-dev/rate-limiter` should go in alongside it).
- Invitations (Phase 4). Members can currently only be added through the
  data layer.
- Content Security Policy and security headers in `next.config.ts`.
- Retention policies and data-subject request tooling (Phase 5).
- Signed outbound webhooks with SSRF protection (inbound delivery receipts are done, see Notifications).
- Monitoring and alerting (Sentry or equivalent) (Phase 8).
- Backup/restore procedure for Convex (export and import) still needs to be documented and rehearsed.
- The operator console uses a browser prompt to collect a suspension reason;
  this should be replaced with an in-page dialog.
