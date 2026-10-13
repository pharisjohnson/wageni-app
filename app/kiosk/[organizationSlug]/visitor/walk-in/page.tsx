"use client";

import { useEffect, useState, type FormEvent } from "react";
import { KioskDeviceGate } from "@/components/kiosk/kiosk-device-gate";
import { useKioskOrg } from "@/components/kiosk/kiosk-frame";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { friendlyKioskError, KioskUnpairedError, useKioskApi } from "@/lib/kiosk/use-kiosk-api";
import { kioskWalkInSchema } from "@/lib/validation/visits";
import { KioskButton, KioskDone, KioskField, KioskMessage, KioskPanel } from "../_components/kiosk-ui";

type Host = { userId: Id<"users">; name: string };
type Fields = "name" | "phone" | "company" | "purpose" | "host";

function WalkIn() {
  const org = useKioskOrg();
  const kiosk = useKioskApi(org.slug);
  const { query } = kiosk;
  // Personal data lives in React state only; leaving the screen discards it.
  const [form, setForm] = useState({ name: "", phone: "", company: "", purpose: "", hostId: "" });
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ firstName: string; hostName: string } | null>(null);

  useEffect(() => {
    let live = true;
    query(api.kioskVisitor.hosts, {})
      .then((list) => live && setHosts(list))
      .catch(() => live && setHosts([]));
    return () => {
      live = false;
    };
  }, [query]);

  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = kioskWalkInSchema.safeParse(form);
    const next: Partial<Record<Fields, string>> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as Fields;
        next[key] ??= issue.message;
      }
    }
    if (!form.hostId) next.host = "Choose who you are here to see.";
    setErrors(next);
    if (!parsed.success || !form.hostId) return;

    setBusy(true);
    try {
      const res = await kiosk.mutation(api.kioskVisitor.registerWalkIn, {
        visitor: { name: parsed.data.name, phone: parsed.data.phone, company: parsed.data.company || undefined },
        purpose: parsed.data.purpose,
        hostUserId: form.hostId as Id<"users">,
      });
      setDone({ firstName: res.firstName, hostName: res.hostName });
      setForm({ name: "", phone: "", company: "", purpose: "", hostId: "" });
    } catch (err) {
      if (!(err instanceof KioskUnpairedError)) setFormError(friendlyKioskError(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <KioskDone title={`Thank you, ${done.firstName}`}>
        <p>You are registered to see {done.hostName}.</p>
        <p className="text-base text-muted-foreground">
          Please wait nearby. Reception or security will admit you and give you a badge.
        </p>
      </KioskDone>
    );
  }

  const notice = org.branding.privacyNotice;
  return (
    <KioskPanel title="Welcome! Please register">
      <form onSubmit={submit} className="space-y-5" noValidate>
        <KioskField
          id="name"
          label="Your name"
          autoComplete="off"
          value={form.name}
          onChange={(e) => set("name")(e.target.value)}
          error={errors.name}
        />
        <KioskField
          id="phone"
          label="Phone number"
          hint="You will need the last 4 digits to sign out."
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={form.phone}
          onChange={(e) => set("phone")(e.target.value)}
          error={errors.phone}
        />
        <KioskField
          id="company"
          label="Company (optional)"
          autoComplete="off"
          value={form.company}
          onChange={(e) => set("company")(e.target.value)}
          error={errors.company}
        />
        <KioskField
          id="purpose"
          label="Reason for your visit"
          autoComplete="off"
          value={form.purpose}
          onChange={(e) => set("purpose")(e.target.value)}
          error={errors.purpose}
        />
        <div className="space-y-2">
          <Label htmlFor="host" className="text-lg">
            Who are you here to see?
          </Label>
          <NativeSelect
            id="host"
            className="h-14 px-4 text-lg"
            value={form.hostId}
            disabled={hosts === null || hosts.length === 0}
            aria-invalid={errors.host ? true : undefined}
            onChange={(e) => set("hostId")(e.target.value)}
          >
            <option value="">{hosts === null ? "Loading..." : "Choose a person"}</option>
            {(hosts ?? []).map((h) => (
              <option key={h.userId} value={h.userId}>
                {h.name}
              </option>
            ))}
          </NativeSelect>
          {hosts?.length === 0 && (
            <p className="text-base text-muted-foreground">No one is available to choose here. Please ask reception.</p>
          )}
          {errors.host && <p className="text-base text-destructive">{errors.host}</p>}
        </div>
        {notice && (
          <section aria-label="Privacy notice" className="space-y-1 rounded-xl bg-muted p-4 text-sm">
            <h2 className="font-semibold">Privacy notice</h2>
            <p className="whitespace-pre-line text-muted-foreground">{notice}</p>
          </section>
        )}
        {formError && <KioskMessage>{formError}</KioskMessage>}
        <KioskButton type="submit" className="w-full" disabled={busy || hosts === null}>
          {busy ? "Registering..." : notice ? "I agree, register me" : "Register me"}
        </KioskButton>
      </form>
    </KioskPanel>
  );
}

export default function KioskVisitorWalkInPage() {
  return (
    <KioskDeviceGate>
      <WalkIn />
    </KioskDeviceGate>
  );
}
