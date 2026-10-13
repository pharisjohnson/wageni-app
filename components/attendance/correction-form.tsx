"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";

type Values = { type: "clock_in" | "clock_out"; at: string; reason: string };

/** `YYYY-MM-DDTHH:mm` in the device's local time, as <input type="datetime-local"> expects. */
function toLocalInput(ms: number) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/**
 * Ask for a missing or wrong entry to be fixed. Nothing is overwritten: if
 * approved, a new entry is added and the original stays in the history.
 */
export function CorrectionForm({
  siteId,
  userId,
  original,
  personName,
  onDone,
}: {
  siteId: Id<"sites">;
  /** Omit to request a correction for yourself. */
  userId?: Id<"users">;
  original?: { _id: string; type: "clock_in" | "clock_out"; at: number };
  personName?: string;
  onDone: () => void;
}) {
  const { organizationId } = useActiveOrg();
  const request = useMutation(api.attendance.requestCorrection);
  const [initialAt] = useState(() => original?.at ?? Date.now());
  const form = useForm<Values>({
    defaultValues: {
      type: original?.type ?? "clock_out",
      at: toLocalInput(initialAt),
      reason: "",
    },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (v) => {
    const at = new Date(v.at).getTime();
    if (Number.isNaN(at)) return form.setError("at", { message: "Choose a date and time." });
    try {
      await request({
        organizationId,
        siteId,
        userId,
        originalEventId: original ? (original._id as Id<"attendanceEvents">) : undefined,
        proposedType: v.type,
        proposedAt: at,
        reason: v.reason,
      });
      toast.success("Correction requested");
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {original ? "Request a correction" : "Add a missing entry"}
          {personName ? ` for ${personName}` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field id="cf-type" label="Entry">
            <NativeSelect id="cf-type" {...form.register("type")}>
              <option value="clock_in">Clock in</option>
              <option value="clock_out">Clock out</option>
            </NativeSelect>
          </Field>
          <Field
            id="cf-at"
            label="Correct time"
            error={errors.at?.message}
            help="In your device's time zone. It cannot be in the future."
          >
            <Input id="cf-at" type="datetime-local" {...form.register("at", { required: "Choose a date and time." })} />
          </Field>
          <div className="sm:col-span-2">
            <Field id="cf-reason" label="Reason" error={errors.reason?.message}>
              <Textarea
                id="cf-reason"
                rows={3}
                {...form.register("reason", {
                  required: "Give a reason.",
                  minLength: { value: 3, message: "Give a reason." },
                  maxLength: { value: 500, message: "Use at most 500 characters." },
                })}
              />
            </Field>
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Sending…" : "Send request"}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
