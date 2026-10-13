"use client";

import Link from "next/link";
import { OutboxHistory, StatsCards } from "@/components/messages/outbox-history";
import { PageHeader } from "@/components/layout/page-header";
import { buttonVariants } from "@/components/ui/button";
import { useActiveOrg } from "@/lib/org/active-org";

export default function MessagesPage() {
  const { can } = useActiveOrg();
  if (!can("messages:read")) {
    return <p className="text-muted-foreground">You do not have access to message history.</p>;
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title="Messages"
        description="Emails, SMS and WhatsApp messages sent to hosts, staff and visitors."
        actions={
          <>
            <Link href="/app/messages/settings" className={buttonVariants({ variant: "outline" })}>
              Channels and wording
            </Link>
            {can("integrations:manage") && (
              <Link href="/app/integrations" className={buttonVariants({ variant: "outline" })}>
                Integrations
              </Link>
            )}
          </>
        }
      />
      <StatsCards />
      <OutboxHistory />
    </div>
  );
}
