"use client";

import { useMutation, useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { CorrectionForm } from "@/components/attendance/correction-form";
import { CorrectionList, DayList, EventList, useRange } from "@/components/attendance/history";
import { Field } from "@/components/forms/field";
import { ResponseCards, type ResponseView } from "@/components/forms-builder/visit-responses";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { ROLE_LABELS } from "@/lib/permissions";
import { useActiveOrg } from "@/lib/org/active-org";

/** Staff number and PIN reset for someone else. The PIN itself is never visible to anyone. */
function KioskAccess({
  membershipId,
  staffNumber,
  pinSet,
  pinLocked,
}: {
  membershipId: Id<"memberships">;
  staffNumber: string | null;
  pinSet: boolean | null;
  pinLocked: boolean | null;
}) {
  const { organizationId } = useActiveOrg();
  const setNumber = useMutation(api.attendancePins.setStaffNumber);
  const reset = useMutation(api.attendancePins.resetPin);
  const form = useForm<{ staffNumber: string }>({ defaultValues: { staffNumber: staffNumber ?? "" } });
  const { errors, isSubmitting } = form.formState;

  const save = form.handleSubmit(async (v) => {
    try {
      await setNumber({ organizationId, membershipId, staffNumber: v.staffNumber.trim() || null });
      toast.success("Staff number saved");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  async function resetPin() {
    try {
      await reset({ organizationId, membershipId });
      toast.success("PIN removed. They can choose a new one under Attendance.");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Kiosk access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={save} className="flex flex-wrap items-end gap-3" noValidate>
          <Field
            id="staff-number"
            label="Staff number"
            error={errors.staffNumber?.message}
            help="Typed at the kiosk with the PIN. 2 to 12 letters, numbers or dashes."
          >
            <Input
              id="staff-number"
              className="w-48"
              autoCapitalize="characters"
              {...form.register("staffNumber", {
                validate: (value) =>
                  value.trim() === "" || /^[A-Za-z0-9-]{2,12}$/.test(value.trim()) || "Use 2 to 12 letters, numbers or dashes.",
              })}
            />
          </Field>
          <Button type="submit" disabled={isSubmitting}>
            Save number
          </Button>
        </form>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {pinSet ? <Badge>PIN set</Badge> : <Badge variant="secondary">No PIN</Badge>}
          {pinLocked && <Badge variant="destructive">Locked</Badge>}
          <Button variant="outline" size="sm" disabled={!pinSet} onClick={resetPin}>
            Reset PIN
          </Button>
          <span className="text-muted-foreground">
            Changing the number or resetting removes the PIN. The person sets a new one themselves.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Answers this person gave to staff forms (for example a daily declaration at
 * clock-in). Sensitive answers stay hidden until revealed, which is logged.
 */
function FormAnswers({ userId }: { userId: Id<"users"> }) {
  const { organizationId } = useActiveOrg();
  const responses = useQuery(api.forms.staffResponses, { organizationId, userId });
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Form answers</h2>
      {responses === undefined ? (
        <Skeleton className="h-24 w-full" />
      ) : responses.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No staff form answers yet. They appear here when a staff form is published and this person clocks in.
        </p>
      ) : (
        <ResponseCards responses={responses as ResponseView[]} />
      )}
    </section>
  );
}

export default function StaffPersonPage() {
  const { userId } = useParams<{ userId: string }>();
  const { organizationId, can } = useActiveOrg();
  const range = useRange();
  const data = useQuery(api.attendance.personHistory, {
    organizationId,
    userId: userId as Id<"users">,
    from: range.from,
    to: range.to,
  });
  const sites = useQuery(api.sites.list, can("sites:read") ? { organizationId } : "skip");
  const [siteChoice, setSiteChoice] = useState<Id<"sites"> | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const siteId = siteChoice ?? sites?.find((s) => s.status === "active")?._id ?? null;
  const back = { href: "/app/staff", label: "Back to staff" };

  if (data === undefined) {
    return (
      <>
        <PageHeader title="Staff member" back={back} />
        <Skeleton className="h-48 w-full" />
      </>
    );
  }
  const { person } = data;
  return (
    <>
      <PageHeader
        title={person.name}
        description={[ROLE_LABELS[person.role], person.email, person.staffNumber ? `#${person.staffNumber}` : null]
          .filter(Boolean)
          .join(" · ")}
        back={back}
        actions={
          can("staff_attendance:correct") && !person.isSelf && siteId && !correcting ? (
            <Button variant="outline" onClick={() => setCorrecting(true)}>
              Add a missing entry
            </Button>
          ) : undefined
        }
      />

      {correcting && siteId && (
        <>
          {sites && sites.length > 1 && (
            <NativeSelect
              aria-label="Site for the correction"
              className="w-48"
              value={siteId}
              onChange={(e) => setSiteChoice(e.target.value as Id<"sites">)}
            >
              {sites.map((s) => (
                <option key={s._id} value={s._id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          )}
          <CorrectionForm
            key={siteId}
            siteId={siteId}
            userId={person.userId}
            personName={person.name}
            onDone={() => setCorrecting(false)}
          />
        </>
      )}

      {can("staff_attendance:manage_pins") && !person.isSelf && (
        <KioskAccess
          key={person.staffNumber ?? ""}
          membershipId={person.membershipId}
          staffNumber={person.staffNumber}
          pinSet={person.pinSet}
          pinLocked={person.pinLocked}
        />
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Hours</h2>
          {range.picker}
        </div>
        <DayList days={data.days} />
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Entries</h2>
        <EventList events={data.events} />
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Correction requests</h2>
        <CorrectionList corrections={data.corrections} />
      </section>
      <FormAnswers userId={person.userId} />
    </>
  );
}
