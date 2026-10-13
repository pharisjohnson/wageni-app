"use client";

import { useEffect, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { useKioskApi } from "@/lib/kiosk/use-kiosk-api";
import { useKioskDevice } from "@/lib/kiosk/use-kiosk-device";
import { useKioskOrg } from "./kiosk-frame";

/**
 * Wrap kiosk action routes in this. An unpaired kiosk (no device token) shows
 * a friendly message instead of the action. The welcome screen is not wrapped.
 *
 * A stored token can still be revoked or invalid, so once paired the gate
 * verifies it with the server once. A NOT_FOUND answer unpairs the device
 * (see `useKioskApi`), which switches this gate to the "not set up" screen.
 * Network errors are ignored: the screen keeps working and each later call
 * re-checks.
 */
export function KioskDeviceGate({ children }: { children: ReactNode }) {
  const org = useKioskOrg();
  const device = useKioskDevice(org.slug);
  const kioskApi = useKioskApi(org.slug);
  const paired = device.status === "paired";
  const { query } = kioskApi;
  useEffect(() => {
    if (paired) query(api.kiosk.context, {}).catch(() => undefined);
  }, [paired, query]);
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
