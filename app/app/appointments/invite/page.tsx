"use client";

import { useMutation, useQuery } from "convex/react";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { PageHeader } from "@/components/layout/page-header";
import { useSiteGates } from "@/components/visits/use-site-gates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";

type Values = {
  visitorName: string;
  visitorPhone: string;
  visitorEmail: string;
  purpose: string;
  hostUserId: string;
  start: string;
  durationMinutes: string;
};

function LinkBox({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      toast.error("Could not copy. Select the link and copy it by hand.");
    }
  }
  return (
    <div className="space-y-2 rounded-xl border bg-muted/40 p-4">
      <p className="text-sm font-medium">Invitation link</p>
      <div className="flex flex-wrap gap-2">
        <Input readOnly value={link} aria-label="Invitation link" className="min-w-0 flex-1" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Share this link with the visitor. It is shown only now: only a fingerprint is stored, so if you lose it, cancel and make a new one.
        If the visitor has an email or phone on file, a notification is also queued.
      </p>
    </div>
  );
}

function InviteForm({ siteId }: { siteId: Id<"sites"> }) {
  const { organizationId, can } = useActiveOrg();
  const create = useMutation(api.invitations.create);
  const hosts = useQuery(api.appointments.hostOptions, { organizationId, siteId });
  const me = useQuery(api.users.me);
  const forms = useQuery(api.forms.list, can("forms:manage") ? { organizationId } : "skip");
  const [link, setLink] = useState<string | null>(null);
  const form = useForm<Values & { formId: string }>({
    defaultValues: { visitorName: "", visitorPhone: "", visitorEmail: "", purpose: "", hostUserId: "", start: "", durationMinutes: "60", formId: "" },
  });
  const { errors, isSubmitting } = form.formState;
  const selfOnly = !can("appointments:read_site");

  const onSubmit = form.handleSubmit(async (v) => {
    const hostUserId = (selfOnly ? me?._id : v.hostUserId) as Id<"users"> | undefined;
    if (!hostUserId) {
      toast.error("Choose a host.");
      return;
    }
    const scheduledStart = new Date(v.start).getTime();
    try {
      const res = await create({
        organizationId,
        siteId,
        hostUserId,
        visitorName: v.visitorName || undefined,
        visitorPhone: v.visitorPhone || undefined,
        visitorEmail: v.visitorEmail || undefined,
        purpose: v.purpose,
        scheduledStart,
        scheduledEnd: scheduledStart + Number(v.durationMinutes) * 60_000,
        formId: (v.formId || undefined) as Id<"forms"> | undefined,
        // The server validates this origin; APP_BASE_URL, when set there, takes precedence.
        origin: window.location.origin,
      });
      // `url` is absolute when the server trusted an origin; otherwise fall back to this browser's.
      setLink(res.url.startsWith("/") ? `${window.location.origin}${res.path}` : res.url);
      form.reset();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  return (
    <div className="space-y-4">
      {link && <LinkBox link={link} />}
      <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field id="iv-name" label="Visitor name (optional)">
          <Input id="iv-name" {...form.register("visitorName")} />
        </Field>
        <Field id="iv-phone" label="Visitor phone (optional)">
          <Input id="iv-phone" type="tel" {...form.register("visitorPhone")} />
        </Field>
        <Field id="iv-email" label="Visitor email (optional)">
          <Input id="iv-email" type="email" {...form.register("visitorEmail")} />
        </Field>
        {!selfOnly && (
          <Field id="iv-host" label="Host" error={errors.hostUserId?.message}>
            <NativeSelect id="iv-host" {...form.register("hostUserId", { required: "Choose a host." })}>
              <option value="">Select a host</option>
              {hosts?.map((h) => (
                <option key={h.userId} value={h.userId}>
                  {h.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field id="iv-start" label="Date and time" error={errors.start?.message}>
          <Input id="iv-start" type="datetime-local" {...form.register("start", { required: "Choose a date and time." })} />
        </Field>
        <Field id="iv-duration" label="Duration">
          <NativeSelect id="iv-duration" {...form.register("durationMinutes")}>
            {[30, 60, 90, 120, 240].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="iv-purpose" label="Purpose" error={errors.purpose?.message}>
          <Input id="iv-purpose" {...form.register("purpose", { required: "Enter the purpose of the visit." })} />
        </Field>
        {forms && forms.some((f) => f.status === "published" && f.audience === "visitor") && (
          <Field id="iv-form" label="Form" help="Blank = the form published for this site.">
            <NativeSelect id="iv-form" {...form.register("formId")}>
              <option value="">Default form</option>
              {forms
                .filter((f) => f.status === "published" && f.audience === "visitor")
                .map((f) => (
                  <option key={f._id} value={f._id}>
                    {f.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Creating…" : "Create invitation link"}
          </Button>
        </div>
      </form>
    </div>
  );
}

const STATUS = { pending: "Waiting", submitted: "Confirmed by visitor", expired: "Expired", cancelled: "Cancelled" } as const;

function InvitationList() {
  const { organizationId } = useActiveOrg();
  const list = useQuery(api.invitations.list, { organizationId });
  const cancel = useMutation(api.invitations.cancel);
  if (list === undefined) return <Skeleton className="h-24 w-full" />;
  if (list.length === 0) return <p className="text-sm text-muted-foreground">No invitations yet.</p>;
  return (
    <ul className="divide-y">
      {list.map((i) => (
        <li key={i._id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <span>
            <span className="font-medium">{i.visitorName ?? "Visitor"}</span> with {i.hostName}: {i.purpose}
            <span className="block text-xs text-muted-foreground">
              {new Date(i.scheduledStart).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <Badge variant={i.status === "pending" ? "default" : "secondary"}>{STATUS[i.status]}</Badge>
            {i.status === "pending" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await cancel({ organizationId, invitationId: i._id });
                    toast.success("Invitation cancelled");
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                Cancel
              </Button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function InvitePage() {
  const { can } = useActiveOrg();
  const { sites, siteId, setSiteId } = useSiteGates();
  if (!can("appointments:create")) return <p className="text-muted-foreground">You do not have permission to invite visitors.</p>;
  return (
    <>
      <PageHeader
        title="Invite a visitor"
        description="Create a link the visitor opens to confirm their details and fill in the visitor form."
        back={{ href: "/app/appointments", label: "Back to appointments" }}
      />
      <Card>
        <CardHeader>
          <CardTitle>New invitation</CardTitle>
          {sites && sites.length > 1 && (
            <CardDescription>
              <label className="flex items-center gap-2">
                Site
                <NativeSelect className="w-48" value={siteId ?? ""} onChange={(e) => setSiteId(e.target.value as Id<"sites">)}>
                  {sites.filter((s) => s.status === "active").map((s) => (
                    <option key={s._id} value={s._id}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>{siteId ? <InviteForm key={siteId} siteId={siteId} /> : <Skeleton className="h-32 w-full" />}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Your invitations</CardTitle>
        </CardHeader>
        <CardContent>
          <InvitationList />
        </CardContent>
      </Card>
    </>
  );
}
