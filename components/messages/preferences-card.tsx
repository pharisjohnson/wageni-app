"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";
import { CHANNEL_LABELS, CHANNELS, type Channel } from "@/lib/notifications/templates";
import type { FunctionReturnType } from "convex/server";

type Prefs = FunctionReturnType<typeof api.notifications.myPreferences>;

function toTime(min: number | null) {
  if (min === null) return "";
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function fromTime(value: string) {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

function Form({ initial }: { initial: Prefs }) {
  const { organizationId } = useActiveOrg();
  const save = useMutation(api.notifications.updateMyPreferences);
  const [phone, setPhone] = useState(initial.phone);
  const [start, setStart] = useState(toTime(initial.quietStartMin));
  const [end, setEnd] = useState(toTime(initial.quietEndMin));
  const [events, setEvents] = useState(initial.events);
  const [saving, setSaving] = useState(false);

  function toggle(eventType: string, channel: Channel, on: boolean) {
    setEvents((list) => list.map((e) => (e.eventType === eventType ? { ...e, [channel]: on } : e)));
  }

  async function onSave() {
    setSaving(true);
    try {
      await save({
        organizationId,
        phone,
        events: Object.fromEntries(
          events.map((e) => [e.eventType, { email: e.email, sms: e.sms, whatsapp: e.whatsapp }]),
        ),
        quietStartMin: fromTime(start),
        quietEndMin: fromTime(end),
      });
      toast.success("Notification preferences saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>My notifications</CardTitle>
        <CardDescription>
          Choose how you hear about visitors, appointments and attendance. SMS and WhatsApp need a phone number and must
          be switched on by your organization. Messages that arrive during quiet hours are not sent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="max-w-sm space-y-1.5">
          <label htmlFor="pref-phone" className="text-sm font-medium">
            My phone number
          </label>
          <Input
            id="pref-phone"
            inputMode="tel"
            value={phone}
            placeholder="+254700000000"
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Message</th>
                {CHANNELS.map((c) => (
                  <th key={c} className="px-3 py-2 font-medium">
                    {CHANNEL_LABELS[c]}
                    {!initial.orgChannels.includes(c) && (
                      <span className="block text-xs font-normal text-muted-foreground">off for organization</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {events.map((e) => (
                <tr key={e.eventType}>
                  <td className="px-3 py-2">{e.label}</td>
                  {CHANNELS.map((c) => (
                    <td key={c} className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="size-4"
                        aria-label={`${e.label} by ${CHANNEL_LABELS[c]}`}
                        checked={e[c]}
                        onChange={(ev) => toggle(e.eventType, c, ev.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Quiet hours (your organization&apos;s time zone)</legend>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Input type="time" aria-label="Quiet hours start" className="w-32" value={start} onChange={(e) => setStart(e.target.value)} />
            <span>to</span>
            <Input type="time" aria-label="Quiet hours end" className="w-32" value={end} onChange={(e) => setEnd(e.target.value)} />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setStart("");
                setEnd("");
              }}
            >
              Clear
            </Button>
          </div>
        </fieldset>

        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving..." : "Save preferences"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function NotificationPreferencesCard() {
  const { organizationId } = useActiveOrg();
  const prefs = useQuery(api.notifications.myPreferences, { organizationId });
  if (prefs === undefined) return <Skeleton className="h-64 w-full" />;
  return <Form key={organizationId} initial={prefs} />;
}
