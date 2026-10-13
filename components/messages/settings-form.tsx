"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";
import {
  CHANNEL_LABELS,
  CHANNELS,
  EVENT_TYPES,
  MAX_BODY,
  MAX_SUBJECT,
  TEMPLATES,
  type Channel,
  type EventType,
  type TemplateDef,
} from "@/lib/notifications/templates";

type Overrides = Record<string, { subject?: string; body?: string }>;

type Loaded = {
  enabledChannels: Channel[];
  senderName: string;
  templateOverrides: Overrides;
  canEdit: boolean;
};

function Form({ initial }: { initial: Loaded }) {
  const { organizationId } = useActiveOrg();
  const save = useMutation(api.notifications.updateOrgSettings);
  const [channels, setChannels] = useState<Channel[]>(initial.enabledChannels);
  const [sender, setSender] = useState(initial.senderName);
  const [overrides, setOverrides] = useState<Overrides>(initial.templateOverrides);
  const [saving, setSaving] = useState(false);
  const readOnly = !initial.canEdit;

  function setOverride(event: EventType, field: "subject" | "body", value: string) {
    setOverrides((o) => ({ ...o, [event]: { ...o[event], [field]: value } }));
  }

  async function onSave() {
    setSaving(true);
    try {
      await save({
        organizationId,
        enabledChannels: channels,
        senderName: sender,
        templateOverrides: overrides,
      });
      toast.success("Message settings saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
          <CardDescription>
            Messages go out only on the channels you switch on. A person or visitor also needs a matching email address
            or phone number. Staff choose their own channels in their notification preferences.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4">
            {CHANNELS.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  disabled={readOnly}
                  checked={channels.includes(c)}
                  onChange={(e) => setChannels((cur) => (e.target.checked ? [...cur, c] : cur.filter((x) => x !== c)))}
                />
                {CHANNEL_LABELS[c]}
              </label>
            ))}
          </div>
          <div className="max-w-sm space-y-1.5">
            <label htmlFor="sender" className="text-sm font-medium">
              Sender name
            </label>
            <Input
              id="sender"
              value={sender}
              maxLength={40}
              disabled={readOnly}
              placeholder="Defaults to your organization name"
              onChange={(e) => setSender(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Message wording</CardTitle>
          <CardDescription>
            Leave a field empty to use the standard English text. You can use only the placeholders listed under each
            message; they are filled in when the message is sent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {EVENT_TYPES.filter((e) => e !== "test_message").map((e) => {
            const def: TemplateDef = TEMPLATES[e];
            const base = def.messages.en;
            return (
              <fieldset key={e} className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0">
                <legend className="font-medium">{def.label}</legend>
                <p className="text-xs text-muted-foreground">
                  Placeholders: {def.placeholders.map((p) => `{{${p}}}`).join(", ")}
                </p>
                <Input
                  aria-label={`${def.label} subject`}
                  value={overrides[e]?.subject ?? ""}
                  maxLength={MAX_SUBJECT}
                  disabled={readOnly}
                  placeholder={base.subject}
                  onChange={(ev) => setOverride(e, "subject", ev.target.value)}
                />
                <Textarea
                  aria-label={`${def.label} text`}
                  value={overrides[e]?.body ?? ""}
                  maxLength={MAX_BODY}
                  disabled={readOnly}
                  placeholder={base.body}
                  rows={2}
                  onChange={(ev) => setOverride(e, "body", ev.target.value)}
                />
              </fieldset>
            );
          })}
        </CardContent>
      </Card>

      {readOnly ? (
        <p className="text-sm text-muted-foreground">Only people who manage integrations can change these settings.</p>
      ) : (
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving..." : "Save settings"}
        </Button>
      )}
    </div>
  );
}

export function MessageSettings() {
  const { organizationId } = useActiveOrg();
  const settings = useQuery(api.notifications.getOrgSettings, { organizationId });
  if (settings === undefined) return <Skeleton className="h-64 w-full" />;
  // Keyed on the saved copy's identity so the form resets only on organization switch.
  return <Form key={organizationId} initial={settings} />;
}
