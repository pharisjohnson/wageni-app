"use client";

import { useMutation, useQuery } from "convex/react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/auth/errors";
import { PIN_PATTERN } from "@/lib/attendance/sessions";
import { useActiveOrg } from "@/lib/org/active-org";

type Values = { pin: string; confirm: string };

/** Set or change my kiosk PIN. The PIN is write-only: it is never shown back. */
export function PinCard() {
  const { organizationId } = useActiveOrg();
  const status = useQuery(api.attendancePins.myPinStatus, { organizationId });
  const setPin = useMutation(api.attendancePins.setMyPin);
  const form = useForm<Values>({ defaultValues: { pin: "", confirm: "" } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await setPin({ organizationId, pin: v.pin });
      toast.success("Kiosk PIN saved");
      form.reset();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Kiosk check-in</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === undefined ? null : !status.staffNumber ? (
          <p className="text-sm text-muted-foreground">
            To use the kiosk you need a staff number. Ask a manager to give you one, then come back here to choose a PIN.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              At the kiosk, enter your staff number <strong className="text-foreground">{status.staffNumber}</strong>{" "}
              and your PIN.{" "}
              {status.pinSet ? <Badge>PIN set</Badge> : <Badge variant="secondary">No PIN yet</Badge>}{" "}
              {status.locked && <Badge variant="destructive">Locked after too many wrong PINs</Badge>}
            </p>
            {status.locked && (
              <p className="text-sm text-muted-foreground">
                Choosing a new PIN below unlocks it straight away.
              </p>
            )}
            <form onSubmit={onSubmit} className="grid max-w-md gap-4 sm:grid-cols-2" noValidate autoComplete="off">
              <Field id="pin-new" label={status.pinSet ? "New PIN" : "PIN"} error={errors.pin?.message} help="4 to 6 digits.">
                <Input
                  id="pin-new"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={6}
                  {...form.register("pin", {
                    validate: (value) => PIN_PATTERN.test(value) || "Use 4 to 6 digits.",
                  })}
                />
              </Field>
              <Field id="pin-confirm" label="Repeat PIN" error={errors.confirm?.message}>
                <Input
                  id="pin-confirm"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  maxLength={6}
                  {...form.register("confirm", {
                    validate: (value, all) => value === all.pin || "The PINs do not match.",
                  })}
                />
              </Field>
              <div className="sm:col-span-2">
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Saving…" : status.pinSet ? "Change PIN" : "Save PIN"}
                </Button>
              </div>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
