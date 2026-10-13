"use client";

import { useState, type FormEvent } from "react";
import { KioskDeviceGate } from "@/components/kiosk/kiosk-device-gate";
import { useKioskOrg } from "@/components/kiosk/kiosk-frame";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { friendlyKioskError, KioskUnpairedError, useKioskApi } from "@/lib/kiosk/use-kiosk-api";
import { kioskPhoneSchema } from "@/lib/validation/visits";
import { KioskButton, KioskDone, KioskField, KioskMessage, KioskPanel } from "../_components/kiosk-ui";

type Match = { appointmentId: Id<"appointments">; firstName: string; hostName: string; startAt: number };
type Done = { firstName: string; hostName: string; badgeCode: string };

const NO_MATCH = "We could not find an appointment for that number today. Please check it, or ask reception for help.";
const LOCKED = "Too many tries on this screen. Please ask reception for help.";

function AppointmentCheckIn() {
  const { slug } = useKioskOrg();
  const kiosk = useKioskApi(slug);
  // Personal data lives in React state only; leaving the screen discards it.
  const [phone, setPhone] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function find(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = kioskPhoneSchema.safeParse(phone);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? NO_MATCH);
    setBusy(true);
    try {
      const res = await kiosk.mutation(api.kioskVisitor.findAppointments, { phone: parsed.data });
      if (res.status === "found") setMatches(res.matches);
      else setError(res.status === "locked" ? LOCKED : NO_MATCH);
    } catch (err) {
      if (!(err instanceof KioskUnpairedError)) setError(friendlyKioskError(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(match: Match) {
    setError(null);
    setBusy(true);
    try {
      const res = await kiosk.mutation(api.kioskVisitor.checkInAppointment, {
        appointmentId: match.appointmentId,
        phone: phone.trim(),
      });
      if (res.status === "ok") {
        setDone({ firstName: res.firstName, hostName: res.hostName, badgeCode: res.badgeCode });
        setPhone("");
        setMatches(null);
      } else {
        setError(res.status === "locked" ? LOCKED : NO_MATCH);
        setMatches(null);
      }
    } catch (err) {
      if (!(err instanceof KioskUnpairedError)) setError(friendlyKioskError(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <KioskDone title={`Welcome, ${done.firstName}`}>
        <p>You are checked in. Please make your way to meet {done.hostName}.</p>
        <p className="text-muted-foreground">Your badge code</p>
        <p className="font-mono text-6xl font-bold tracking-widest" aria-label={`Badge code ${done.badgeCode.split("").join(" ")}`}>
          {done.badgeCode}
        </p>
        <p className="text-base text-muted-foreground">Keep this code. You will need it, with your phone number, to sign out.</p>
      </KioskDone>
    );
  }

  if (matches) {
    return (
      <KioskPanel title="Is this you?">
        <ul className="space-y-4">
          {matches.map((m) => (
            <li key={m.appointmentId} className="space-y-3 rounded-xl border p-5 text-center">
              <p className="text-2xl font-semibold">{m.firstName}</p>
              <p className="text-lg text-muted-foreground">
                Meeting {m.hostName} at{" "}
                {new Date(m.startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </p>
              <KioskButton className="w-full" disabled={busy} onClick={() => confirm(m)}>
                {busy ? "Checking in..." : "Yes, check me in"}
              </KioskButton>
            </li>
          ))}
        </ul>
        {error && <KioskMessage>{error}</KioskMessage>}
        <KioskButton
          variant="outline"
          className="w-full"
          disabled={busy}
          onClick={() => {
            setMatches(null);
            setPhone("");
            setError(null);
          }}
        >
          No, that is not me
        </KioskButton>
      </KioskPanel>
    );
  }

  return (
    <KioskPanel title="Check in for your appointment">
      <form onSubmit={find} className="space-y-6" noValidate>
        <KioskField
          id="phone"
          label="Phone number you booked with"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          autoFocus
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="0700 000 000"
        />
        {error && <KioskMessage>{error}</KioskMessage>}
        <KioskButton type="submit" className="w-full" disabled={busy || phone.trim().length === 0}>
          {busy ? "Looking..." : "Find my appointment"}
        </KioskButton>
      </form>
    </KioskPanel>
  );
}

export default function KioskVisitorAppointmentPage() {
  return (
    <KioskDeviceGate>
      <AppointmentCheckIn />
    </KioskDeviceGate>
  );
}
