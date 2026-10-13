"use client";

import { LogIn, LogOut } from "lucide-react";
import { KioskTile } from "@/components/kiosk/kiosk-tile";
import { useKioskOrg } from "@/components/kiosk/kiosk-frame";

/**
 * Choosing "Staff" on the welcome screen grants nothing by itself: the next
 * screens ask for a staff number and PIN, which the server verifies on every action.
 */
export default function KioskStaffPage() {
  const { slug } = useKioskOrg();
  const base = `/kiosk/${slug}/staff`;
  return (
    <div className="w-full max-w-3xl space-y-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Staff attendance</h1>
      <div className="grid gap-6 sm:grid-cols-2">
        <KioskTile primary href={`${base}/check-in`} icon={LogIn} label="Check in" hint="Start of shift" />
        <KioskTile href={`${base}/check-out`} icon={LogOut} label="Check out" hint="End of shift" />
      </div>
      <p className="text-muted-foreground">Prefer help? Reception can record your attendance.</p>
    </div>
  );
}
