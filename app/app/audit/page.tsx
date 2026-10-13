"use client";

import { usePaginatedQuery, useQuery } from "convex/react";
import { Monitor, Cog, User } from "lucide-react";
import { useMemo, useState } from "react";
import { FeatureGate } from "@/components/billing/upgrade-notice";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/reports/parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AUDIT_ACTION_LABELS, AUDIT_RESOURCE_TYPES, auditActionLabel, auditResourceLabel } from "@/lib/audit/labels";
import { useActiveOrg } from "@/lib/org/active-org";

const ACTIONS = Object.keys(AUDIT_ACTION_LABELS).sort((a, b) => AUDIT_ACTION_LABELS[a]!.localeCompare(AUDIT_ACTION_LABELS[b]!));

/** Local date input (YYYY-MM-DD) to a start/end-of-day instant in the browser's zone. */
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).getTime() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999`).getTime() : undefined);

function ActorIcon({ kind }: { kind: "user" | "kiosk" | "system" }) {
  const Icon = kind === "user" ? User : kind === "kiosk" ? Monitor : Cog;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

function details(metadata: Record<string, string | number | boolean | null> | undefined) {
  if (!metadata) return "";
  return Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()}: ${String(v)}`)
    .join(" · ");
}

export default function AuditPage() {
  return (
    <FeatureGate feature="audit_log">
      <AuditContent />
    </FeatureGate>
  );
}

function AuditContent() {
  const { organizationId, can } = useActiveOrg();
  const allowed = can("audit:read");
  const actors = useQuery(api.audit.actors, allowed ? { organizationId } : "skip");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [resource, setResource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const args = useMemo(
    () => ({
      organizationId,
      ...(actor ? { actorUserId: actor as Id<"users"> } : {}),
      ...(action ? { action } : {}),
      ...(resource ? { resourceType: resource } : {}),
      ...(dayStart(from) !== undefined ? { fromAt: dayStart(from) } : {}),
      ...(dayEnd(to) !== undefined ? { toAt: dayEnd(to) } : {}),
    }),
    [organizationId, actor, action, resource, from, to],
  );
  const { results, status, loadMore } = usePaginatedQuery(api.audit.list, allowed ? args : "skip", { initialNumItems: 25 });

  if (!allowed) return <p className="text-muted-foreground">You do not have permission to view the audit log.</p>;

  const filtered = Boolean(actor || action || resource || from || to);
  const tzNote = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <>
      <PageHeader
        title="Audit log"
        description="A permanent record of sensitive actions: who did what, and when. Entries cannot be edited."
      />
      <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Audit filters">
        <div className="space-y-1">
          <Label htmlFor="au-actor">Person</Label>
          <NativeSelect id="au-actor" value={actor} onChange={(e) => setActor(e.target.value)} className="w-48">
            <option value="">Anyone</option>
            {(actors ?? []).map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="au-action">Action</Label>
          <NativeSelect id="au-action" value={action} onChange={(e) => setAction(e.target.value)} className="w-60">
            <option value="">Any action</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {AUDIT_ACTION_LABELS[a]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="au-resource">Record type</Label>
          <NativeSelect id="au-resource" value={resource} onChange={(e) => setResource(e.target.value)} className="w-48">
            <option value="">Any record</option>
            {AUDIT_RESOURCE_TYPES.map((r) => (
              <option key={r} value={r}>
                {auditResourceLabel(r)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="au-from">From</Label>
          <Input id="au-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="au-to">To</Label>
          <Input id="au-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setActor("");
              setAction("");
              setResource("");
              setFrom("");
              setTo("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Times are shown in your browser&apos;s time zone ({tzNote}).</p>

      {status === "LoadingFirstPage" ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading audit log">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : results.length === 0 ? (
        <EmptyState title={filtered ? "No entries match these filters" : "No audit entries yet"}>
          {filtered ? "Try widening the date range or clearing a filter." : "Actions such as check-ins, role changes and exports will appear here."}
        </EmptyState>
      ) : (
        <Card>
          <CardContent className="space-y-3 pt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((e) => (
                  <TableRow key={e._id}>
                    <TableCell className="whitespace-nowrap">
                      {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(e.at))}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <ActorIcon kind={e.actor.kind} />
                        {e.actor.name}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">{auditActionLabel(e.action)}</span>
                      <span className="block font-mono text-xs text-muted-foreground">{e.action}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{auditResourceLabel(e.resourceType)}</Badge>
                    </TableCell>
                    <TableCell className="max-w-xs break-words text-xs text-muted-foreground">{details(e.metadata)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex justify-center">
              {status === "CanLoadMore" && (
                <Button variant="outline" onClick={() => loadMore(25)}>
                  Load older entries
                </Button>
              )}
              {status === "LoadingMore" && <Skeleton className="h-8 w-40" />}
              {status === "Exhausted" && <p className="text-sm text-muted-foreground">End of the log.</p>}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
