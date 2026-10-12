"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { PageHeader } from "@/components/layout/page-header";
import { useSiteGates } from "@/components/visits/use-site-gates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";

type WalkInValues = {
  name: string;
  phone: string;
  company: string;
  purpose: string;
  hostUserId: string;
};

function WalkInForm({
  siteId,
  gateId,
  onDone,
}: {
  siteId: Id<"sites">;
  gateId: Id<"gates"> | undefined;
  onDone: () => void;
}) {
  const { organizationId } = useActiveOrg();
  const register = useMutation(api.visits.registerWalkIn);
  const hosts = useQuery(api.appointments.hostOptions, { organizationId, siteId });
  const form = useForm<WalkInValues>({
    defaultValues: { name: "", phone: "", company: "", purpose: "", hostUserId: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (v) => {
    try {
      await register({
        organizationId,
        siteId,
        visitor: {
          name: v.name,
          phone: v.phone || undefined,
          company: v.company || undefined,
        },
        purpose: v.purpose,
        hostUserId: v.hostUserId ? (v.hostUserId as Id<"users">) : undefined,
        gateId,
      });
      toast.success("Walk-in registered");
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <Field id="wi-name" label="Visitor name" error={errors.name?.message}>
        <Input id="wi-name" {...form.register("name", { required: "Enter the visitor's name." })} />
      </Field>
      <Field id="wi-phone" label="Phone (optional)">
        <Input id="wi-phone" type="tel" {...form.register("phone")} />
      </Field>
      <Field id="wi-company" label="Company (optional)">
        <Input id="wi-company" {...form.register("company")} />
      </Field>
      <Field id="wi-host" label="Visiting (optional)">
        <NativeSelect id="wi-host" {...form.register("hostUserId")}>
          <option value="">Not specified</option>
          {hosts?.map((h) => (
            <option key={h.userId} value={h.userId}>
              {h.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="sm:col-span-2">
        <Field id="wi-purpose" label="Purpose of visit" error={errors.purpose?.message}>
          <Input id="wi-purpose" {...form.register("purpose", { required: "Enter the purpose of the visit." })} />
        </Field>
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Register walk-in"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function VisitsPage() {
  const { organizationId, can } = useActiveOrg();
  const { sites, siteId, setSiteId, gates } = useSiteGates();
  const [gateChoice, setGateChoice] = useState<Id<"gates"> | null>(null);
  const [adding, setAdding] = useState(false);
  const canRead = can("visits:read_site");
  const visits = useQuery(
    api.visits.listActive,
    canRead && siteId ? { organizationId, siteId } : "skip",
  );
  const admit = useMutation(api.visits.admit);
  const checkOut = useMutation(api.visits.checkOut);
  const gateId = gateChoice ?? gates?.[0]?._id;
  const canCheckIn = can("visits:check_in");
  const canCheckOut = can("visits:check_out");

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader
        title="Visits"
        description="Visitors on site and those waiting to be admitted."
        actions={
          can("visitors:register_walk_in") && siteId && !adding ? (
            <Button onClick={() => setAdding(true)}>Register walk-in</Button>
          ) : null
        }
      />

      <div className="flex flex-wrap gap-3">
        {sites && sites.length > 1 && (
          <NativeSelect
            aria-label="Site"
            className="w-48"
            value={siteId ?? ""}
            onChange={(e) => setSiteId(e.target.value as Id<"sites">)}
          >
            {sites.map((s) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        )}
        {(canCheckIn || canCheckOut) && gates && gates.length > 0 && (
          <NativeSelect
            aria-label="Gate"
            className="w-48"
            value={gateId ?? ""}
            onChange={(e) => setGateChoice(e.target.value as Id<"gates">)}
          >
            {gates.map((g) => (
              <option key={g._id} value={g._id}>
                {g.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>

      {adding && siteId && (
        <Card>
          <CardHeader>
            <CardTitle>Register walk-in</CardTitle>
          </CardHeader>
          <CardContent>
            <WalkInForm siteId={siteId} gateId={gateId} onDone={() => setAdding(false)} />
          </CardContent>
        </Card>
      )}

      {!canRead ? (
        <p className="text-muted-foreground">You do not have access to the visit list.</p>
      ) : visits === undefined ? (
        <Skeleton className="h-40 w-full" />
      ) : visits.length === 0 ? (
        <p className="text-muted-foreground">No visitors on site right now.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {visits.map((visit) => (
            <li key={visit._id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="space-y-0.5">
                <p className="font-medium">
                  {visit.visitorName}{" "}
                  <Badge variant={visit.status === "on_site" ? "default" : "secondary"}>
                    {visit.status === "on_site" ? "On site" : "Awaiting admission"}
                  </Badge>
                </p>
                <p className="text-sm text-muted-foreground">
                  {visit.purpose}
                  {visit.hostName ? ` · Visiting ${visit.hostName}` : ""}
                  {visit.badgeCode ? ` · Badge ${visit.badgeCode}` : ""}
                  {visit.checkedInAt
                    ? ` · In ${new Date(visit.checkedInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                    : ""}
                </p>
              </div>
              {gateId && visit.status === "expected" && canCheckIn && (
                <Button
                  size="sm"
                  onClick={() =>
                    act(() => admit({ organizationId, visitId: visit._id, gateId }), "Visitor admitted")
                  }
                >
                  Admit
                </Button>
              )}
              {gateId && visit.status === "on_site" && canCheckOut && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    act(() => checkOut({ organizationId, visitId: visit._id, gateId }), "Visitor checked out")
                  }
                >
                  Check out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
