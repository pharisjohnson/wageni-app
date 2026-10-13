"use client";

import { CalendarCheck, DoorClosed, UserPlus } from "lucide-react";
import { KioskTile } from "@/components/kiosk/kiosk-tile";
import { useKioskOrg } from "@/components/kiosk/kiosk-frame";

export default function KioskVisitorPage() {
  const { slug } = useKioskOrg();
  const base = `/kiosk/${slug}/visitor`;
  return (
    <div className="w-full max-w-4xl space-y-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">How can we help you?</h1>
      <div className="grid gap-6 sm:grid-cols-3">
        <KioskTile primary href={`${base}/appointment`} icon={CalendarCheck} label="I have an appointment" />
        <KioskTile href={`${base}/walk-in`} icon={UserPlus} label="I'm a new visitor" hint="No appointment" />
        <KioskTile href={`${base}/check-out`} icon={DoorClosed} label="I'm leaving" hint="Sign out" />
      </div>
      <p className="text-muted-foreground">Prefer help? Reception can sign you in or out.</p>
    </div>
  );
}
