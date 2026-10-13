import { KioskDeviceGate } from "@/components/kiosk/kiosk-device-gate";
import { KioskPlaceholder } from "@/components/kiosk/kiosk-placeholder";

export default function KioskVisitorPage() {
  return (
    <KioskDeviceGate>
      <KioskPlaceholder
        title="Visitor registration"
        message="Self-registration is not available yet. Please ask at reception to be signed in."
      />
    </KioskDeviceGate>
  );
}
