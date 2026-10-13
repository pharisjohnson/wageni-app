import { KioskDeviceGate } from "@/components/kiosk/kiosk-device-gate";
import { KioskPlaceholder } from "@/components/kiosk/kiosk-placeholder";

export default function KioskVisitorCheckOutPage() {
  return (
    <KioskDeviceGate>
      <KioskPlaceholder
        title="Sign out"
        message="Self sign-out is not available yet. Please ask at reception and they will do it for you."
      />
    </KioskDeviceGate>
  );
}
