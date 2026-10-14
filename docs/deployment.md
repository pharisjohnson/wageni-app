# Deployment, operations and data lifecycle

Everything needed to take Wageni from a working repo to a running production
service: environments, variables, Clerk and Convex setup, schema changes,
smoke tests, alerting, backups and data-subject requests. Local development is
in `docs/setup.md`; the security model is in `docs/security.md`.

Billing variables, webhooks and plan setup are being rewritten (PayHero) and live
in `docs/billing.md`. Do not copy them from here.

## 1. Environments and isolation

| Environment | Next.js (Vercel) | Convex | Clerk | Data |
| --- | --- | --- | --- | --- |
| Local | `pnpm dev` | personal **dev** deployment (`pnpm convex:dev`) | **development** instance | Throwaway; demo seed allowed |
| Preview | one per pull request | a Convex **preview** deployment per branch, or one shared "staging" deployment | **development** instance (never the production one) | Test data only |
| Production | `main` | the **production** deployment | **production** instance | Real personal data |

Rules that keep them apart:

- A preview must never hold production secrets. In Vercel, scope every production
  value to the *Production* environment only; give Preview its own set.
- Production and non-production use different Clerk instances, so a test account
  can never sign in to production, and different `INVITE_PROXY_SECRET`,
  `NOTIFY_WEBHOOK_SECRET` and provider keys.
- `ALLOW_DEMO_SEED`, `ALLOW_UNPROXIED_INVITES` and `ALLOW_LOCAL_ORIGIN` are
  development switches. They must be **unset** on the production Convex
  deployment (check with `npx convex env list --prod`).
- Preview deployments send no real SMS or email unless you give them provider
  credentials. Leave them unset: every channel then runs in "dry run" mode.

## 2. Environment variables

"Next" = Vercel project environment variables. "Convex" = Convex dashboard,
Settings, Environment Variables (or `npx convex env set NAME value [--prod]`).

| Variable | Where | Production | Preview / local | Purpose |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_CONVEX_URL` | Next | prod deployment URL (`https://<name>.convex.cloud`) | dev or preview URL | Browser and server calls to Convex. Also used to build the CSP |
| `CONVEX_DEPLOY_KEY` | Next (build only) | production deploy key | preview deploy key | Lets `npx convex deploy` run in the Vercel build (section 4) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Next | `pk_live_...` | `pk_test_...` | Clerk front end. The CSP derives Clerk's host from it |
| `CLERK_SECRET_KEY` | Next | `sk_live_...` | `sk_test_...` | Clerk server side (proxy, route protection) |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Next | `/sign-in`, `/sign-up` | same | Routing |
| `NEXT_PUBLIC_APP_URL` | Next | `https://app.example.com` | `http://localhost:3000` | Public base URL |
| `NEXT_PUBLIC_APP_NAME` | Next | optional | optional | Product name in the UI |
| `INVITE_PROXY_SECRET` | **Next and Convex, same value** | 32+ random chars (`openssl rand -base64 36`) | different value | Invite proxy fails closed without it |
| `CLIENT_IP_HEADER` | Next | unset on Vercel | unset | Only off-Vercel: header your proxy controls |
| `HEALTH_CHECK_TOKEN` | Next | 16+ random chars | optional | Enables `/api/health?deep=1` |
| `CSP_REPORT_ONLY`, `CSP_REPORT_URI` | Next | unset after rollout | `true` on the first preview | CSP rollout switch and report endpoint |
| `CLERK_JWT_ISSUER_DOMAIN` | Convex | production Clerk issuer, e.g. `https://clerk.example.com` | dev issuer, e.g. `https://x.clerk.accounts.dev` | Convex verifies Clerk JWTs against it |
| `APP_BASE_URL` | Convex | `https://app.example.com` | unset or the preview URL | Absolute invitation links; **required in production** (otherwise a member could point their own invitations at another host) |
| `NOTIFY_EMAIL_PROVIDER`, `RESEND_API_KEY`, `NOTIFY_EMAIL_FROM` | Convex | set when email goes live | unset (dry run) | Email via Resend |
| `NOTIFY_SMS_PROVIDER`, `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID`, `AT_SANDBOX` | Convex | set when SMS goes live; `AT_SANDBOX` unset | `AT_SANDBOX=true` | Africa's Talking SMS |
| `NOTIFY_WHATSAPP_PROVIDER`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` | Convex | optional | unset | WhatsApp Cloud API (approved templates `wageni_<event>`) |
| `NOTIFY_DEFAULT_COUNTRY_CODE` | Convex | `254` | `254` | Local numbers to international |
| `NOTIFY_WEBHOOK_SECRET` | Convex | random; unset = endpoint off | unset | Delivery receipts at `<convex site url>/webhooks/notifications` |
| Billing variables | Convex | see `docs/billing.md` | see `docs/billing.md` | Being rewritten |
| `ALLOW_DEMO_SEED`, `ALLOW_UNPROXIED_INVITES`, `ALLOW_LOCAL_ORIGIN` | Convex (and Next for the middle one) | **never set** | dev only | Development switches |

Secrets live only in Vercel and Convex. Nothing in the repository holds a
secret and `.env*` is git-ignored (`.env.example` is the template and is
current).

## 3. Clerk production instance

1. In Clerk, create the **production instance** (not "development"). Add your
   production domain; Clerk shows DNS records (a `clerk.` CNAME and mail
   records). Add them at your DNS host and wait for verification.
2. Copy the production publishable and secret keys into the Vercel *Production*
   environment.
3. **Integrations, Convex**: activate the Convex integration on the production
   instance (or create a JWT template named exactly `convex`). The **issuer** is
   the production Frontend API URL (for a custom domain, `https://clerk.<domain>`).
   Set it as `CLERK_JWT_ISSUER_DOMAIN` on the production Convex deployment.
   A mismatch here shows up as every signed-in call failing with "not signed in".
4. **Domains and allowed origins**: the production domain is the primary
   domain; add `www` or alternates as satellite/allowed origins only if used.
   Under *Paths*, keep `/sign-in` and `/sign-up` (matches `NEXT_PUBLIC_CLERK_*`).
5. Enable bot protection and sign-up restrictions you want (email verification
   required, disposable-email blocking). Enforce MFA for platform operators.
6. Set the platform operator once, from a trusted machine:
   `npx convex run platform:grantSuperAdmin '{"email":"ops@example.com"}' --prod`
   after that person signed in once.
7. Billing webhooks and plans: `docs/billing.md`.

## 4. Convex production deployment

1. Create the production deployment (Convex dashboard, project, "Production").
   Note its URL for `NEXT_PUBLIC_CONVEX_URL`.
2. Set the Convex variables from section 2 on it (`--prod` flag or dashboard,
   Production selected).
3. Deploy functions and schema: `npx convex deploy` with `CONVEX_DEPLOY_KEY` set to
   the production key. On Vercel, set the build command to
   `npx convex deploy --cmd 'pnpm build'` so code and backend ship together and the
   build gets the right `NEXT_PUBLIC_CONVEX_URL`. Preview builds use a preview
   deploy key and create a preview deployment.
4. `convex/_generated` is committed; keep it current with
   `pnpm convex:codegen-offline` when adding modules (or let `convex dev` write it).
5. Turn on the Convex features you pay for: **automatic backups** (dashboard,
   Backups), **log streaming** (section 8) and the **Sentry/exception reporting
   integration** if your plan has it. Check the current plan page: availability
   and retention differ by plan.

## 5. Vercel

1. Import the repo. Framework: Next.js. Node 22. Package manager: pnpm (from
   `packageManager` in `package.json`).
2. Build command `npx convex deploy --cmd 'pnpm build'`; install `pnpm install --frozen-lockfile`.
3. Add the variables (section 2), production values scoped to Production only.
4. Domains: attach the production domain, redirect `www` or apex to one canonical
   host, HTTPS is automatic. Do not add `preload` to HSTS until the domain is final.
5. Firewall: add the rules listed in `docs/security.md` ("Edge rate limits").
6. Deployment Protection: leave Vercel Authentication on for Preview so unreleased
   builds are not public; production stays public.
7. First preview: set `CSP_REPORT_ONLY=true`, click through the flows in
   section 7 with the browser console open, fix any violation (usually a missing
   host in `lib/security/headers.ts`), then unset it.

## 6. Schema and function changes: migration and rollback

Convex validates every document against `convex/schema.ts` when a deploy is
pushed, so a schema that does not fit existing data is rejected instead of
corrupting it. Work with that:

- **Additive first.** New fields are `v.optional(...)`; new tables and indexes can
  be added freely. Code must tolerate the field being absent (every recent field in
  this repo, for example `visits.checkoutFailures`, works this way).
- **Widen, migrate, narrow** for anything breaking: (1) deploy a schema that allows
  old and new shapes, (2) run a bounded internal mutation that rewrites rows in
  batches (`npx convex run migrations:foo --prod`, scheduling itself until done),
  (3) deploy the narrowed schema once the data is clean. Never combine steps in one
  deploy.
- **Before a risky change**, take a manual backup (section 9). That is the real
  rollback for data.
- **Rollback of code**: redeploy the previous commit
  (`git checkout <tag> && npx convex deploy`, or promote the previous Vercel
  deployment and re-run the Convex deploy from the same commit). This is safe only
  while the schema still admits the data written since; that is why changes stay
  additive for one release. Deployments are not atomic across Vercel and Convex:
  deploy Convex first (the `convex deploy --cmd` build does), keep the old client
  working against the new backend for one release.
- Tag every production release (`git tag release-YYYYMMDD-N`) so "previous" is
  unambiguous.
- Crons and scheduled functions run the code that is deployed when they fire;
  after a rollback check `npx convex logs --prod` for errors from jobs.

## 7. Launch-day smoke test (manual, about 30 minutes)

Run it on the production URL, with a throwaway organization you delete or mark as
yours afterwards. Tick each line.

Platform
1. `GET /api/health` returns `{"status":"ok"}`; with the bearer token
   `/api/health?deep=1` returns `backend: "ok"` and all three `checks` true.
2. Response headers on `/` include `Content-Security-Policy`,
   `Strict-Transport-Security`, `X-Frame-Options: DENY`.
   (`curl -sI https://app.example.com/`.)
3. Marketing pages load; `/app` while signed out redirects to sign-in.

Accounts and tenancy
4. Sign up with a new email (verification works), land on `/onboarding`, create an
   organization. A second account cannot see the first one's organization.
5. Add a second member (receptionist); sign in as them in another browser and check
   they see reception pages only and `/app/settings` is refused.

Kiosk
6. Sites and gates: create a gate, issue a kiosk device, open the setup link on a
   tablet or second browser. The kiosk shows the branded welcome screen.
7. Revoke the device in the app; the kiosk shows "This kiosk is not set up" on its
   next action. Re-issue and pair again.
8. Walk-in: register a visitor; it appears as "expected"; admit it at reception;
   a badge code is issued. Check out at the kiosk with the code and the last four
   phone digits.
9. Appointment: book for today, approve, check in at the kiosk by phone.
10. Wrong guesses: fail the badge check-out 5 times on one visit; the correct digits
    are then refused and reception can still check the visitor out.
11. Staff: set a staff number and PIN, clock in and out at the kiosk. Camera
    prompt appears for an ID-scan field (browser permission, no CSP console errors).

Invitations and files
12. Create an invitation link; open it in a private window (no sign-in); submit
    details; upload a photo or ID scan; the host sees the appointment. The same link
    opened again says unavailable.
13. With `APP_BASE_URL` set, the link in the notification points at the production
    domain.

Messaging (only when providers are live)
14. Send a test message from Messages, Settings to your own phone and email; the
    outbox shows `sent`; a delivery receipt (if configured) moves it to `delivered`.

Operations
15. Open Reports, run a CSV export, open it in a spreadsheet: no cell starts with
    `=`, `+`, `-` or `@`. Open the audit log: the export and the check-ins are there.
16. Convex dashboard, Logs: no errors in the last 30 minutes; Backups shows the
    schedule is on. Vercel, Firewall: rules active.
17. Billing and plan enforcement: follow the checklist in `docs/billing.md`.

If any step fails, stop the launch and use the rollback in section 6.

## 8. Observability and runbook

### What exists in the code

- `convex/lib/log.ts`: one JSON line per event with a fixed set of fields
  (`event`, `fn`, `outcome`, `org` id, `code`, `count`, `durationMs`, `requestId`).
  It cannot carry names, phone numbers, emails, tokens or answers, and redacts
  anything that looks like them. Events emitted today: `rate_limited`
  (`fn: publicLimit.<scope>` or `kiosk.meter`), `kiosk_lookup_locked`,
  `kiosk_pin_throttled`, `webhook_rejected` (notifications webhook), `outbox_failed`.
  Add new ones with `logEvent("warn", { event: "...", fn: "..." })`.
- `GET /api/health`: shallow (public) and deep (token) probes.
- Audit log entries for throttles and lockouts (`kiosk.lookup_throttled`,
  `kiosk.pin_throttled`, `visit.kiosk_checkout_locked`, `attendance.pin_locked`).

### Where to send it (no vendor is installed)

- **Convex logs and errors**: dashboard Logs, `npx convex logs --prod`. For
  retention and alerting, configure a **log stream** (Axiom, Datadog or a webhook
  sink) in Convex dashboard, Settings, Integrations, and the **Sentry** integration
  for uncaught function exceptions, where your plan supports them. Filter the stream
  on `app:"wageni"` to get the structured events above.
- **Vercel**: Runtime Logs for the route handlers and pages; a **Log Drain** to the
  same destination for retention; Observability for 5xx and latency.
- **Browser and Next errors**: to add Sentry later, install `@sentry/nextjs`,
  create `instrumentation.ts` (`register()` that calls `Sentry.init`) and
  `instrumentation-client.ts`, wrap `next.config.ts` with `withSentryConfig`, and
  add the Sentry ingest host to `connect-src` in `lib/security/headers.ts`. Set
  `sendDefaultPii: false` and add a `beforeSend` that drops request bodies, since
  kiosk calls carry phone numbers and PINs. Until then `app/error.tsx` shows a
  generic message and the platform logs the stack.

### Alerts to create

| Alert | Signal | Threshold (start here) | First response |
| --- | --- | --- | --- |
| Site down | Uptime monitor on `/api/health` (every 1 min) and `?deep=1` (every 5 min, with the bearer token) | 2 consecutive failures | Check Vercel status and deployment; Convex status; roll back (section 6) |
| 5xx rate | Vercel Observability or log drain: status >= 500 | > 1% of requests for 5 min | Runtime logs for the route; roll back if it follows a deploy |
| Convex function errors | Convex log stream / Sentry | > 10 errors in 5 min, or any error from a cron | `npx convex logs --prod`; find the function; roll back or hotfix |
| Webhook failures | `event:"webhook_rejected"` | > 5 in 10 min (a misconfigured provider, or probing) | Verify `NOTIFY_WEBHOOK_SECRET` matches the provider; if probing, ignore (they are rejected). Billing webhook checks: `docs/billing.md` |
| Outbox failures | `event:"outbox_failed"`, and Messages page shows failed rows | > 5 in 15 min | Provider status page; credentials; sender approval; retry from Messages |
| Cron lag | Convex dashboard, Schedules/Crons: last run older than 3x its interval (`notification outbox retry` 10 min, `abandoned upload sweep` 30 min); plus a log-stream alert on **absence** of the daily `retention.purged` or `form_answers.redacted` audit actions for 2 days | see left | Look for a failing run in logs; re-run the internal function by hand (`npx convex run ... --prod`) |
| Rate-limit spike | `event:"rate_limited"` grouped by `fn` | > 100 per 5 min overall, or any single `org` > 50 | Expected from a hostile kiosk or bot: check which scope; tighten the Vercel rule; revoke the device if it belongs to one organization |
| Lockouts | `kiosk_lookup_locked` / `kiosk_pin_throttled` | > 5 per hour for one org | Possible guessing at a kiosk: review the audit log with the organization; revoke or re-pair the device |
| Backup missing | Convex dashboard Backups; calendar check | No backup in 26 hours | Run a manual export (section 9) and open a ticket with Convex |
| Certificates and domains | Vercel domain status; Clerk DNS verification | Any warning | Fix DNS before expiry |

### Incident basics

1. Declare, note the time, find the last deploy.
2. Contain: Vercel "Attack Challenge Mode" for floods; revoke a kiosk device; set an
   organization to `suspended` from the platform console for abuse; rotate a secret
   (below).
3. Roll back if the cause is a release (section 6).
4. A suspected personal-data breach: the Data Protection Act 2019 requires telling
   the Office of the Data Protection Commissioner within 72 hours and the affected
   people without delay where there is a high risk. Keep the audit log, Convex logs
   and the timeline; take a backup of the affected state first.

### Rotating secrets

| Secret | How |
| --- | --- |
| Clerk keys | New keys in Clerk, update Vercel, redeploy |
| `INVITE_PROXY_SECRET` | Set the **same new value** in Convex and Vercel, redeploy; invitation pages return 503 for the minutes in between |
| `NOTIFY_WEBHOOK_SECRET` | Change in Convex and at the provider together |
| Provider keys | Replace in Convex; no deploy needed |
| Kiosk device token | Revoke the device and issue a new one |
| Convex deploy key | Regenerate in the dashboard, update Vercel |

## 9. Backups, restore and data lifecycle

### What is backed up

Convex stores documents, indexes and **file storage** (uploaded IDs, photos).
Two mechanisms:

- **Cloud backups** (dashboard, Backups): scheduled by Convex, restorable from the
  dashboard. Turn on the daily schedule for production; check retention for your
  plan.
- **Manual snapshot export** with the CLI, which you control and can store off
  Convex:

```bash
npx convex export --prod --include-file-storage --path backup-$(date +%Y%m%d-%H%M).zip
```

The zip holds every table (JSONL per table) and the file blobs. It contains
**personal data and sensitive files**: store it encrypted (for example `age` or
GPG, or an encrypted bucket), restrict who can read it, and delete it when its
retention ends. Never commit it or attach it to a ticket.

Restore into a **new or empty** deployment first, never straight onto production:

```bash
npx convex import --replace backup-YYYYMMDD-HHMM.zip          # onto the linked (non-prod) deployment
npx convex import --replace --prod backup-YYYYMMDD-HHMM.zip   # last resort: replaces production data
```

`--replace` wipes the tables in the zip before importing; `--append` adds rows and
keeps what is there (use it for a single table recovered into a scratch
deployment). Env variables, deployed code and cron schedules are not in the export:
they come from `convex deploy` and section 2.

### Suggested objectives

| | Suggestion | How |
| --- | --- | --- |
| RPO (data you can lose) | 24 hours at launch; 1 hour once the product is critical | Daily cloud backup plus a nightly CLI export; move to point-in-time recovery or hourly exports when you need 1 hour |
| RTO (time to restore) | 4 hours | The drill below, measured |

### Restore drill (do before launch, then every quarter)

1. Take a manual export of production (above). Record the size and the time taken.
2. Create a scratch Convex deployment (or use a preview). Set its environment
   variables as in section 2 *without* provider keys (so nothing sends messages).
3. `npx convex deploy` the same commit, then `npx convex import --replace` the zip.
4. Point a preview Vercel deployment at it (`NEXT_PUBLIC_CONVEX_URL`) and a Clerk
   **development** instance. Users from production will not exist in that Clerk
   instance; check data through the platform console or `npx convex data`.
5. Verify: row counts per table match the source (`npx convex data <table>`); an
   organization's visits, appointments, audit entries and attendance are present;
   a sample file opens (file storage came across).
6. Run the retention job in dry-run: `npx convex run retention:purgeExpired
   '{"organizationId":"<id>","dryRun":true}'` and confirm it behaves.
7. Write down the elapsed time (your measured RTO), anything that surprised you,
   and delete the scratch deployment and the decrypted zip.

### What a restore resurrects (read before restoring)

A restore brings back everything that existed at the snapshot, including data that
was **deleted since**:

- Visitors, visits and attendance purged by retention, and visitors erased on
  request, **reappear**. After any restore, re-run the retention sweep and replay
  the erasure requests recorded in your own request log (the audit log of the
  restored snapshot will not contain deletions made after it). Keep an off-system
  register of erasure requests (date, subject reference, outcome) for this reason.
- Revoked kiosk devices and removed members at the time of the snapshot are active
  again if they were active then. Review devices and members, revoke what should
  stay revoked.
- Pending outbox rows can send again once providers are configured; keep provider
  keys unset until the outbox has been reviewed (`status: queued` rows).
- Rate-limit counters and lockouts are restored too (harmless).
- Anything written after the snapshot is lost: invitations created, check-ins,
  clock events. Reconcile with paper or the kiosk history if the gap matters.

### Retention and its interaction with backups

Retention (Retention page) anonymises visits after the configured period (min 30
days), deletes audit and attendance after 1 year minimum, redacts form answers per
field and deletes files by `deleteAfter`. **Backups keep the old data until the
backup itself expires.** State your backup retention in the privacy notice, and keep
the CLI exports no longer than the longest retention you promise (30 to 90 days is
typical). Deleting a record in the app is not deleting it from last week's backup.

### Data subject requests (Kenya Data Protection Act 2019)

The organization that runs the kiosk is the data controller; Wageni is its
processor. The organization's **owner** performs requests in the app's backend
functions (no UI yet), always as the signed-in owner:

Access (copy of a person's data)
1. Verify the requester's identity outside the system.
2. Find the visitor. Export the tables (one call per table, repeating with the
   returned `nextCursor` until `done`):
   `dataRights.exportChunk({ organizationId, table: "visitors" | "visits" | "appointments" | "attendance" | "formResponses" | "audit" | "members" | "sites" | "gates", cursor, limit })`.
   Filter the rows to the person on your side. Contact details are included only
   for holders of `forms:read_sensitive`; answers to sensitive fields and files are
   shown as `[withheld]`, so reveal those through the app's audited "reveal"
   action if the request covers them. Every call writes an
   `organization.data_exported` audit entry.
3. Reply within the statutory period (30 days under the Act; confirm with counsel).

Erasure
1. Verify identity. Check nothing requires keeping the record (an open incident,
   a legal hold).
2. `dataRights.eraseVisitor({ organizationId, visitorId })` (owner only). It refuses
   while the person is on site, expected or has an upcoming appointment. It
   anonymises the visitor row, clears badge codes, replaces visit and appointment
   free text with "Erased on request", tombstones their form answers and schedules
   their uploaded files for deletion by the daily file job. Call again if it
   returns `done: false`. It writes a `visitor.erased` audit entry with counts only.
3. Not covered automatically: notification outbox rows that hold the person's phone
   or email (deleted by the 90 day outbox purge, or sooner by the retention
   setting), appointment `decisionNote`s that name them (cleared by the function),
   exports you already made, and **backups** (see above; they expire).
4. Log the request in your off-system register.

Correction is done in the app by editing the visitor or appointment.

Tenant offboarding (a customer leaves)
1. Export every table with `exportChunk` and hand over the data.
2. Suspend the organization (platform console) and revoke kiosk devices.
3. Delete: there is no "delete organization" function yet. Until there is, anonymise
   with retention set to its minimum and run `retention:purgeExpired`, or schedule a
   reviewed one-off internal mutation. Backups expire as above.

### What is NOT automated yet

- A UI for export and erasure (backend functions only).
- A "delete organization" operation and bulk offboarding.
- Erasure of outbox rows by person.
- Rehearsed restore: the drill above has not been run against production.
- Automatic expiry of CLI exports (your storage policy has to do it).
- Cron-lag alerting: you must configure it in your monitoring (section 8).
- An independent security review and a Data Protection Impact Assessment (the Act
  expects one for large-scale processing of personal data; registration with the
  ODPC as a data controller or processor is also yours to complete).

## 10. Pre-launch security checklist

Secrets and configuration
- [ ] No secret in the repo or its history (`git log -p | grep` scan done at H1;
      repeat before launch). `.env*` ignored.
- [ ] Production variables set per section 2; `ALLOW_*` development switches unset on
      the production Convex deployment.
- [ ] `INVITE_PROXY_SECRET` identical in Vercel and Convex; invitation link works
      from a private window; `APP_BASE_URL` set.
- [ ] `CLERK_JWT_ISSUER_DOMAIN` is the production issuer; sign-in works end to end.
- [ ] Production Clerk instance has verified DNS, bot protection and email
      verification on.
- [ ] `NOTIFY_WEBHOOK_SECRET` set only if the receipt relay is in use.
- [ ] Billing checklist in `docs/billing.md` done.

Web
- [ ] CSP rolled out (report-only first), no violations on sign-in, kiosk, invite,
      upload and camera flows.
- [ ] HSTS active on the production host; `preload` only after the domain is final.
- [ ] Vercel Firewall rules from `docs/security.md` created; Preview protected.
- [ ] `/api/health` monitored.

Data and access
- [ ] Platform operators (`super_admin`) are the intended people only
      (`users` with `platformRole`), MFA on.
- [ ] Every organization has an owner who understands the kiosk token and PIN rules.
- [ ] Retention periods agreed with each customer and set; privacy notice text on
      each kiosk names the purpose, the retention period and the backup delay.
- [ ] Backups on, drill run, encrypted export storage chosen.
- [ ] Alerts in section 8 created and test-fired once.
- [ ] Data protection registration, DPIA and processor agreement with customers done
      (legal, not code).

Code
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:e2e` green
      on the release commit; CI green on GitHub.
- [ ] `pnpm audit` reviewed (section 11).
- [ ] An independent penetration test or review scheduled for the kiosk, invitation
      and tenant boundary.

## 11. Dependencies and audit

`pnpm audit` runs in CI as an informational job (it never fails the build). State at
H1: one finding, **high**, `braces` <= 3.0.3 (GHSA-vfj7-8cjw-p6xm, stack exhaustion on
deeply nested glob patterns), reached only through `eslint-config-next` and the
`shadcn` CLI (both dev tooling; neither is in the production bundle). No patched
version has been published, so there is nothing to upgrade to: revisit on every
dependency update, and add an `overrides` entry the day `braces` >= 3.0.4 exists.
`shadcn` sits in `dependencies`; moving it to `devDependencies` is safe only after
confirming `app/globals.css` does not import from it at runtime build.

## 12. CI on GitHub

`.github/workflows/ci.yml` has three jobs: `check` (install, `next typegen`,
typecheck, lint, Vitest), `e2e` (build and Playwright with cached browsers and Next
cache) and `audit` (informational). No secrets are needed for pull-request runs: the
site and tests run without Clerk or Convex credentials. It could not be run on
GitHub from the hardening branch; the same commands were run locally in the same
order. Make `check` and `e2e` required checks on `main` once the first run is green.
