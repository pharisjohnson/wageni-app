"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";
import { CHANNEL_LABELS, CHANNELS, EVENT_TYPES, TEMPLATES, type Channel } from "@/lib/notifications/templates";

type Status = "queued" | "sent" | "failed" | "skipped";

const STATUS_VARIANT: Record<Status, "default" | "secondary" | "destructive" | "outline"> = {
  sent: "default",
  queued: "secondary",
  failed: "destructive",
  skipped: "outline",
};

const SKIP_REASON: Record<string, string> = {
  quiet_hours: "Quiet hours",
  rate_limited: "Hourly limit reached",
  organization_unavailable: "Organization unavailable",
};

function fmt(at: number) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));
}

export function StatsCards() {
  const { organizationId } = useActiveOrg();
  const stats = useQuery(api.notifications.stats, { organizationId });
  if (stats === undefined) return <Skeleton className="h-28 w-full" />;
  return (
    <section aria-label="Messages in the last 7 days" className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["sent", "queued", "failed", "skipped"] as const).map((s) => (
          <div key={s} className="rounded-lg border p-3">
            <p className="text-2xl font-semibold tabular-nums">{stats.total[s]}</p>
            <p className="text-sm capitalize text-muted-foreground">{s} (7 days)</p>
          </div>
        ))}
      </div>
      {stats.events.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Message</th>
                <th className="px-3 py-2 font-medium">Sent</th>
                <th className="px-3 py-2 font-medium">Queued</th>
                <th className="px-3 py-2 font-medium">Failed</th>
                <th className="px-3 py-2 font-medium">Skipped</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {stats.events.map((e) => (
                <tr key={e.eventType}>
                  <td className="px-3 py-2">{e.label}</td>
                  <td className="px-3 py-2 tabular-nums">{e.sent}</td>
                  <td className="px-3 py-2 tabular-nums">{e.queued}</td>
                  <td className="px-3 py-2 tabular-nums">{e.failed}</td>
                  <td className="px-3 py-2 tabular-nums">{e.skipped}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function OutboxHistory() {
  const { organizationId, can } = useActiveOrg();
  const [status, setStatus] = useState<Status | "">("");
  const [channel, setChannel] = useState<Channel | "">("");
  const [eventType, setEventType] = useState("");
  const rows = useQuery(api.notifications.listOutbox, {
    organizationId,
    ...(status ? { status } : {}),
    ...(channel ? { channel } : {}),
    ...(eventType ? { eventType } : {}),
  });
  const retry = useMutation(api.notifications.retry);
  const [busy, setBusy] = useState<Id<"notificationOutbox"> | null>(null);

  async function onRetry(outboxId: Id<"notificationOutbox">) {
    setBusy(outboxId);
    try {
      await retry({ organizationId, outboxId });
      toast.success("Message queued again");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3" aria-label="Message history">
      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="f-status">
          Status
        </label>
        <NativeSelect id="f-status" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value as Status | "")}>
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="queued">Queued</option>
          <option value="failed">Failed</option>
          <option value="skipped">Skipped</option>
        </NativeSelect>
        <label className="sr-only" htmlFor="f-channel">
          Channel
        </label>
        <NativeSelect id="f-channel" className="w-auto" value={channel} onChange={(e) => setChannel(e.target.value as Channel | "")}>
          <option value="">All channels</option>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABELS[c]}
            </option>
          ))}
        </NativeSelect>
        <label className="sr-only" htmlFor="f-event">
          Message type
        </label>
        <NativeSelect id="f-event" className="w-auto" value={eventType} onChange={(e) => setEventType(e.target.value)}>
          <option value="">All message types</option>
          {EVENT_TYPES.map((e) => (
            <option key={e} value={e}>
              {TEMPLATES[e].label}
            </option>
          ))}
        </NativeSelect>
      </div>

      {rows === undefined ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground">No messages match these filters yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((r) => (
            <li key={r._id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">{r.label}</p>
                <p className="text-sm text-muted-foreground">
                  {CHANNEL_LABELS[r.channel]} to {r.recipient}
                  {r.to ? ` (${r.to})` : ""} · {fmt(r.createdAt)}
                  {r.mode === "dry_run" ? " · test mode, not really sent" : ""}
                </p>
                {(r.lastError || r.deliveryStatus) && (
                  <p className="text-xs text-muted-foreground">
                    {r.deliveryStatus ? `Provider: ${r.deliveryStatus}` : ""}
                    {r.deliveryStatus && r.lastError ? " · " : ""}
                    {r.lastError ? (SKIP_REASON[r.lastError] ?? r.lastError) : ""}
                    {r.attempts > 1 ? ` · ${r.attempts} attempts` : ""}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                {r.status === "failed" && can("integrations:manage") && (
                  <Button size="sm" variant="outline" disabled={busy === r._id} onClick={() => onRetry(r._id)}>
                    Retry
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
