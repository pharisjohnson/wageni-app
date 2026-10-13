"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { starterFields } from "@/components/forms-builder/builder-utils";
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

type NewForm = { name: string; audience: "visitor" | "staff"; purpose: string; siteId: string };

function CreateForm({ onDone }: { onDone: () => void }) {
  const { organizationId } = useActiveOrg();
  const router = useRouter();
  const create = useMutation(api.forms.create);
  const sites = useQuery(api.sites.list, { organizationId });
  const form = useForm<NewForm>({ defaultValues: { name: "", audience: "visitor", purpose: "", siteId: "" } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (v) => {
    try {
      const formId = await create({
        organizationId,
        name: v.name,
        audience: v.audience,
        purpose: v.purpose || undefined,
        siteId: (v.siteId || undefined) as Id<"sites"> | undefined,
        // Visitor forms start with the fields every visit needs, already mapped.
        fields: v.audience === "visitor" ? (starterFields() as Doc<"forms">["draftFields"]) : undefined,
      });
      router.push(`/app/forms/${formId}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <Field id="nf-name" label="Form name" error={errors.name?.message}>
        <Input id="nf-name" {...form.register("name", { required: "Enter a name.", minLength: { value: 2, message: "Enter a name." } })} />
      </Field>
      <Field id="nf-audience" label="Who fills it in?">
        <NativeSelect id="nf-audience" {...form.register("audience")}>
          <option value="visitor">Visitors</option>
          <option value="staff">Staff</option>
        </NativeSelect>
      </Field>
      <Field id="nf-site" label="Site" help="Leave on all sites unless this form is only for one.">
        <NativeSelect id="nf-site" {...form.register("siteId")}>
          <option value="">All sites</option>
          {sites?.map((s) => (
            <option key={s._id} value={s._id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="nf-purpose" label="Purpose (optional)">
        <Input id="nf-purpose" {...form.register("purpose")} />
      </Field>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating…" : "Create and open builder"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function FormsPage() {
  const { organizationId, can } = useActiveOrg();
  const [adding, setAdding] = useState(false);
  const allowed = can("forms:manage");
  const forms = useQuery(api.forms.list, allowed ? { organizationId } : "skip");

  if (!allowed) {
    return <p className="text-muted-foreground">You do not have permission to manage forms.</p>;
  }

  return (
    <>
      <PageHeader
        title="Forms"
        description="Design what visitors and staff are asked. Publishing creates a new immutable version."
        actions={!adding && <Button onClick={() => setAdding(true)}>New form</Button>}
      />
      {adding && (
        <Card>
          <CardHeader>
            <CardTitle>New form</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateForm onDone={() => setAdding(false)} />
          </CardContent>
        </Card>
      )}
      {forms === undefined ? (
        <Skeleton className="h-32 w-full" />
      ) : forms.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No forms yet. Until you publish a visitor form, kiosks use the standard name, phone, company and reason fields.
        </p>
      ) : (
        <ul className="grid gap-3">
          {forms.map((f) => (
            <li key={f._id}>
              <Link href={`/app/forms/${f._id}`} className="block rounded-xl border p-4 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{f.name}</span>
                  <span className="flex gap-2">
                    <Badge variant="outline">{f.audience === "visitor" ? "Visitors" : "Staff"}</Badge>
                    <Badge variant={f.status === "published" ? "default" : "secondary"}>
                      {f.status === "published" ? `Live v${f.publishedVersion}` : f.status}
                    </Badge>
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {f.fieldCount} fields · {f.siteName ?? "All sites"}
                  {f.purpose ? ` · ${f.purpose}` : ""} · updated{" "}
                  {new Date(f.updatedAt).toLocaleDateString([], { dateStyle: "medium" })}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
