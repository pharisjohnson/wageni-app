import { ComingSoon } from "@/components/layout/coming-soon";

export default function Page() {
  return (
    <ComingSoon
      title="Appointment"
      phase={2}
      back={{ href: "/app/appointments", label: "Appointments" }}
      summary="Appointment details, approval history and visitor information."
    />
  );
}
