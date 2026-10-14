# Security notes

Status: **internally reviewed in Phase 8 (H1); no independent review.** This
document records the controls that exist today and the known gaps. The product
hasn't had an independent security or legal review. Do not claim compliance with
Kenya's Data Protection Act 2019 (or any other regime) until one has been done.
Start with "Hardening review (H1)" for the inventory of public entry points.

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
  combinations); H1 added per-visit lockout, 24 h badge expiry and escalating
  device locks, and walk-in daily budgets (see "Hardening review (H1)"). A phone
  number is the only proof of identity for appointment check-in. A visitor can
  learn whether a phone number has an appointment today by knowing that number
  (inherent to phone lookup).

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
  lockout, device token and rate limit. H1 added a per-device
  budget (10 failures / 15 minutes, exponential lock up to an hour, nothing
  counted against people while locked), so one kiosk can lock at most two
  people per window.
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
  `internal.files.purgeExpired` runs daily. The declared content type is now
  checked against the real bytes and abandoned uploads are swept (see F2).
- **ID scan** is read-and-discard by default; OCR output is only a suggestion
  that the visitor must confirm. The OCR engine is a stub: when one is chosen,
  review whether the image leaves the device.
- **Face capture** is a plain photo, off per organization by default, requires
  an earlier required consent field, and is hidden from kiosks immediately when
  switched off. No face matching or recognition exists.
- **Invitations.** Token = 256 random bits, only its SHA-256 stored; shown once.
  Every failure (unknown, malformed, expired, cancelled, used, suspended org,
  inactive site) returns the same `{status:"unavailable"}`. Single use. Global
  public rate limit (120/min) protects the database; per-IP limits are in F2
  below. The page sets `noindex` and `no-referrer`. The raw link is passed to the
  notifications scheduler job once; N1 redacts it after sending.

## Forms, uploads and invitations, follow-up (F2)

- **Appointment check-in form.** With a published visitor form for the site,
  `kioskVisitor.checkInAppointment` returns `form_required` and creates nothing.
  The kiosk calls `kioskForms.formForAppointment` (phone re-verified, same
  failed-lookup throttle) and then `kioskForms.checkInAppointmentWithForm`,
  which validates with the shared `validateAnswers`, creates the visit through
  `admitAppointment` and stores the response with visit, appointment and form
  version. Name, phone, email, company and purpose already held by the
  appointment are filled on the server and never sent to the screen (so a
  stranger who knows only a phone number learns nothing new); a stored value the
  field would reject is asked for instead. If the visitor already answered
  through their invitation link, they are not asked again. Invalid answers throw
  before the visit exists.
- **Staff forms** (audience "staff"). Required at clock-in, at the kiosk and in
  `/app/attendance`, only when one is published for the site. The kiosk keeps the
  PIN rules: `identify` returns the form only after the PIN verified and only when
  a clock-in is possible; `record` re-verifies the PIN and returns (never throws)
  `form_required`, `form_stale` or `form_invalid`, so the failed-PIN counter and
  lockout are unaffected. Answers go through `validateAnswers`, are stored with
  `userId`, `siteId` and `attendanceEventId`, and audited against the person or
  device. Managers (`staff_attendance:read_site`, within their sites) and the
  person read them via `forms.staffResponses`; sensitive values are withheld and
  revealed only through the audited `forms.revealSensitive`. The publish rules
  refuse visit mappings and file, photo, signature and ID fields on staff forms.
  Reception recording a clock-in on someone's behalf and approved corrections do
  not ask for the form.
- **Per-field retention for every answer.** Each answer lives for its field's
  `retentionDays`, else the organization period (visitor forms: visitor records;
  staff forms: attendance), clamped to the organization minimum in
  `lib/retention.ts` (30 days visitor, 365 days staff) and the 3650 day maximum.
  `formRetention.redactExpired` (internal, daily via `retention.sweepAll`)
  replaces due values with the tombstone `{redacted:true}`; the response row, its
  form version and its subject stay. It reads only due rows through the
  `by_org_redaction` index (each row carries the next time to look at it, at most
  30 days ahead, so a shortened organization period catches up), works in bounded
  batches, supports `dryRun`, and writes a `form_answers.redacted` audit entry with
  counts only (responses, answers, sensitive answers). File answers are left to
  `files.deleteAfter`.
- **Upload sweep.** Every upload URL records an `uploadIntents` row (cleared at
  registration; an uploader may hold 20 open ones). `files.sweepOrphans` (every
  30 minutes, bounded batches) deletes expired intents, unclaimed `pending` files
  past their TTL, and blobs with no `files` row. The blob scan walks storage in
  creation order from a persisted watermark up to two hours ago, so each blob is
  judged once. It assumes all blobs in this deployment come from these upload
  flows.
- **Content verification.** `registerUpload` records the file `pending` and
  schedules `internal.filesVerify.verify` (an action: the only place bytes can be
  read). It checks magic bytes (JPEG, PNG, WebP, PDF) against the declared type
  and the kind's allowed types (signatures: PNG only), and the real size against
  the recorded size and limit. Pass: `verified`. Fail: bytes deleted, file marked
  `rejected` (`file.rejected` audit entry, reason code only), and the answer shows
  "did not pass the content check". `forms.openFile` refuses anything not
  `verified`. Kiosk and invitation uploads share this path. A file can be attached
  while verification is still running; if it is rejected afterwards its bytes are
  gone and the answer says so.
- **Per-IP limits on the public invitation page.** Convex cannot see IPs, so the
  invite page calls Next.js route handlers (`app/api/invite/[action]`), which
  read the client address from `x-real-ip` / `x-vercel-forwarded-for` /
  `x-forwarded-for` (or `CLIENT_IP_HEADER`), hash it with HMAC-SHA256 keyed by
  `INVITE_PROXY_SECRET`, and call Convex with `{ proxySecret, ipHash }`. Convex
  compares the secret in constant time (digests compared, so length and position
  do not leak) and counts `ip:<scope>:<hash>` in `publicRateLimits` (lookup 60 per
  minute, uploads 30 per 5 minutes, submit 15 per 10 minutes, per client), then
  applies the older global limits. The functions `invitations.lookup`
  (now a mutation), `generateUploadUrl`, `registerUploaded` and `submit` reject
  any call without the secret, so the limits cannot be skipped by calling Convex
  directly. No secret configured = refused (fails closed); `ALLOW_UNPROXIED_INVITES`
  is an explicit development-only escape hatch. Raw IPs are never sent to Convex
  or stored; stale counters are swept daily. Request bodies are capped at 512 KB.
  **Trust assumption:** the platform must overwrite the client IP headers (Vercel
  does). Elsewhere, set `CLIENT_IP_HEADER` to a header your proxy controls, or
  clients can rotate `x-forwarded-for` to dodge the limit. A request with no
  readable IP shares one `unknown` bucket. **Vercel Firewall rules (WAF rate
  limiting, bot protection) are an additional layer, not a replacement:** they act
  before the function runs and also protect the upload POST itself.
- **Absolute invitation links.** `APP_BASE_URL` (Convex env) wins. Otherwise the
  signed-in browser sends `window.location.origin` and the server accepts it only
  as a clean `https` origin (or `http://localhost` / `127.0.0.1` / `[::1]` when
  `ALLOW_LOCAL_ORIGIN=true`); credentials, paths, queries, fragments and other
  schemes are ignored and the link stays a path. Without `APP_BASE_URL`, any
  https origin from a signed-in member is accepted, so a member could point their
  own invitation at a host they control; set `APP_BASE_URL` in production.

## Hardening review (H1)

An internal adversarial review of every unauthenticated entry point and the
tenant boundary, with fixes and tests (`tests/convex/hardening.test.ts`,
`dataRights.test.ts`, `tests/unit/security-headers.test.ts`,
`tests/e2e/security.spec.ts`). It is **not** an independent penetration test.

### Inventory of unauthenticated entry points

"Device token" means a per-gate kiosk token (256 bits, hash stored) resolved by
`kioskQuery`/`kioskMutation`; every failure is the same `NOT_FOUND`. All kiosk
mutations also share the 60 calls/minute per-device limit, so it is not repeated
in the table. "Proxy" means reachable only through `app/api/invite/*` with
`INVITE_PROXY_SECRET`, which adds a per-IP budget.

| Entry point | Auth model | Limits | Returns | Abuse notes |
| --- | --- | --- | --- | --- |
| `organizations.getPublicBySlug` (query) | None | None possible on a query; input validated before any read (slug shape, 64 chars); one indexed read; Convex caches per argument | Name, slug, https logo, hex colour, welcome text, privacy notice. No ids, status, members, sites | Unknown, suspended and malformed slugs are the same `null`. Slugs are not secret, so the existence of an org is public by design |
| `health.ping` (query) | None | None | `{ ok: true }` | Constant, no reads |
| `kiosk.context` (query) | Device token | Read-only | Site and gate name | |
| `kiosk.heartbeat` (mutation) | Device token | 60/min/device | `{ ok }` | |
| `kioskVisitor.hosts` (query) | Device token | Read-only; at most 500 memberships scanned, 200 names returned | Host names and user ids for this site | Names are visible to anyone standing at a paired kiosk, by design |
| `kioskVisitor.findAppointments` | Device token + phone | Lookup throttle: 8 failures / 5 min lock the device; locks escalate 5, 10, 20, 40, 60 min | First name, host name, start time for the caller's own approved appointments today at this site | Generic `no_match`; a locked device answers `locked` for right and wrong guesses alike |
| `kioskVisitor.checkInAppointment` | Device token + phone + appointment id | Same lookup throttle | First name, host name, new badge code | Phone re-verified; an id alone is useless |
| `kioskVisitor.registerWalkIn` | Device token | **250 / day / device, 3 / day / phone number / organization** (friendly `RATE_LIMITED` messages); validated fields; host must work at this site | First name, host name | Creates an `expected` visit that a person must admit. Never edits an existing visitor record |
| `kioskVisitor.checkOut` | Device token + 6-digit badge code + last 4 phone digits | Lookup throttle; **5 wrong digit attempts lock that visit at the kiosk**; **badge accepted for 24 h only** | First name on success | Wrong code, wrong digits, locked visit, expired badge and other site are all `no_match`. Badge codes come from the CSPRNG and are unique among visitors on site |
| `kioskForms.activeVisitorForm` (query) | Device token | Read-only | The published visitor form definition (labels, consent text) for this site | Form text is public to the kiosk by design; answers are never returned |
| `kioskForms.formForAppointment` | Device token + phone | Lookup throttle | Form definition; details the appointment already holds are filled server side and never returned | |
| `kioskForms.checkInAppointmentWithForm` | Device token + phone + form version | Lookup throttle | First name, host name, badge code | Answers validated server side before any write |
| `kioskForms.submitWalkIn` | Device token | Same walk-in budgets as `registerWalkIn` | First name, host name | |
| `kioskAttendance.identify` / `record` | Device token + staff number + PIN | Per person: 5 failures lock 15 min. **Per device: 10 failures / 15 min lock the device, doubling to 60 min; nothing is counted against a person while the device is locked** | First name, status, staff form (after the PIN verified) | Failures return `{ ok:false }` identically and burn equal CPU; a throttled device returns `{ ok:false, throttled:true }`, which does not depend on whether a guess was right |
| `filesKiosk.generateUploadUrl` / `registerUploaded` | Device token | 30 uploads / 5 min / device, 20 open upload intents | One-shot upload URL; file id | Size and declared type checked, bytes verified by magic number afterwards; the kiosk can never read a file back |
| `invitations.lookup` (mutation) | Invitation token (256 bits) + proxy secret | **Proxy:** 60/min per IP; global 120/min | Invitation details for that token only | Every failure is `unavailable`; single use |
| `invitations.generateUploadUrl` / `registerUploaded` | Invitation token + proxy | 30 / 5 min per IP; 10 uploads per invitation; global 120/min | Upload URL; file id | |
| `invitations.submit` | Invitation token + proxy | 15 / 10 min per IP; global 120/min | `ok` or `unavailable` | Consumes the link |
| `POST /webhooks/notifications` (Convex HTTP) | HMAC-SHA256 over `timestamp.body` with `NOTIFY_WEBHOOK_SECRET` | 4 KB body cap; 5 min replay window; 404 when no secret | `{ ok:true }` whether or not the id matched | Rejections are logged as `webhook_rejected` (no content). Billing routes: see `docs/billing.md` |
| `POST /webhooks/payhero/<token>` (Convex HTTP, B2) | Unsigned callback: path token (hash stored) plus a server-side status check with PayHero before crediting | See `docs/billing.md` | `{ ok }` | Reviewed separately; checks recommended in the H1 report |
| `POST /api/invite/[action]` (Next) | Proxy for the four invitation functions | 512 KB body cap; action allowlist; per-IP budgets applied in Convex | Whatever the Convex function returns | Fails closed (503) without `INVITE_PROXY_SECRET`; callers cannot send their own `proxySecret`/`ipHash` |
| `GET /api/health` (Next) | None; `?deep=1` needs the `HEALTH_CHECK_TOKEN` bearer | Deep refused without the token | `{ status: "ok" }`; deep adds "configured" booleans and Convex reachability | `no-store`. No versions, hosts or secrets |
| Pages `/kiosk/*`, `/invite/*`, marketing | None | Platform (Vercel Firewall) | Static shells; no tenant data until a device token or invitation token is presented | `/invite` sets `noindex` and `no-referrer` |

Signed in but not organization-scoped: `users.store`/`me` (own record),
`organizations.create` (max 5 owned, validated), `organizations.mine` (own
memberships), `organizations.isSlugAvailable` (needs sign-in), `platform.*`
(`super_admin` only, metadata only). Everything else tenant-facing is an
`orgQuery`/`orgMutation`; the only functions that take an organization from
anywhere but the caller's membership are `internal*` ones (not callable by
clients) and the kiosk/invite functions above, which derive it from the token.
`convex/billing*` and the billing webhooks are covered in `docs/billing.md`.

### Findings and fixes

| # | Severity | Finding | Fix | Test |
| --- | --- | --- | --- | --- |
| 1 | Medium | Kiosk check-out secret (6-digit code + 4 digits) was protected only by the per-device lookup throttle, so a patient guesser (96 guesses an hour on one tablet) could close someone else's visit | A visit locks for kiosk check-out after 5 wrong phone-digit attempts (audit `visit.kiosk_checkout_locked`; staff can still check out); the kiosk only accepts badges younger than 24 h; the device lock escalates (item 5) | `hardening.test.ts` "kiosk check-out secret" |
| 2 | Medium | Badge codes came from `Math.random()` (not a CSPRNG) | `crypto.getRandomValues` with rejection sampling, still unique among visitors on site | "issued badge codes are 6 digits and unique" |
| 3 | Medium | Walk-in spam limited only to 60/min/device: a tablet could create tens of thousands of visitor rows, audit entries and notifications a day | 250/day/device and 3/day/phone/organization (phone hashed in the counter key); friendly messages; the sweeper keeps 24 h counters | "walk-in spam budgets" |
| 4 | Medium | Anyone at a paired kiosk who knew staff numbers could lock those people out (5 wrong PINs each, repeatable every 15 minutes) | Per-device PIN-failure budget (10 / 15 min) with exponential lock to 60 min; while locked nothing is counted against a person. One tablet can lock at most two people per window | "staff PIN: device-wide failure budget" |
| 5 | Low | The lookup lock was a flat 5 minutes, so guessing could continue all day | Escalating lock 5, 10, 20, 40, 60 min, reset after a quiet day (audit entry carries the level) | "escalating lookup lock", "throttle maths" |
| 6 | Low | `getPublicBySlug` accepted unbounded input and served stored branding unchecked | Slug shape and length validated before the read; logo (https) and colour (hex) re-validated on output | "organizations.getPublicBySlug" |
| 7 | Low | `paginationOpts.numItems` was client-controlled on the audit, members and platform lists | Clamped to 100 (`clampPagination`) | "page size caps" |
| 8 | Info | No security headers or CSP; CI typecheck would fail on a clean checkout (generated route types) | Headers and CSP in `next.config.ts`; `next typegen` step in CI | `security-headers.test.ts`, `security.spec.ts` |
| 9 | Info | No way to export a tenant's data or erase one visitor (Kenya DPA access and erasure) | `dataRights.exportChunk`, `dataRights.eraseVisitor` (owner only, audited, bounded) | `dataRights.test.ts` |

Checked and found sound (no change): ids from the client are re-verified against
the caller's organization and site access wherever they are loaded; there is no
`.collect()` anywhere in `convex/`; no `v.any()` outside the billing webhook (out
of scope here); the audit actor is always derived from `ctx` (a user id or a
device id, never from arguments); `visitEvents`, `attendanceEvents` and form
versions are only ever inserted (the documented retention deletions are the sole
exception); the invite proxy cannot be bypassed (direct calls are `FORBIDDEN`);
customer text (logo URL, welcome text, privacy notice, form labels, help text,
consent text) is only rendered as React text, there is no
`dangerouslySetInnerHTML`, logos must be `https://` and colours are hex; CSV
export neutralises leading `=`, `+`, `-`, `@`, tab and CR; no redirect takes a URL
from input; the kiosk setup token travels in the URL fragment and is removed from
the address bar once stored.

### Web hardening (`next.config.ts`, `lib/security/headers.ts`)

- `Content-Security-Policy` allowlist: `default-src 'self'`; scripts from self,
  Clerk's Frontend API host (derived from the publishable key) and Cloudflare
  Turnstile; `connect-src` to Convex (`https`/`wss` `*.convex.cloud`) and Clerk;
  `img-src` self, data, blob and `https:` (customer logos); `media-src blob:`
  (camera preview); `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`;
  `frame-ancestors 'none'`. **`script-src` keeps `'unsafe-inline'`**: a nonce
  policy needs every page rendered per request, which would defeat the static
  shell and partial prefetch this app depends on. Mitigation: the app never
  renders user-supplied HTML. Revisit with nonces if pages go fully dynamic.
  Fonts come from `next/font`, which self-hosts them at build time, so no font
  host is allowed.
- `Strict-Transport-Security` (1 year, includeSubDomains; no `preload` until the
  domain is committed), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin` (invite pages set
  `no-referrer`), `Permissions-Policy: camera=(self)` with everything else off,
  `x-powered-by` removed.
- Roll out safely: set `CSP_REPORT_ONLY=true` on the first preview deployment with
  real Clerk keys, click through sign-in, kiosk, invite upload and the camera, read
  the console for violations, then remove it. The local Playwright run has no
  Clerk keys, so the Clerk part of the policy is **verified by reasoning and unit
  tests only, not in a browser**.
- CSRF: sign-in uses Clerk's cookies (`SameSite=Lax`). The app has no
  cookie-authenticated state-changing route handlers: Convex calls carry a bearer
  JWT, not a cookie, and the only Next POST handler, `/api/invite/*`, authorises
  with tokens in the body. `form-action 'self'` and `frame-ancestors 'none'` add
  defence in depth.
- `proxy.ts` protects `/app`, `/platform` and `/onboarding` only (optimistic;
  Convex is authoritative). `/kiosk`, `/invite`, `/api/invite`, `/api/health` and
  marketing stay public; `/api/health` is excluded from the Clerk middleware.

### Edge rate limits: what Vercel Firewall must do

Convex cannot see client IPs and the browser talks to `*.convex.cloud` directly,
so **Vercel's firewall never sees kiosk calls**: the kiosk is defended by device
tokens, per-device budgets and lockouts only. Do not rely on the WAF for it.
What the WAF can and should cover (Project, Firewall, Custom Rules):

1. `POST /api/invite/*`: rate limit 60 requests/minute per IP, challenge then deny
   for 10 minutes. (Matches the per-IP budgets in Convex; this stops the traffic
   before a function runs.)
2. `/kiosk/*` and `/invite/*` pages: 120 requests/minute per IP, challenge. They
   are static shells; this is cost control and scraping protection.
3. `/api/health`: 30 requests/minute per IP.
4. `/sign-in`, `/sign-up`: leave to Clerk's bot protection; keep Vercel's managed
   bot rules on.
5. Know where "Attack Challenge Mode" is; it is the incident switch.

Residual: an attacker who rotates IPv6 addresses inside one /64 gets a fresh
per-IP budget each time (hash the /64 if this becomes real); a request whose IP
cannot be read shares one `unknown` bucket, which one abuser could exhaust for
other no-IP callers (not the case on Vercel).

### Residual risks (accepted, documented)

- A phone number is the only proof of identity for appointment check-in; a person
  who knows another visitor's number can see their first name, host and time and
  check them in (inherent to the design; the badge goes to whoever is at the kiosk).
- A person at a paired kiosk can still deny service to that kiosk's lookups and PIN
  entry for up to an hour at a time by failing on purpose, and can lock two staff
  PINs per window. Re-issuing the device (revoke, pair again) clears its counters;
  managers reset a locked person's PIN. Neither exposes data.
- After 5 wrong digit attempts a visitor must see reception to check out; that is
  intentional.
- `registerUpload` and the invalid-link branch of `invitations.registerUploaded`
  delete the blob named in the call. A storage id is a random capability shown only
  to the uploader, so this needs a leaked id.
- Kiosk device tokens live in `localStorage`; script injection on the kiosk origin
  could read one. CSP, no HTML rendering and a 256-bit revocable token limit this;
  revoke on loss.
- `braces` (dev tooling: ESLint and the `shadcn` CLI) has an open advisory
  (GHSA-vfj7-8cjw-p6xm, stack exhaustion on hostile glob patterns); no patched
  version is published yet. It is not in the application bundle.
- Not automated: outbox rows holding a visitor's address are removed by the 90 day
  purge, not by `eraseVisitor`; see `docs/deployment.md` for the full data-subject
  procedure.

## Known gaps / backlog

- Kiosk calls are limited per paired device and by lockouts, not per IP (see "Edge
  rate limits" above for what the WAF can cover). Direct uploads of bytes to Convex
  storage URLs are not proxied (the URLs are one-shot and issued only after the
  per-IP check).
- Content verification checks signatures, type and size, not that an image or
  PDF is well formed or free of embedded active content. Files are only shown
  as images or offered as downloads.
- Staff forms cannot contain files (no signed-in upload path), and a clock-in
  recorded on someone's behalf does not collect the form.
- Answer redaction does not rewrite free text kept elsewhere (appointment
  purpose, decision notes) or the `visitors` record, which P1's anonymisation
  covers.
- Signed outbound webhooks with SSRF protection (inbound delivery receipts are done, see Notifications).
- Error tracking (Sentry or similar) is a documented hook point, not installed; see `docs/deployment.md`.
- The Convex backup/restore procedure is documented but has not been rehearsed against a production deployment (restore drill in `docs/deployment.md`).
- No independent penetration test or Data Protection Impact Assessment yet.
- The operator console uses a browser prompt to collect a suspension reason;
  this should be replaced with an in-page dialog.

## Billing and plan enforcement (B1, B2)

- **PayHero callback is unauthenticated.** `POST /webhooks/payhero/<token>` (`convex/http.ts`) is treated as an untrusted hint. The token (256-bit random, per payment) is stored only as a SHA-256 hash and travels only in the callback URL we give PayHero; malformed tokens 404, bodies over 8 KB or non-JSON get 400, and every well-formed request gets the same `200 {"ok":true}` whether or not it matched anything. Nothing is credited from the body: the server looks the payment up by token hash, calls PayHero's `transaction-status` API with the stored reference, and credits only on `SUCCESS` with matching reference / `CheckoutRequestID` / amount. Plan and amount come from our row. A callback naming a different `ExternalReference` is ignored. Verification calls per payment are throttled (3 s). Tokens, phone numbers, callback bodies and PayHero credentials are never logged or returned to clients.
- **Idempotent crediting.** `applySuccess` is guarded by `appliedAt`/status inside one transaction: replays, duplicates and concurrent verifications credit once. A verified success that does not match the record is not credited, marked failed and audit-logged.
- **Reconciliation** (`billing payment reconcile` cron) polls pending payments older than 30 s and times them out after 10 minutes; timed-out/cancelled payments are re-checked for 24 hours so late payers are not lost.
- **Personal data minimisation.** The phone number is never written to the database or the scheduler (checkout is an action; only the last four digits and an HMAC for retry limits are stored). Audit entries hold plan, period, amount and receipt only. Subscription rows hold no personal data.
- **Abuse protection** (see `docs/billing.md`): one pending payment per organization, cooldown, per-organization and per-phone hourly limits, consecutive-failure block per phone and an account-wide failure circuit breaker, all kept well below PayHero's own blocking thresholds.
- `billing.startCheckout` and the status/cancel functions require `billing:manage` (owner by default) and the caller's own verified identity; `paymentStatus` and `cancelPayment` return NOT_FOUND for payments of other organizations. `billing.entitlements` is readable by any active member and contains no payment details; `billing.platformUsage` is platform-admin only and returns plan metadata and counts. `platform.grantPlan` is platform-admin only and audit-logged with a reason.
- The dry-run simulator cannot credit a live payment: it requires the payment to be a dry-run one AND `PAYHERO_MODE` not `live`; the public button additionally needs `ALLOW_BILLING_SIMULATION=true`. Never set that in production (with `PAYHERO_MODE` unset in production, anyone with `billing:manage` could otherwise grant themselves a plan).
- Enforcement is server-side (`convex/lib/entitlements.ts`); UI hiding is cosmetic. `BILLING_ENFORCEMENT` must be exactly `on`. Demo organizations (`isDemo`) bypass it: do not set `isDemo` on real tenants. Plan state is cached nowhere; every restricted call re-reads the organization's single subscription row. `usageCounters` writes happen inside the same transaction as the metered action.
- **H2 adversarial review (PayHero billing).** Hardened: (1) one PayHero reference and one M-Pesa receipt can credit only one payment (indexes `by_reference`, `by_receipt`; a clash is audited as `billing.payment_mismatch`, a reused reference is refused at checkout), and a callback-supplied receipt hint is dropped if another payment owns it; (2) if PayHero reports the M-Pesa code as `reference`, it is accepted only with a matching stored `CheckoutRequestID`, and a `FAILED` answer about another reference cannot fail our payment; (3) the account-wide failure breaker counts at most 3 failures per organization and never blocks an organization that already pays, so one tenant cannot deny service to all; (4) live mode requires `BILLING_HASH_PEPPER` (16+ chars, no fallback to the auth token or a built-in key), so phone hashes cannot be enumerated from the small Kenyan number space without the key; (5) with enforcement on, dry-run checkout is refused unless `ALLOW_DRY_RUN_BILLING=true`, and `/platform/usage` shows a banner for enforcement plus dry-run, the simulation switch and missing live variables (`billing.platformBillingHealth`); (6) a payment cancelled in the instant before PayHero answered keeps its reference so a late success stays verifiable; (7) status-API amounts given as numeric strings are compared rather than skipped. Covered by tests: unknown, short, long and non-JSON tokens or bodies return before any PayHero call; concurrent duplicate callbacks plus reconcile credit once (one mutation guarded by `appliedAt`); other-organization payment ids read as NOT_FOUND on status, cancel and simulate; `grantPlan` bounds. The billing code writes no logs and errors returned to clients are generic.
- Residual risks (H2): the status API's exact response (amount, receipt field names) is untested against a live account; PayHero timing out while accepting an STK push can leave a real payment without a reference (operator reconciles manually, see `docs/billing.md`); a tenant can send an STK prompt to any phone number (rate limited per number); trials and the failure breaker are per organization and organizations are cheap to create; the unknown-token and known-token response times differ by one PayHero call (irrelevant for 256-bit tokens); the callback body size is checked after reading (Convex bounds request size).
- Residual risks: PayHero's API and callback behavior is untested against a live account; if the status API is unreachable payments stay pending and resolve on a later cron run (fail-safe: never credited without verification). PayHero credentials live only in the Convex environment.
