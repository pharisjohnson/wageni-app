"use client";

import type { ReactNode } from "react";
import { useKioskDevice } from "@/lib/kiosk/use-kiosk-device";
import { useKioskOrg } from "./kiosk-frame";

/**
 * Wrap kiosk action routes in this. An unpaired kiosk (no device token) shows
 * a friendly message instead of the action. The welcome screen is not wrapped.
 */
export function KioskDeviceGate({ children }: { children: ReactNode }) {
  const org = useKioskOrg();
  const device = useKioskDevice(org.slug);
  if (device.status === "loading") return null;
  if (device.status === "unpaired") {
    return (
      <div className="w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8 text-center">
        <h1 className="text-2xl font-semibold">This kiosk is not set up</h1>
        <p className="text-muted-foreground">
          Please ask a member of staff to finish setting up this device.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
