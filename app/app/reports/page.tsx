"use client";

import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { fmtDate, presetRange, rangeProblem } from "@/components/reports/format";
import { FilterBar, ReportSkeleton, type Filters } from "@/components/reports/parts";
import { AppointmentsTab, AttendanceTab, HostMeetingsTab, OnSiteTab, VisitsTab } from "@/components/reports/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useActiveOrg } from "@/lib/org/active-org";
import { cn } from "@/lib/utils";

type TabKey = "visits" | "on_site" | "appointments" | "attendance" | "host_meetings";

const TABS: { key: TabKey; label: string; person: string; ranged: boolean; maxDays: number }[] = [
  { key: "visits", label: "Visits", person: "Host", ranged: true, maxDays: 93 },
  { key: "on_site", label: "On site", person: "", ranged: false, maxDays: 93 },
  { key: "appointments", label: "Appointments", person: "Host", ranged: true, maxDays: 93 },
  { key: "attendance", label: "Attendance", person: "Person", ranged: true, maxDays: 62 },
  { key: "host_meetings", label: "Host meetings", person: "Host", ranged: true, maxDays: 93 },
];

export default function ReportsPage() {
  const { organizationId, org, can } = useActiveOrg();
  const options = useQuery(api.reports.filterOptions, can("reports:read") ? { organizationId } : "skip");
  const tabs = TABS.filter((t) => t.key !== "attendance" || can("staff_attendance:read_site"));
  const [tab, setTab] = useState<TabKey>("visits");
  const [filters, setFilters] = useState<Filters>({
    preset: "last7",
    customFrom: "",
    customTo: "",
    siteId: "",
    personId: "",
  });

  const active = tabs.find((t) => t.key === tab) ?? tabs[0]!;
  const tz = options?.timeZone ?? org.timeZone;
  const range = useMemo(() => {
    if (filters.preset === "custom") return { fromDate: filters.customFrom, toDate: filters.customTo };
    return presetRange(filters.preset, tz);
  }, [filters.preset, filters.customFrom, filters.customTo, tz]);
  const problem =
    active.ranged && (filters.preset !== "custom" || (filters.customFrom && filters.customTo))
      ? rangeProblem(range.fromDate, range.toDate, active.maxDays)
      : active.ranged
        ? "Choose a start and end date."
        : null;

  if (!can("reports:read")) {
    return <p className="text-muted-foreground">You do not have permission to view reports.</p>;
  }

  const common = {
    fromDate: range.fromDate,
    toDate: range.toDate,
    siteId: filters.siteId ? (filters.siteId as Id<"sites">) : undefined,
    personId: filters.personId || undefined,
  };

  return (
    <>
      <PageHeader
        title="Reports"
        description="Visitors, appointments, attendance and host meetings. Figures respect the sites you have access to."
      />
      <div role="tablist" aria-label="Reports" className="flex flex-wrap gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            id={`tab-${t.key}`}
            aria-selected={active.key === t.key}
            aria-controls="report-panel"
            onClick={() => setTab(t.key)}
            className={cn(
              "-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              active.key === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <FilterBar
        filters={filters}
        onChange={setFilters}
        sites={options?.sites ?? []}
        people={options?.people ?? []}
        personLabel={active.person}
        hideRange={!active.ranged}
        problem={problem}
        rangeText={
          active.ranged && !problem
            ? range.fromDate === range.toDate
              ? fmtDate(range.fromDate)
              : `${fmtDate(range.fromDate)} to ${fmtDate(range.toDate)} (${tz})`
            : undefined
        }
      />
      <div role="tabpanel" id="report-panel" aria-labelledby={`tab-${active.key}`} className="space-y-4">
        {options === undefined ? (
          <ReportSkeleton />
        ) : problem ? null : (
          <>
            {active.key === "visits" && <VisitsTab {...common} />}
            {active.key === "on_site" && <OnSiteTab {...common} />}
            {active.key === "appointments" && <AppointmentsTab {...common} />}
            {active.key === "attendance" && <AttendanceTab {...common} />}
            {active.key === "host_meetings" && <HostMeetingsTab {...common} />}
          </>
        )}
      </div>
    </>
  );
}
