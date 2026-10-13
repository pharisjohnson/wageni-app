import { KioskDeviceGate } from "@/components/kiosk/kiosk-device-gate";
import { KioskPlaceholder } from "@/components/kiosk/kiosk-placeholder";

export default function KioskVisitorAppointmentPage() {
  return (
    <KioskDeviceGate>
      <KioskPlaceholder
        title="Find your appointment"
        message="Self check-in for booked appointments is not available yet. Please ask at reception and they will do it for you."
      />
    </KioskDeviceGate>
  );
}
