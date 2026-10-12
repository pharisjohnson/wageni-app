"use client";

import { useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { PageHeader } from "@/components/layout/page-header";
import { useSiteGates } from "@/components/visits/use-site-gates";
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

const DAY = 24 * 60 * 60 * 1000;

const STATUS_LABELS: Record<Doc<"appointments">["status"], string> = {
  pending_approval: "Pending approval",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
  checked_in: "Checked in",
  completed: "Completed",
};

type BookingValues = {
  name: string;
  phone: string;
  email: string;
  company: string;
  purpose: string;
  hostUserId: string;
  start: string;
  durationMinutes: string;
};

function BookingForm({ siteId, onDone }: { siteId: Id<"sites">; onDone: () => void }) {
  const { organizationId, can } = useActiveOrg();
  const create = useMutation(api.appointments.create);
  const hosts = useQuery(api.appointments.hostOptions, { organizationId, siteId });
  const me = useQuery(api.users.me);
  const form = useForm<BookingValues>({
    defaultValues: {
      name: "",
      phone: "",
      email: "",
      company: "",
      purpose: "",
      hostUserId: "",
      start: "",
      durationMinutes: "60",
    },
  });
  const { errors, isSubmitting } = form.formState;
  // Hosts without site-wide scope can only book for themselves.
  const selfOnly = !can("appointments:read_site");

  const onSubmit = form.handleSubmit(async (v) => {
    const hostUserId = (selfOnly ? me?._id : v.hostUserId) as Id<"users"> | undefined;
    if (!hostUserId) {
      toast.error("Choose a host.");
      return;
    }
    const scheduledStart = new Date(v.start).getTime();
    try {
      await create({
        organizationId,
        siteId,
        hostUserId,
        visitor: {
          name: v.name,
          phone: v.phone || undefined,
          email: v.email || undefined,
          company: v.company || undefined,
        },
        purpose: v.purpose,
        scheduledStart,
        scheduledEnd: scheduledStart + Number(v.durationMinutes) * 60 * 1000,
      });
      toast.success("Appointment booked");
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <Field id="ap-name" label="Visitor name" error={errors.name?.message}>
        <Input id="ap-name" {...form.register("name", { required: "Enter the visitor's name." })} />
      </Field>
      <Field id="ap-phone" label="Phone (optional)">
        <Input id="ap-phone" type="tel" {...form.register("phone")} />
      </Field>
      <Field id="ap-email" label="Email (optional)">
        <Input id="ap-email" type="email" {...form.register("email")} />
      </Field>
      <Field id="ap-company" label="Company (optional)">
        <Input id="ap-company" {...form.register("company")} />
      </Field>
      {!selfOnly && (
        <Field id="ap-host" label="Host" error={errors.hostUserId?.message}>
          <NativeSelect id="ap-host" {...form.register("hostUserId", { required: "Choose a host." })}>
            <option value="">Select a host</option>
            {hosts?.map((h) => (
              <option key={h.userId} value={h.userId}>
                {h.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      <Field id="ap-start" label="Date and time" error={errors.start?.message}>
        <Input
          id="ap-start"
          type="datetime-local"
          {...form.register("start", { required: "Choose a date and time." })}
        />
      </Field>
      <Field id="ap-duration" label="Duration">
        <NativeSelect id="ap-duration" {...form.register("durationMinutes")}>
          {[15, 30, 60, 90, 120, 240].map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="ap-purpose" label="Purpose" error={errors.purpose?.message}>
        <Input id="ap-purpose" {...form.register("purpose", { required: "Enter the purpose of the visit." })} />
      </Field>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Booking…" : "Book appointment"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function AppointmentsPage() {
  const { organizationId, can } = useActiveOrg();
  const { sites, siteId, setSiteId, gates } = useSiteGates();
  const [adding, setAdding] = useState(false);
  // Fixed window for the session: yesterday through the next two weeks.
  const range = useMemo(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return { from: startOfDay.getTime() - DAY, to: startOfDay.getTime() + 14 * DAY };
  }, []);
  const appointments = useQuery(api.appointments.list, {
    organizationId,
    siteId: siteId ?? undefined,
    ...range,
  });
  const decide = useMutation(api.appointments.decide);
  const cancel = useMutation(api.appointments.cancel);
  const checkIn = useMutation(api.visits.checkInAppointment);
  const gateId = gates?.[0]?._id;

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader
        title="Appointments"
        description="Upcoming and recent visitor appointments."
        actions={
          can("appointments:create") && siteId && !adding ? (
            <Button onClick={() => setAdding(true)}>Book appointment</Button>
          ) : null
        }
      />
      {sites && sites.length > 1 && (
        <NativeSelect
          aria-label="Site"
          className="w-48"
          value={siteId ?? ""}
          onChange={(e) => setSiteId(e.target.value as Id<"sites">)}
        >
          {sites.map((s) => (
            <option key={s._id} value={s._id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
      )}
      {adding && siteId && (
        <Card>
          <CardHeader>
            <CardTitle>Book appointment</CardTitle>
          </CardHeader>
          <CardContent>
            <BookingForm siteId={siteId} onDone={() => setAdding(false)} />
          </CardContent>
        </Card>
      )}
      {appointments === undefined ? (
        <Skeleton className="h-40 w-full" />
      ) : appointments.length === 0 ? (
        <p className="text-muted-foreground">No appointments in this period.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {appointments.map((a) => (
            <li key={a._id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="space-y-0.5">
                <p className="font-medium">
                  {a.visitorName} <Badge variant="secondary">{STATUS_LABELS[a.status]}</Badge>
                </p>
                <p className="text-sm text-muted-foreground">
                  {new Date(a.scheduledStart).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                  {" · "}Host {a.hostName} · {a.purpose}
                </p>
              </div>
              <div className="flex gap-2">
                {a.status === "pending_approval" && can("appointments:approve") && (
                  <>
                    <Button
                      size="sm"
                      onClick={() =>
                        act(
                          () => decide({ organizationId, appointmentId: a._id, decision: "approved" }),
                          "Appointment approved",
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        act(
                          () => decide({ organizationId, appointmentId: a._id, decision: "declined" }),
                          "Appointment declined",
                        )
                      }
                    >
                      Decline
                    </Button>
                  </>
                )}
                {a.status === "approved" && can("visits:check_in") && gateId && (
                  <Button
                    size="sm"
                    onClick={() =>
                      act(
                        () => checkIn({ organizationId, appointmentId: a._id, gateId }),
                        "Visitor checked in",
                      )
                    }
                  >
                    Check in
                  </Button>
                )}
                {(a.status === "pending_approval" || a.status === "approved") &&
                  can("appointments:cancel") && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        act(() => cancel({ organizationId, appointmentId: a._id }), "Appointment cancelled")
                      }
                    >
                      Cancel
                    </Button>
                  )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
