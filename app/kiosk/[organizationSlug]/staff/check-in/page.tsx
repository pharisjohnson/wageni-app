import { KioskDeviceGate } from "@/components/kiosk/kiosk-device-gate";
import { KioskPlaceholder } from "@/components/kiosk/kiosk-placeholder";

export default function KioskStaffCheckInPage() {
  return (
    <KioskDeviceGate>
      <KioskPlaceholder
        title="Staff check-in"
        message="Staff check-in at the kiosk is not available yet. Please ask at reception and they will do it for you."
      />
    </KioskDeviceGate>
  );
}
