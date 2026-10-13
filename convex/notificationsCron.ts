import { v } from "convex/values";
import { effectivePermissions } from "../lib/permissions";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { enqueueNotification } from "./lib/notify";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Visitors are reminded when their approved appointment starts within this long. */
export const REMINDER_LEAD_MS = HOUR;
/** A clock-in with no clock-out after this long prompts the person. */
export const MISSED_CLOCK_OUT_AFTER_MS = 12 * HOUR;
/** Corrections still pending after this long alert managers (once a day). */
export const CORRECTION_ALERT_AFTER_MS = DAY;
/** A queued message untouched for this long is re-scheduled by the retry cron. */
export const STALE_AFTER_MS = 5 * MIN;
export const OUTBOX_RETENTION_MS = 90 * DAY;
const BATCH = 100;

/** Appointment reminders for approved appointments starting within the lead time. */
export const scanReminders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("appointments")
      .withIndex("by_status_start", (q) =>
        q.eq("status", "approved").gte("scheduledStart", now).lt("scheduledStart", now + REMINDER_LEAD_MS),
      )
      .take(200);
    for (const appt of due) {
      const [visitor, host, site, org] = await Promise.all([
        ctx.db.get(appt.visitorId),
        ctx.db.get(appt.hostUserId),
        ctx.db.get(appt.siteId),
        ctx.db.get(appt.organizationId),
      ]);
      if (!visitor || !org || visitor.organizationId !== appt.organizationId) continue;
      const when = new Intl.DateTimeFormat("en-GB", {
        timeZone: site?.timeZone ?? org.timeZone,
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(appt.scheduledStart));
      await enqueueNotification(ctx, {
        organizationId: appt.organizationId,
        siteId: appt.siteId,
        eventType: "appointment_reminder",
        recipient: { kind: "visitor", email: visitor.email, phone: visitor.phone },
        data: {
          firstName: visitor.name.trim().split(/\s+/)[0] ?? "",
          orgName: org.name,
          when,
          hostName: host?.name ?? "your host",
        },
        // One reminder per appointment time; a reschedule earns a new one.
        key: `appt_reminder:${appt._id}:${appt.scheduledStart}`,
      });
    }
  },
});

/** Fan out the staff scan: one mutation per organization keeps each transaction small. */
export const scanStaff = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Up to 500 organizations per run; revisit with pagination beyond that.
    const orgs = await ctx.db.query("organizations").withIndex("by_created").take(500);
    for (const org of orgs) {
      if (org.status === "suspended") continue;
      await ctx.scheduler.runAfter(0, internal.notificationsCron.scanOrgStaff, { organizationId: org._id });
    }
  },
});

/** Missed clock-out reminders and the pending-corrections manager alert for one organization. */
export const scanOrgStaff = internalMutation({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    const now = Date.now();
    const org = await ctx.db.get(organizationId);
    if (!org) return;

    const sites = await ctx.db
      .query("sites")
      .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
      .take(100);
    for (const site of sites) {
      if (site.status !== "active") continue;
      const events = await ctx.db
        .query("attendanceEvents")
        .withIndex("by_site_at", (q) => q.eq("siteId", site._id).gte("at", now - 36 * HOUR))
        .take(1500);
      const last = new Map<string, (typeof events)[number]>();
      for (const e of events) last.set(e.userId, e); // ascending, so the last write wins
      for (const e of last.values()) {
        if (e.type !== "clock_in" || e.organizationId !== organizationId) continue;
        if (now - e.at < MISSED_CLOCK_OUT_AFTER_MS) continue;
        const since = new Intl.DateTimeFormat("en-GB", {
          timeZone: site.timeZone,
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(new Date(e.at));
        await enqueueNotification(ctx, {
          organizationId,
          siteId: site._id,
          eventType: "missed_clock_out",
          recipient: { kind: "user", userId: e.userId },
          data: { siteName: site.name, since },
          key: `missed_clock_out:${e._id}`,
        });
      }
    }

    const stale = await ctx.db
      .query("attendanceCorrections")
      .withIndex("by_org_status", (q) =>
        q.eq("organizationId", organizationId).eq("status", "pending").lt("createdAt", now - CORRECTION_ALERT_AFTER_MS),
      )
      .take(50);
    if (stale.length > 0) {
      const members = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
        .take(500);
      const day = Math.floor(now / DAY);
      for (const m of members) {
        if (m.status !== "active" || !effectivePermissions(m.role, m.permissionOverrides).has("staff_attendance:correct")) continue;
        // Their own correction is not theirs to decide, so it does not count for them.
        const count = stale.filter((c) => c.userId !== m.userId).length;
        if (count === 0) continue;
        await enqueueNotification(ctx, {
          organizationId,
          eventType: "corrections_pending",
          recipient: { kind: "user", userId: m.userId },
          data: { count: String(count) },
          key: `corrections_pending:${day}:${m.userId}`,
        });
      }
    }
  },
});

/**
 * Re-schedule queued messages that fell through (a lost scheduled call, an
 * action that crashed mid-send). Messages merely waiting out a retry backoff
 * are left alone. Delivery is at-least-once: a crash after the provider
 * accepted a message but before the outcome was saved can send it twice.
 */
export const retryStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("notificationOutbox")
      .withIndex("by_status_created", (q) => q.eq("status", "queued").lt("createdAt", now - STALE_AFTER_MS))
      .take(BATCH);
    for (const r of rows) {
      if (r.nextAttemptAt && now - r.nextAttemptAt < STALE_AFTER_MS) continue;
      if (r.claimedAt && now - r.claimedAt < 2 * MIN) continue;
      await ctx.scheduler.runAfter(0, internal.notificationsDelivery.deliver, { outboxId: r._id });
    }
  },
});

/** Delete settled outbox rows past retention (recipient addresses go with them). */
export const purgeOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - OUTBOX_RETENTION_MS;
    let deleted = 0;
    for (const status of ["sent", "failed", "skipped"] as const) {
      const rows = await ctx.db
        .query("notificationOutbox")
        .withIndex("by_status_created", (q) => q.eq("status", status).lt("createdAt", cutoff))
        .take(BATCH);
      for (const r of rows) await ctx.db.delete(r._id);
      deleted += rows.length;
    }
    if (deleted >= BATCH) await ctx.scheduler.runAfter(0, internal.notificationsCron.purgeOld, {});
  },
});
