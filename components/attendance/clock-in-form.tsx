"use client";

import { useMutation } from "convex/react";
import { LogIn } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { FileUploader } from "@/components/forms-builder/capture-field";
import { FormRenderer } from "@/components/forms-builder/form-renderer";
import { useFormController } from "@/components/forms-builder/use-form-controller";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";
import type { FormField } from "@/lib/validation/forms";

export type StaffForm = { versionId: Id<"formVersions">; version: number; name: string; fields: unknown[] };

/**
 * The staff form (for example a daily declaration) a person answers to clock
 * in at a site where one is published. Answers are validated again on the
 * server with the same rules and stored with the clock-in event.
 */
export function ClockInForm({
  siteId,
  form,
  onDone,
  onCancel,
}: {
  siteId: Id<"sites">;
  form: StaffForm;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { organizationId } = useActiveOrg();
  const clockIn = useMutation(api.attendance.clockIn);
  const fields = useMemo(() => form.fields as FormField[], [form.fields]);
  const ctrl = useFormController(fields);
  const [busy, setBusy] = useState(false);
  // Staff forms have no file fields (the builder refuses them), so nothing can be uploaded here.
  const uploader = useMemo<FileUploader>(
    () => async () => {
      throw new Error("Files cannot be added to this form.");
    },
    [],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    const answers = ctrl.validate();
    if (!answers) return;
    setBusy(true);
    try {
      await clockIn({ organizationId, siteId, form: { versionId: form.versionId, answers: answers as never } });
      toast.success("Clocked in");
      ctrl.reset();
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{form.name}</CardTitle>
        <CardDescription>Answer this to clock in.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-5" noValidate>
          <FormRenderer fields={fields} ctrl={ctrl} uploader={uploader} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              <LogIn aria-hidden /> {busy ? "Clocking in…" : "Submit and clock in"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
