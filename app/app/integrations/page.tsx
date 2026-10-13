"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { UpgradeNotice, useEntitlements } from "@/components/billing/upgrade-notice";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";
import { CHANNEL_LABELS, CHANNELS, type Channel } from "@/lib/notifications/templates";

const ENV_HELP: Record<Channel, string> = {
  email: "NOTIFY_EMAIL_PROVIDER=resend, RESEND_API_KEY, NOTIFY_EMAIL_FROM",
  sms: "NOTIFY_SMS_PROVIDER=africastalking, AT_USERNAME, AT_API_KEY (optional AT_SENDER_ID)",
  whatsapp: "NOTIFY_WHATSAPP_PROVIDER=cloudapi, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN",
};

function ChannelCard({ channel, status }: { channel: Channel; status: NonNullable<ReturnType<typeof useConfig>>["channels"][Channel] }) {
  const { organizationId } = useActiveOrg();
  const sendTest = useMutation(api.notifications.sendTest);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  async function onTest() {
    setBusy(true);
    try {
      await sendTest({ organizationId, channel, ...(channel === "email" ? {} : { phone }) });
      toast.success(
        status.mode === "live"
          ? "Test message sent. Check your inbox or phone."
          : "Test message recorded in test mode. Nothing was sent. See Messages.",
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{CHANNEL_LABELS[channel]}</CardTitle>
          <Badge variant={status.mode === "live" ? "default" : "secondary"}>
            {status.mode === "live" ? `Live (${status.provider})` : "Test mode"}
          </Badge>
        </div>
        <CardDescription>
          {status.mode === "live"
            ? "Messages on this channel are sent through your provider."
            : status.requested
              ? `A provider is selected but not fully configured. Missing: ${status.missing.join(", ")}.`
              : "No provider is configured, so messages are recorded in the history but not sent."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Set in the Convex dashboard (Environment Variables): {ENV_HELP[channel]}. Values are never shown here.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          {channel !== "email" && (
            <div className="space-y-1">
              <label htmlFor={`test-${channel}`} className="text-sm font-medium">
                My phone number
              </label>
              <Input
                id={`test-${channel}`}
                inputMode="tel"
                className="w-52"
                placeholder="+254700000000"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          )}
          <Button variant="outline" onClick={onTest} disabled={busy || (channel !== "email" && !phone.trim())}>
            {channel === "email" ? "Send a test to my email" : "Send a test to my number"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function useConfig() {
  const { organizationId, can } = useActiveOrg();
  return useQuery(api.notifications.channelConfig, can("integrations:manage") ? { organizationId } : "skip");
}

function WebhooksCard() {
  const ent = useEntitlements();
  if (ent === undefined) return null;
  if (ent.enforced && !ent.features.includes("webhooks_integrations")) {
    return (
      <UpgradeNotice
        title="Webhooks and integrations are not in your plan"
        message="Outbound webhooks and third-party integrations are part of the Enterprise plan."
      />
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhooks and integrations</CardTitle>
        <CardDescription>Included in your plan. Outbound webhooks are not built yet; nothing to configure.</CardDescription>
      </CardHeader>
    </Card>
  );
}

export default function IntegrationsPage() {
  const { can } = useActiveOrg();
  const config = useConfig();
  if (!can("integrations:manage")) {
    return <p className="text-muted-foreground">You do not have access to integrations.</p>;
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Email, SMS and WhatsApp providers. Credentials live in server environment variables, never in the app."
        actions={
          <Link href="/app/messages" className={buttonVariants({ variant: "outline" })}>
            Message history
          </Link>
        }
      />
      {config === undefined ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {CHANNELS.map((c) => (
              <ChannelCard key={c} channel={c} status={config.channels[c]} />
            ))}
          </div>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Delivery receipts</CardTitle>
                <Badge variant={config.webhookConfigured ? "default" : "secondary"}>
                  {config.webhookConfigured ? "Enabled" : "Off"}
                </Badge>
              </div>
              <CardDescription>
                Providers can report delivered, read or failed to <code>/webhooks/notifications</code> on your Convex
                site URL, signed with <code>NOTIFY_WEBHOOK_SECRET</code>. Without the secret the endpoint is switched off.
              </CardDescription>
            </CardHeader>
          </Card>
          <WebhooksCard />
        </>
      )}
    </div>
  );
}
