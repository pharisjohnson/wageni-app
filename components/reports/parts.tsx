"use client";

import { useMutation } from "convex/react";
import { Download } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";
import { PRESETS, type Preset } from "./format";

export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

export function ReportSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading report">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="mt-1 text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

export function TruncatedNotice({ truncated, cap }: { truncated: boolean; cap?: number }) {
  if (!truncated) return null;
  return (
    <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      This range has more records than a report can read{cap ? ` (the newest ${cap} are included)` : ""}. Totals are
      partial; choose a shorter range or a single site for exact figures.
    </p>
  );
}

export function ShowMore({
  shown,
  total,
  limit,
  onMore,
}: {
  shown: number;
  total: number;
  limit: number;
  onMore: () => void;
}) {
  if (total <= shown) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
      <span>
        Showing {shown} of {total}. Export for the full list.
      </span>
      {limit < 500 && (
        <Button variant="outline" size="sm" onClick={onMore}>
          Show more
        </Button>
      )}
    </div>
  );
}

export type Filters = {
  preset: Preset;
  customFrom: string;
  customTo: string;
  siteId: string;
  personId: string;
};

export function FilterBar({
  filters,
  onChange,
  sites,
  people,
  personLabel,
  hideRange,
  rangeText,
  problem,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  sites: { siteId: string; name: string }[];
  people: { userId: string; name: string }[];
  personLabel: string;
  hideRange?: boolean;
  rangeText?: string;
  problem?: string | null;
}) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Report filters">
        {!hideRange && (
          <div className="space-y-1">
            <Label htmlFor="rf-preset">Date range</Label>
            <NativeSelect id="rf-preset" value={filters.preset} onChange={(e) => set({ preset: e.target.value as Preset })} className="w-44">
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        {!hideRange && filters.preset === "custom" && (
          <>
            <div className="space-y-1">
              <Label htmlFor="rf-from">From</Label>
              <Input id="rf-from" type="date" value={filters.customFrom} onChange={(e) => set({ customFrom: e.target.value })} className="w-40" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rf-to">To</Label>
              <Input id="rf-to" type="date" value={filters.customTo} onChange={(e) => set({ customTo: e.target.value })} className="w-40" />
            </div>
          </>
        )}
        {sites.length > 1 && (
          <div className="space-y-1">
            <Label htmlFor="rf-site">Site</Label>
            <NativeSelect id="rf-site" value={filters.siteId} onChange={(e) => set({ siteId: e.target.value })} className="w-48">
              <option value="">All sites</option>
              {sites.map((s) => (
                <option key={s.siteId} value={s.siteId}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        {personLabel && (
          <div className="space-y-1">
            <Label htmlFor="rf-person">{personLabel}</Label>
            <NativeSelect id="rf-person" value={filters.personId} onChange={(e) => set({ personId: e.target.value })} className="w-48">
              <option value="">Everyone</option>
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : (
        rangeText && <p className="text-sm text-muted-foreground">{rangeText}</p>
      )}
    </div>
  );
}

export type ExportArgs = {
  report: "visits" | "on_site" | "appointments" | "attendance" | "host_meetings";
  fromDate?: string;
  toDate?: string;
  siteId?: Id<"sites">;
  hostUserId?: Id<"users">;
  userId?: Id<"users">;
  at?: number;
};

/** Generates the CSV on the server (audited) and saves it from the browser. */
export function ExportButton({ args, disabled }: { args: ExportArgs; disabled?: boolean }) {
  const { organizationId, can } = useActiveOrg();
  const exportCsv = useMutation(api.reportsExport.csv);
  const [busy, setBusy] = useState(false);
  if (!can("reports:export")) return null;

  async function run() {
    setBusy(true);
    try {
      const out = await exportCsv({ organizationId, ...args });
      const url = URL.createObjectURL(new Blob([out.csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = out.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (out.message) toast.warning(out.message);
      else toast.success(`Exported ${out.rowCount} row${out.rowCount === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" onClick={run} disabled={busy || disabled}>
      <Download aria-hidden />
      {busy ? "Preparing…" : "Export CSV"}
    </Button>
  );
}
