"use client";

import { useRouter } from "next/navigation";
import { CheckCircle2, LogIn, LogOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { FileUploader } from "@/components/forms-builder/capture-field";
import { FormRenderer } from "@/components/forms-builder/form-renderer";
import { useFormController } from "@/components/forms-builder/use-form-controller";
import { useKioskOrg } from "@/components/kiosk/kiosk-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FormField } from "@/lib/validation/forms";
import { PIN_PATTERN } from "@/lib/attendance/sessions";
import { errorCode, KioskUnpairedError, useKioskApi } from "@/lib/kiosk/use-kiosk-api";

/** Seconds the confirmation stays up before the kiosk returns to the welcome screen. */
const DONE_SECONDS = 15;

const GENERIC_FAILURE =
  "We couldn't verify those details. Check your staff number and PIN, or ask reception for help.";

/** The staff form published for this site (for example a daily declaration), asked at clock-in. */
type StaffForm = { versionId: Id<"formVersions">; name: string; fields: unknown[] };

type Step =
  | { name: "identify"; error?: string }
  | { name: "confirm"; firstName: string; alreadyDone: boolean; since: number | null; form: StaffForm | null }
  | { name: "form"; firstName: string; form: StaffForm; error?: string }
  | { name: "done"; firstName: string; at: number; message: string };

/** Staff forms hold no files, so there is nothing to upload from here. */
const noUploads: FileUploader = async () => {
  throw new Error("Files cannot be added to this form.");
};

function StaffFormStep({
  form,
  firstName,
  busy,
  error,
  onSubmit,
  onBack,
}: {
  form: StaffForm;
  firstName: string;
  busy: boolean;
  error?: string;
  onSubmit: (answers: Record<string, unknown>) => void;
  onBack: () => void;
}) {
  const fields = useMemo(() => form.fields as FormField[], [form.fields]);
  const ctrl = useFormController(fields);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const answers = ctrl.validate();
        if (answers) onSubmit(answers);
      }}
      className="w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8"
      noValidate
    >
      <div className="space-y-1 text-center">
        <h1 className="text-3xl font-semibold">{form.name}</h1>
        <p className="text-muted-foreground">Hello {firstName}. Please answer this to check in.</p>
      </div>
      <FormRenderer fields={fields} ctrl={ctrl} uploader={noUploads} variant="kiosk" />
      {error && (
        <p role="alert" className="text-center text-base text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
        <Button type="submit" className="h-14 px-8 text-lg" disabled={busy}>
          <LogIn aria-hidden /> {busy ? "Saving…" : "Submit and check in"}
        </Button>
        <Button type="button" variant="outline" className="h-14 px-8 text-lg" disabled={busy} onClick={onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Staff check-in / check-out at the kiosk: staff number + PIN, a "Hello
 * <first name>" confirmation, then the event is recorded. The device token
 * authorises the kiosk; the PIN is verified on the server for each step. The
 * staff number and PIN live in React state only (never in browser storage) and
 * are dropped as soon as the action finishes or the screen unmounts.
 */
export function KioskStaffAttendance({ type }: { type: "clock_in" | "clock_out" }) {
  const org = useKioskOrg();
  const router = useRouter();
  const kioskApi = useKioskApi(org.slug);
  const [staffNumber, setStaffNumber] = useState("");
  const [pin, setPin] = useState("");
  const [step, setStep] = useState<Step>({ name: "identify" });
  const [busy, setBusy] = useState(false);
  const numberRef = useRef<HTMLInputElement>(null);
  const checkingIn = type === "clock_in";
  const home = `/kiosk/${org.slug}`;

  useEffect(() => {
    if (step.name !== "done") return;
    const id = window.setTimeout(() => router.replace(home), DONE_SECONDS * 1000);
    return () => window.clearTimeout(id);
  }, [step.name, router, home]);

  function reset(error?: string) {
    setPin("");
    setStaffNumber(error ? staffNumber : "");
    setStep({ name: "identify", error });
    window.setTimeout(() => numberRef.current?.focus(), 0);
  }

  /** NOT_FOUND means this device is no longer trusted; useKioskApi already unpaired it. */
  function handleCallError(e: unknown) {
    if (e instanceof KioskUnpairedError) return;
    reset(
      errorCode(e) === "RATE_LIMITED"
        ? "Too many attempts. Please wait a moment and try again."
        : "Something went wrong. Please try again or ask reception for help.",
    );
  }

  async function onIdentify(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!staffNumber.trim() || !PIN_PATTERN.test(pin)) {
      setStep({ name: "identify", error: "Enter your staff number and your 4 to 6 digit PIN." });
      return;
    }
    setBusy(true);
    try {
      const r = await kioskApi.mutation(api.kioskAttendance.identify, { staffNumber, pin });
      if (!r.ok) return reset(GENERIC_FAILURE);
      const alreadyDone = checkingIn ? r.status === "in" : r.status === "out";
      setStep({
        name: "confirm",
        firstName: r.firstName,
        alreadyDone,
        since: r.since,
        form: checkingIn && r.form ? { versionId: r.form.versionId, name: r.form.name, fields: r.form.fields } : null,
      });
    } catch (err) {
      handleCallError(err);
    } finally {
      setBusy(false);
    }
  }

  /** `answers` is set when a staff form was filled in; the server asks for it again if it is missing. */
  async function onRecord(form?: StaffForm, answers?: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await kioskApi.mutation(
        api.kioskAttendance.record,
        form && answers
          ? { staffNumber, pin, type, versionId: form.versionId, answers: answers as never }
          : { staffNumber, pin, type },
      );
      if (!r.ok) {
        setPin("");
        setStaffNumber("");
        return reset(GENERIC_FAILURE);
      }
      // Form problems keep the PIN so the person can fix the answers and try again.
      if (r.outcome === "form_invalid" && form) {
        return setStep({ name: "form", firstName: r.firstName, form, error: r.message });
      }
      if (r.outcome === "form_stale") {
        return setStep({
          name: "form",
          firstName: r.firstName,
          form: form as StaffForm,
          error: "This form was just updated. Please go back and start again.",
        });
      }
      // The PIN is no longer needed once the clock-in was decided.
      setPin("");
      setStaffNumber("");
      if (r.outcome === "form_required") {
        return reset("A form must be answered to check in. Please try again.");
      }
      if (r.outcome === "recorded") {
        setStep({
          name: "done",
          firstName: r.firstName,
          at: r.at,
          message: checkingIn ? "You are checked in." : "You are checked out. Have a good evening.",
        });
      } else {
        const message =
          r.outcome === "already_in"
            ? "You are already checked in."
            : r.outcome === "not_in"
              ? "You are not checked in, so there is nothing to check out. Ask reception if this looks wrong."
              : "You checked in at a different site. Please check out there, or ask reception.";
        setStep({ name: "done", firstName: r.firstName, at: r.at ?? Date.now(), message });
      }
    } catch (err) {
      handleCallError(err);
    } finally {
      setBusy(false);
    }
  }

  const Icon = checkingIn ? LogIn : LogOut;
  const title = checkingIn ? "Check in" : "Check out";

  if (step.name === "done") {
    return (
      <div className="w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8 text-center" role="status">
        <CheckCircle2 className="mx-auto size-16 text-primary" aria-hidden />
        <h1 className="text-3xl font-semibold">Thank you, {step.firstName}</h1>
        <p className="text-xl">{step.message}</p>
        <p className="text-muted-foreground">{time(step.at)}</p>
        <Button className="h-14 px-8 text-lg" onClick={() => router.replace(home)}>
          Done
        </Button>
        <p className="text-sm text-muted-foreground">Returning to the welcome screen shortly.</p>
      </div>
    );
  }

  if (step.name === "form") {
    return (
      <StaffFormStep
        form={step.form}
        firstName={step.firstName}
        busy={busy}
        error={step.error}
        onSubmit={(answers) => onRecord(step.form, answers)}
        onBack={() => reset()}
      />
    );
  }

  if (step.name === "confirm") {
    return (
      <div className="w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8 text-center">
        <h1 className="text-3xl font-semibold">Hello {step.firstName}</h1>
        {step.alreadyDone ? (
          <p className="text-lg text-muted-foreground">
            {checkingIn
              ? `You are already checked in${step.since ? ` since ${time(step.since)}` : ""}.`
              : "You are not checked in right now."}
          </p>
        ) : (
          <p className="text-lg text-muted-foreground">
            {checkingIn ? "Ready to check in?" : "Ready to check out?"}
          </p>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          {!step.alreadyDone && (
            <Button
              className="h-14 px-8 text-lg"
              disabled={busy}
              onClick={() =>
                step.form ? setStep({ name: "form", firstName: step.firstName, form: step.form }) : onRecord()
              }
            >
              <Icon aria-hidden /> {busy ? "Saving…" : step.form ? "Continue" : title}
            </Button>
          )}
          <Button variant="outline" className="h-14 px-8 text-lg" disabled={busy} onClick={() => reset()}>
            {step.alreadyDone ? "Back" : "That's not me"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={onIdentify}
      className="w-full max-w-xl space-y-6 rounded-2xl border bg-background p-8"
      noValidate
      autoComplete="off"
    >
      <div className="space-y-1 text-center">
        <h1 className="text-3xl font-semibold">{title}</h1>
        <p className="text-muted-foreground">Enter your staff number and PIN.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="k-staff-number" className="text-base">
          Staff number
        </Label>
        <Input
          id="k-staff-number"
          ref={numberRef}
          className="h-14 text-xl uppercase"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={12}
          value={staffNumber}
          onChange={(e) => setStaffNumber(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="k-pin" className="text-base">
          PIN
        </Label>
        <Input
          id="k-pin"
          type="password"
          inputMode="numeric"
          className="h-14 text-xl tracking-widest"
          autoComplete="off"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          aria-describedby={step.error ? "k-error" : undefined}
        />
      </div>
      {step.error && (
        <p id="k-error" role="alert" className="text-center text-base text-destructive">
          {step.error}
        </p>
      )}
      <Button type="submit" className="h-14 w-full text-lg" disabled={busy}>
        {busy ? "Checking…" : "Continue"}
      </Button>
    </form>
  );
}
