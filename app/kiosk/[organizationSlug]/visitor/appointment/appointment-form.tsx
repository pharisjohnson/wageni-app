"use client";

import { useMemo, useState, type FormEvent } from "react";
import { FormRenderer } from "@/components/forms-builder/form-renderer";
import { useFormController } from "@/components/forms-builder/use-form-controller";
import { useKioskOrg } from "@/components/kiosk/kiosk-frame";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { friendlyKioskError, KioskUnpairedError, useKioskApi } from "@/lib/kiosk/use-kiosk-api";
import { useKioskUploader } from "@/lib/kiosk/use-kiosk-uploader";
import type { FormField } from "@/lib/validation/forms";
import { KioskButton, KioskMessage, KioskPanel } from "../_components/kiosk-ui";

export type AppointmentForm = {
  versionId: Id<"formVersions">;
  name: string;
  fields: unknown[];
  /** Fields the server fills from the appointment; they are not shown. */
  prefilledFieldIds: string[];
};

export type CheckedIn = { firstName: string; hostName: string; badgeCode: string };

const NO_MATCH = "We could not find an appointment for that number today. Please check it, or ask reception for help.";
const LOCKED = "Too many tries on this screen. Please ask reception for help.";
const STALE = "This form was just updated. Please start again.";

/**
 * The published visitor form, shown after the phone matched and before the
 * visit exists. Details the appointment already holds (name, phone, purpose,
 * email, company) are filled by the server and not asked again. The server
 * re-validates everything and creates the visit and the response together, so
 * leaving this screen creates nothing.
 */
export function AppointmentFormStep({
  appointmentId,
  phone,
  form,
  onDone,
  onCancel,
  onNoMatch,
}: {
  appointmentId: Id<"appointments">;
  phone: string;
  form: AppointmentForm;
  onDone: (done: CheckedIn) => void;
  onCancel: () => void;
  onNoMatch: (message: string) => void;
}) {
  const org = useKioskOrg();
  const kiosk = useKioskApi(org.slug);
  const hide = useMemo(() => new Set(form.prefilledFieldIds), [form.prefilledFieldIds]);
  // Hidden fields are checked by the server (it holds their values), so they cannot block the screen.
  const fields = useMemo(
    () => (form.fields as FormField[]).map((f) => (hide.has(f.id) ? { ...f, required: false } : f)),
    [form.fields, hide],
  );
  const ctrl = useFormController(fields);
  const uploader = useKioskUploader(kiosk);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const answers = ctrl.validate();
    if (!answers) return;
    setBusy(true);
    try {
      const res = await kiosk.mutation(api.kioskForms.checkInAppointmentWithForm, {
        appointmentId,
        phone: phone.trim(),
        versionId: form.versionId,
        answers: Object.fromEntries(Object.entries(answers).filter(([id]) => !hide.has(id))) as never,
      });
      if (res.status === "ok") {
        ctrl.reset();
        onDone({ firstName: res.firstName, hostName: res.hostName, badgeCode: res.badgeCode });
      } else {
        onNoMatch(res.status === "locked" ? LOCKED : NO_MATCH);
      }
    } catch (err) {
      if (err instanceof KioskUnpairedError) return;
      const conflict = (err as { data?: { code?: string } } | null)?.data?.code === "CONFLICT";
      if (conflict) onNoMatch(STALE);
      else setError(friendlyKioskError(err));
    } finally {
      setBusy(false);
    }
  }

  const notice = org.branding.privacyNotice;
  return (
    <KioskPanel title={form.name}>
      <form onSubmit={submit} className="space-y-5" noValidate>
        <FormRenderer fields={fields} ctrl={ctrl} uploader={uploader} variant="kiosk" hide={hide} />
        {notice && (
          <section aria-label="Privacy notice" className="space-y-1 rounded-xl bg-muted p-4 text-sm">
            <h2 className="font-semibold">Privacy notice</h2>
            <p className="whitespace-pre-line text-muted-foreground">{notice}</p>
          </section>
        )}
        {error && <KioskMessage>{error}</KioskMessage>}
        <KioskButton type="submit" className="w-full" disabled={busy}>
          {busy ? "Checking in..." : "Check me in"}
        </KioskButton>
        <KioskButton type="button" variant="outline" className="w-full" disabled={busy} onClick={onCancel}>
          Cancel
        </KioskButton>
      </form>
    </KioskPanel>
  );
}
