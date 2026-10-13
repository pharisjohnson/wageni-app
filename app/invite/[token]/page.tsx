"use client";

import { useConvex, useMutation, useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import type { FileUploader } from "@/components/forms-builder/capture-field";
import { FormRenderer } from "@/components/forms-builder/form-renderer";
import { useFormController } from "@/components/forms-builder/use-form-controller";
import { Field } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { postBlob, UPLOAD_REJECTED_MESSAGES } from "@/lib/files/image";
import {
  autoFillAnswers,
  invitationSubmitSchema,
  isAutoFilled,
  type FormField,
} from "@/lib/validation/forms";

/**
 * Public invitation page. No sign-in: the link's token is the credential. Every
 * problem with the link (unknown, expired, used, cancelled) shows the same
 * message, so the page reveals nothing about which one it was.
 */
function Unavailable() {
  return (
    <div role="status" className="space-y-2 rounded-2xl border p-6 text-center">
      <h1 className="text-xl font-semibold">This invitation link is not available</h1>
      <p className="text-muted-foreground">
        It may have expired or already been used. Please ask the person who invited you for a new link.
      </p>
    </div>
  );
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const view = useQuery(api.invitations.lookup, { token });
  if (view === undefined) return <Skeleton className="h-64 w-full" />;
  if (view.status !== "ok") return <Unavailable />;
  return <InviteForm token={token} view={view} />;
}

type View = Extract<NonNullable<ReturnType<typeof useQuery<typeof api.invitations.lookup>>>, { status: "ok" }>;

function InviteForm({ token, view }: { token: string; view: View }) {
  const convex = useConvex();
  const submitInvite = useMutation(api.invitations.submit);
  const fields = useMemo(() => (view.form?.fields ?? []) as FormField[], [view.form]);
  const ctrl = useFormController(fields);
  const [details, setDetails] = useState({
    name: view.visitor.name,
    phone: view.visitor.phone,
    email: view.visitor.email,
    company: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ approval: "pending" | "approved"; hostName: string } | null>(null);
  const [gone, setGone] = useState(false);
  // Fields filled from the details above are not asked twice.
  const hide = useMemo(() => new Set(fields.filter(isAutoFilled).map((f) => f.id)), [fields]);

  const uploader = useMemo<FileUploader>(
    () => async (kind, blob) => {
      const up = await convex.mutation(api.invitations.generateUploadUrl, { token, kind });
      if (up.status !== "ok") throw new Error("This link is no longer available.");
      const storageId = (await postBlob(up.uploadUrl, blob)) as Id<"_storage">;
      const res = await convex.mutation(api.invitations.registerUploaded, { token, storageId, kind });
      if (res.status === "unavailable") throw new Error("This link is no longer available.");
      if (res.status !== "ok") throw new Error(UPLOAD_REJECTED_MESSAGES[res.reason]);
      return res.fileId;
    },
    [convex, token],
  );

  const when = `${new Date(view.scheduledStart).toLocaleString([], { dateStyle: "full", timeStyle: "short", timeZone: view.timeZone })}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = invitationSubmitSchema.safeParse(details);
    const next: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
    }
    setErrors(next);
    const base = parsed.success ? { ...parsed.data, purpose: view.purpose } : null;
    const answers = view.form
      ? ctrl.validate(base ? autoFillAnswers(fields, base) : {})
      : {};
    if (!base || !answers) return;
    setBusy(true);
    try {
      const res = await submitInvite({
        token,
        details: {
          name: base.name,
          phone: base.phone,
          email: base.email || undefined,
          company: base.company || undefined,
        },
        versionId: view.form?.versionId,
        // Auto-filled answers are added again on the server from the same details.
        answers: Object.fromEntries(Object.entries(answers).filter(([k]) => !hide.has(k))) as never,
      });
      if (res.status !== "ok") setGone(true);
      else setDone({ approval: res.approval, hostName: res.hostName });
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (gone) return <Unavailable />;
  if (done) {
    return (
      <div role="status" className="space-y-3 rounded-2xl border p-6 text-center">
        <h1 className="text-xl font-semibold">Thank you, you are registered</h1>
        <p>
          {done.approval === "approved"
            ? `Your visit with ${done.hostName} is confirmed.`
            : `${done.hostName} still needs to approve your visit. You do not need to do anything else.`}
        </p>
        <p className="text-muted-foreground">{when}</p>
        <p className="text-sm text-muted-foreground">On arrival, enter your phone number at the kiosk to check in.</p>
      </div>
    );
  }

  const hiddenErrors = Object.entries(ctrl.errors).filter(([id]) => hide.has(id));
  const set = (k: keyof typeof details) => (e: { target: { value: string } }) => setDetails((d) => ({ ...d, [k]: e.target.value }));
  return (
    <>
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">{view.organizationName}</p>
        <h1 className="text-2xl font-semibold tracking-tight">You are invited</h1>
        <p>
          Visit {view.hostName} at {view.siteName}: {view.purpose}
        </p>
        <p className="text-muted-foreground">{when}</p>
      </header>
      <form onSubmit={submit} className="space-y-5" noValidate>
        <fieldset className="space-y-4 rounded-xl border p-4">
          <legend className="px-1 text-sm font-medium">Confirm your details</legend>
          <Field id="iv-name" label="Your name" error={errors.name}>
            <Input id="iv-name" autoComplete="name" value={details.name} onChange={set("name")} aria-invalid={errors.name ? true : undefined} />
          </Field>
          <Field id="iv-phone" label="Phone number" error={errors.phone} help="Used to check you in at the kiosk.">
            <Input id="iv-phone" type="tel" autoComplete="tel" value={details.phone} onChange={set("phone")} aria-invalid={errors.phone ? true : undefined} />
          </Field>
          <Field id="iv-email" label="Email (optional)" error={errors.email}>
            <Input id="iv-email" type="email" autoComplete="email" value={details.email} onChange={set("email")} aria-invalid={errors.email ? true : undefined} />
          </Field>
          <Field id="iv-company" label="Company (optional)" error={errors.company}>
            <Input id="iv-company" autoComplete="organization" value={details.company} onChange={set("company")} />
          </Field>
        </fieldset>
        {view.form && <FormRenderer fields={fields} ctrl={ctrl} uploader={uploader} hide={hide} />}
        {hiddenErrors.length > 0 && (
          <p role="alert" className="text-sm text-destructive">
            {hiddenErrors.map(([, m]) => m).join(" ")} Check the details above.
          </p>
        )}
        {view.branding.privacyNotice && (
          <section aria-label="Privacy notice" className="space-y-1 rounded-xl bg-muted p-4 text-sm">
            <h2 className="font-semibold">Privacy notice</h2>
            <p className="whitespace-pre-line text-muted-foreground">{view.branding.privacyNotice}</p>
          </section>
        )}
        {formError && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            {formError}
          </p>
        )}
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? "Sending…" : "Confirm my visit"}
        </Button>
      </form>
    </>
  );
}
