import { KioskDeviceGate } from "@/components/kiosk/kiosk-device-gate";
import { KioskPlaceholder } from "@/components/kiosk/kiosk-placeholder";

export default function KioskStaffCheckOutPage() {
  return (
    <KioskDeviceGate>
      <KioskPlaceholder
        title="Staff check-out"
        message="Staff check-out at the kiosk is not available yet. Please ask at reception and they will do it for you."
      />
    </KioskDeviceGate>
  );
}
