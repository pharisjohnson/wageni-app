"use client";

import { useState, type FormEvent } from "react";
import { KioskDeviceGate } from "@/components/kiosk/kiosk-device-gate";
import { useKioskOrg } from "@/components/kiosk/kiosk-frame";
import { api } from "@/convex/_generated/api";
import { friendlyKioskError, KioskUnpairedError, useKioskApi } from "@/lib/kiosk/use-kiosk-api";
import { kioskCheckOutSchema } from "@/lib/validation/visits";
import { KioskButton, KioskDone, KioskField, KioskMessage, KioskPanel } from "../_components/kiosk-ui";

const NO_MATCH = "We could not sign you out with those details. Please check them, or ask reception for help.";
const LOCKED = "Too many tries on this screen. Please ask reception for help.";

function CheckOut() {
  const { slug } = useKioskOrg();
  const kiosk = useKioskApi(slug);
  const [badgeCode, setBadgeCode] = useState("");
  const [phoneLast4, setPhoneLast4] = useState("");
  const [errors, setErrors] = useState<{ badgeCode?: string; phoneLast4?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = kioskCheckOutSchema.safeParse({ badgeCode, phoneLast4 });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof typeof next;
        next[key] ??= issue.message;
      }
      return setErrors(next);
    }
    setErrors({});
    setBusy(true);
    try {
      const res = await kiosk.mutation(api.kioskVisitor.checkOut, parsed.data);
      if (res.status === "ok") {
        setDone(res.firstName);
        setBadgeCode("");
        setPhoneLast4("");
      } else {
        setError(res.status === "locked" ? LOCKED : NO_MATCH);
      }
    } catch (err) {
      if (!(err instanceof KioskUnpairedError)) setError(friendlyKioskError(err));
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <KioskDone title={`Goodbye, ${done}`}>
        <p>You are signed out. Thank you for visiting.</p>
      </KioskDone>
    );
  }

  const digits = (setter: (v: string) => void, max: number) => (e: { target: { value: string } }) =>
    setter(e.target.value.replace(/\D/g, "").slice(0, max));

  return (
    <KioskPanel title="Sign out">
      <form onSubmit={submit} className="space-y-6" noValidate>
        <KioskField
          id="badge"
          label="Code on your badge"
          hint="6 digits"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          maxLength={6}
          value={badgeCode}
          onChange={digits(setBadgeCode, 6)}
          error={errors.badgeCode}
          className="font-mono tracking-widest"
        />
        <KioskField
          id="last4"
          label="Last 4 digits of your phone number"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={phoneLast4}
          onChange={digits(setPhoneLast4, 4)}
          error={errors.phoneLast4}
          className="font-mono tracking-widest"
        />
        {error && <KioskMessage>{error}</KioskMessage>}
        <KioskButton type="submit" className="w-full" disabled={busy}>
          {busy ? "Signing out..." : "Sign me out"}
        </KioskButton>
      </form>
    </KioskPanel>
  );
}

export default function KioskVisitorCheckOutPage() {
  return (
    <KioskDeviceGate>
      <CheckOut />
    </KioskDeviceGate>
  );
}
