"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";

const STATUS_LABELS: Record<Doc<"appointments">["status"], string> = {
  pending_approval: "Pending approval",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
  checked_in: "Checked in",
  completed: "Completed",
};

const fmt = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** `datetime-local` value in the viewer's zone. */
function toLocalInput(ms: number) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

type RescheduleValues = { start: string; durationMinutes: string };

function RescheduleForm({
  appointment,
  onDone,
}: {
  appointment: Pick<Doc<"appointments">, "_id" | "scheduledStart" | "scheduledEnd">;
  onDone: () => void;
}) {
  const { organizationId } = useActiveOrg();
  const reschedule = useMutation(api.appointments.reschedule);
  const form = useForm<RescheduleValues>({
    defaultValues: {
      start: toLocalInput(appointment.scheduledStart),
      durationMinutes: String(Math.round((appointment.scheduledEnd - appointment.scheduledStart) / 60000)),
    },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (v) => {
    const scheduledStart = new Date(v.start).getTime();
    try {
      await reschedule({
        organizationId,
        appointmentId: appointment._id,
        scheduledStart,
        scheduledEnd: scheduledStart + Number(v.durationMinutes) * 60 * 1000,
      });
      toast.success("Appointment rescheduled");
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <Field id="rs-start" label="Date and time" error={errors.start?.message}>
        <Input id="rs-start" type="datetime-local" {...form.register("start", { required: "Choose a date and time." })} />
      </Field>
      <Field id="rs-duration" label="Duration">
        <NativeSelect id="rs-duration" {...form.register("durationMinutes")}>
          {[15, 30, 45, 60, 90, 120, 240].map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save new time"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function AppointmentDetailPage() {
  const { appointmentId } = useParams<{ appointmentId: string }>();
  const { organizationId, can } = useActiveOrg();
  const appt = useQuery(api.appointments.get, {
    organizationId,
    appointmentId: appointmentId as Id<"appointments">,
  });
  const decide = useMutation(api.appointments.decide);
  const cancel = useMutation(api.appointments.cancel);
  const [rescheduling, setRescheduling] = useState(false);

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const back = { href: "/app/appointments", label: "Back to appointments" };
  if (appt === undefined) {
    return (
      <>
        <PageHeader title="Appointment" back={back} />
        <Skeleton className="h-48 w-full" />
      </>
    );
  }

  const open = appt.status === "pending_approval" || appt.status === "approved";
  const decided = appt.decidedByName && appt.status !== "pending_approval";

  return (
    <>
      <PageHeader
        title={appt.visitor?.name ?? "Appointment"}
        description={appt.purpose}
        back={back}
        actions={
          <>
            {appt.status === "pending_approval" && can("appointments:approve") && (
              <>
                <Button
                  onClick={() =>
                    act(
                      () => decide({ organizationId, appointmentId: appt._id, decision: "approved" }),
                      "Appointment approved",
                    )
                  }
                >
                  Approve
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    act(
                      () => decide({ organizationId, appointmentId: appt._id, decision: "declined" }),
                      "Appointment declined",
                    )
                  }
                >
                  Decline
                </Button>
              </>
            )}
            {open && can("appointments:update") && !rescheduling && (
              <Button variant="secondary" onClick={() => setRescheduling(true)}>
                Reschedule
              </Button>
            )}
            {open && can("appointments:cancel") && (
              <Button
                variant="ghost"
                onClick={() => act(() => cancel({ organizationId, appointmentId: appt._id }), "Appointment cancelled")}
              >
                Cancel appointment
              </Button>
            )}
          </>
        }
      />

      {rescheduling && (
        <Card>
          <CardHeader>
            <CardTitle>Reschedule</CardTitle>
          </CardHeader>
          <CardContent>
            <RescheduleForm appointment={appt} onDone={() => setRescheduling(false)} />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <Badge variant="secondary">{STATUS_LABELS[appt.status]}</Badge>
            </p>
            <p>When: {fmt(appt.scheduledStart)}</p>
            <p>Ends: {fmt(appt.scheduledEnd)}</p>
            <p>Host: {appt.hostName}</p>
            <p>Visitor: {appt.visitor?.name ?? "Unknown"}</p>
            {appt.visitor?.company && <p>Company: {appt.visitor.company}</p>}
            {appt.visitor?.phone && <p>Phone: {appt.visitor.phone}</p>}
            {appt.visitor?.email && <p>Email: {appt.visitor.email}</p>}
            {appt.visitId && (
              <p>
                <Link href={`/app/visits/${appt.visitId}`} className="underline underline-offset-4">
                  View visit
                </Link>
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Approval history</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3 border-l pl-4 text-sm">
              <li>
                <p className="font-medium">Booked</p>
                <p className="text-muted-foreground">
                  {fmt(appt.createdAt)} · {appt.createdByName}
                </p>
              </li>
              {decided && (
                <li>
                  <p className="font-medium">{appt.status === "declined" ? "Declined" : "Approved"}</p>
                  <p className="text-muted-foreground">{appt.decidedByName}</p>
                  {appt.decisionNote && <p className="mt-1">&ldquo;{appt.decisionNote}&rdquo;</p>}
                </li>
              )}
              {appt.status === "pending_approval" && (
                <li className="text-muted-foreground">Waiting for the host to decide.</li>
              )}
              {appt.status === "cancelled" && <li className="font-medium">Cancelled</li>}
            </ol>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
