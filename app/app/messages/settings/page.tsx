"use client";

import { PageHeader } from "@/components/layout/page-header";
import { MessageSettings } from "@/components/messages/settings-form";
import { useActiveOrg } from "@/lib/org/active-org";

export default function MessageSettingsPage() {
  const { can } = useActiveOrg();
  return (
    <div className="space-y-6">
      <PageHeader
        title="Channels and wording"
        description="Which channels your organization uses and how each message reads."
        back={{ href: "/app/messages", label: "Messages" }}
      />
      {can("messages:read") ? (
        <MessageSettings />
      ) : (
        <p className="text-muted-foreground">You do not have access to these settings.</p>
      )}
    </div>
  );
}
