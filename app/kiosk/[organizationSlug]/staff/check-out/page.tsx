import { KioskDeviceGate } from "@/components/kiosk/kiosk-device-gate";
import { KioskStaffAttendance } from "@/components/kiosk/staff-attendance";

export default function KioskStaffCheckOutPage() {
  return (
    <KioskDeviceGate>
      <KioskStaffAttendance type="clock_out" />
    </KioskDeviceGate>
  );
}
