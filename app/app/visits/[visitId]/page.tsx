"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { VisitResponses } from "@/components/forms-builder/visit-responses";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";

const EVENT_LABELS = {
  registered: "Registered",
  checked_in: "Checked in",
  meeting_ended: "Meeting ended by host",
  checked_out: "Checked out",
} as const;

const STATUS_LABELS = {
  expected: "Awaiting admission",
  on_site: "On site",
  checked_out: "Checked out",
} as const;

const METHOD_LABELS = {
  host: "Cleared by host",
  gate: "Checked out at gate",
  reception: "Checked out at reception",
  kiosk: "Checked out at kiosk",
} as const;

function formatTime(ms: number) {
  return new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function VisitDetailPage() {
  const { visitId } = useParams<{ visitId: string }>();
  const { organizationId, can } = useActiveOrg();
  const visit = useQuery(api.visits.get, { organizationId, visitId: visitId as Id<"visits"> });
  const me = useQuery(api.users.me);
  const gates = useQuery(
    api.gates.listBySite,
    visit && can("sites:read") ? { organizationId, siteId: visit.siteId } : "skip",
  );
  const admit = useMutation(api.visits.admit);
  const checkOut = useMutation(api.visits.checkOut);
  const hostCheckOut = useMutation(api.visits.hostCheckOut);
  // "" means the person explicitly chose no gate (reception check-out).
  const [gateChoice, setGateChoice] = useState<Id<"gates"> | "" | null>(null);
  const activeGates = gates?.filter((g) => g.status === "active");
  const gateId = gateChoice === "" ? undefined : (gateChoice ?? activeGates?.[0]?._id);

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const back = { href: "/app/visits", label: "Back to visits" };
  if (visit === undefined) {
    return (
      <>
        <PageHeader title="Visit" back={back} />
        <Skeleton className="h-48 w-full" />
      </>
    );
  }

  const isOwnHost = Boolean(me) && visit.hostUserId === me?._id && can("visits:check_out_own");
  const canAdmit = visit.status === "expected" && can("visits:check_in") && Boolean(gateId);
  const canCheckOutAny = visit.status === "on_site" && can("visits:check_out");
  const canCheckOutOwn = visit.status === "on_site" && isOwnHost && !can("visits:check_out");

  return (
    <>
      <PageHeader
        title={visit.visitor?.name ?? "Visit"}
        description={visit.purpose}
        back={back}
        actions={
          <>
            {canAdmit && gateId && (
              <Button onClick={() => act(() => admit({ organizationId, visitId: visit._id, gateId }), "Visitor admitted")}>
                Admit
              </Button>
            )}
            {canCheckOutAny && (
              <Button
                variant="secondary"
                onClick={() =>
                  act(() => checkOut({ organizationId, visitId: visit._id, gateId }), "Visitor checked out")
                }
              >
                Check out
              </Button>
            )}
            {canCheckOutOwn && (
              <Button onClick={() => act(() => hostCheckOut({ organizationId, visitId: visit._id }), "Meeting ended")}>
                Meeting done / check out
              </Button>
            )}
          </>
        }
      />

      {(canAdmit || canCheckOutAny) && activeGates && activeGates.length > 0 && (
        <NativeSelect
          aria-label="Gate"
          className="w-48"
          value={gateId ?? ""}
          onChange={(e) => setGateChoice(e.target.value as Id<"gates"> | "")}
        >
          {canCheckOutAny && <option value="">No gate (reception)</option>}
          {activeGates.map((g) => (
            <option key={g._id} value={g._id}>
              {g.name}
            </option>
          ))}
        </NativeSelect>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <Badge variant={visit.status === "on_site" ? "default" : "secondary"}>
                {STATUS_LABELS[visit.status]}
              </Badge>
              {visit.checkedOutMethod && (
                <span className="ml-2 text-muted-foreground">{METHOD_LABELS[visit.checkedOutMethod]}</span>
              )}
            </p>
            <p>Visitor: {visit.visitor?.name ?? "Unknown"}</p>
            {visit.visitor?.company && <p>Company: {visit.visitor.company}</p>}
            {visit.visitor?.phone && <p>Phone: {visit.visitor.phone}</p>}
            <p>Host: {visit.hostName ?? "Not specified"}</p>
            {visit.badgeCode && <p>Badge code: {visit.badgeCode}</p>}
            {visit.appointmentId && (
              <p>
                <Link
                  href={`/app/appointments/${visit.appointmentId}`}
                  className="underline underline-offset-4"
                >
                  View appointment
                </Link>
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3 border-l pl-4">
              {visit.events.map((e) => (
                <li key={e._id} className="text-sm">
                  <p className="font-medium">{EVENT_LABELS[e.type]}</p>
                  <p className="text-muted-foreground">
                    {formatTime(e.at)} · {e.actorName}
                    {e.gateName ? ` · ${e.gateName}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
      {/* F1: form answers (sensitive values need forms:read_sensitive and are audited) */}
      <VisitResponses visitId={visit._id} />
    </>
  );
}
