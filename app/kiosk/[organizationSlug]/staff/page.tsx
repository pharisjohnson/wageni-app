import { KioskDeviceGate } from "@/components/kiosk/kiosk-device-gate";
import { KioskPlaceholder } from "@/components/kiosk/kiosk-placeholder";

/**
 * Staff kiosk actions will require secure identification (Phase 3). Choosing
 * "Staff" on the welcome screen never grants staff functionality by itself.
 */
export default function KioskStaffPage() {
  return (
    <KioskDeviceGate>
      <KioskPlaceholder
        title="Staff check-in"
        message="Staff check-in at the kiosk is not available yet. Please use your usual attendance process."
      />
    </KioskDeviceGate>
  );
}
