"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { PageHeader } from "@/components/layout/page-header";
import { KioskDevices } from "@/components/sites/kiosk-devices";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { toastError } from "@/components/billing/plan-toast";
import { useActiveOrg } from "@/lib/org/active-org";
import { browserTimeZone, timeZoneOptions } from "@/lib/time-zones";
import { gateSchema, siteSchema, type GateInput, type SiteInput } from "@/lib/validation/organization";

const GATE_TYPE_LABELS: Record<GateInput["type"], string> = {
  pedestrian: "Pedestrian",
  vehicle: "Vehicle",
  reception: "Reception desk",
  other: "Other",
};

function NewSiteForm({ onDone }: { onDone: () => void }) {
  const { organizationId } = useActiveOrg();
  const createSite = useMutation(api.sites.create);
  const form = useForm<SiteInput>({
    resolver: zodResolver(siteSchema),
    defaultValues: { name: "", address: "", timeZone: browserTimeZone() },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createSite({ organizationId, ...values });
      toast.success("Site created");
      onDone();
    } catch (e) {
      toastError(e);
    }
  });

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-3" noValidate>
      <Field id="site-name" label="Site name" error={errors.name?.message}>
        <Input id="site-name" aria-invalid={!!errors.name} {...form.register("name")} />
      </Field>
      <Field id="site-address" label="Address (optional)" error={errors.address?.message}>
        <Input id="site-address" {...form.register("address")} />
      </Field>
      <Field id="site-tz" label="Time zone" error={errors.timeZone?.message}>
        <NativeSelect id="site-tz" {...form.register("timeZone")}>
          {timeZoneOptions().map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Create site"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function NewGateForm({ siteId }: { siteId: Id<"sites"> }) {
  const { organizationId } = useActiveOrg();
  const createGate = useMutation(api.gates.create);
  const form = useForm<GateInput>({
    resolver: zodResolver(gateSchema),
    defaultValues: { name: "", type: "pedestrian" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createGate({ organizationId, siteId, ...values });
      form.reset({ name: "", type: values.type });
      toast.success("Gate added");
    } catch (e) {
      toastError(e);
    }
  });

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-start" noValidate>
      <div className="flex-1">
        <Input
          aria-label="New gate name"
          placeholder="New gate name"
          aria-invalid={!!errors.name}
          {...form.register("name")}
        />
        {errors.name && <p className="mt-1 text-xs text-destructive">{errors.name.message}</p>}
      </div>
      <NativeSelect aria-label="Gate type" className="sm:w-44" {...form.register("type")}>
        {Object.entries(GATE_TYPE_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </NativeSelect>
      <Button type="submit" variant="secondary" disabled={isSubmitting}>
        Add gate
      </Button>
    </form>
  );
}

function SiteCard({ site }: { site: Doc<"sites"> }) {
  const { organizationId, can } = useActiveOrg();
  const gates = useQuery(api.gates.listBySite, { organizationId, siteId: site._id });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {site.name}
          {site.status === "inactive" && <Badge variant="outline">Inactive</Badge>}
        </CardTitle>
        <CardDescription>
          {[site.address, site.timeZone].filter(Boolean).join(" · ")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {gates === undefined ? (
          <Skeleton className="h-6 w-40" />
        ) : gates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No gates yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {gates.map((g) => (
              <li key={g._id}>
                <div className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>{g.name}</span>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    {GATE_TYPE_LABELS[g.type]}
                    {g.status === "inactive" && <Badge variant="outline">Inactive</Badge>}
                  </span>
                </div>
                {can("sites:manage") && <KioskDevices gateId={g._id} />}
              </li>
            ))}
          </ul>
        )}
        {can("sites:manage") && <NewGateForm siteId={site._id} />}
      </CardContent>
    </Card>
  );
}

export default function SitesPage() {
  const { organizationId, can } = useActiveOrg();
  const sites = useQuery(api.sites.list, { organizationId });
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageHeader
        title="Sites & gates"
        description="Physical locations and the entrances where visitors and staff are recorded."
        actions={
          can("sites:manage") && !adding ? <Button onClick={() => setAdding(true)}>Add site</Button> : null
        }
      />
      {adding && (
        <Card>
          <CardHeader>
            <CardTitle>New site</CardTitle>
          </CardHeader>
          <CardContent>
            <NewSiteForm onDone={() => setAdding(false)} />
          </CardContent>
        </Card>
      )}
      {sites === undefined ? (
        <Skeleton className="h-40 w-full" />
      ) : sites.length === 0 ? (
        <p className="text-muted-foreground">You do not have access to any sites.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {sites.map((site) => (
            <SiteCard key={site._id} site={site} />
          ))}
        </div>
      )}
    </>
  );
}
