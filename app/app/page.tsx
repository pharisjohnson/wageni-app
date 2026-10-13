"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { Building2, CalendarClock, DoorOpen, LogIn, UserCheck, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { ROLE_LABELS } from "@/lib/permissions";
import { useActiveOrg } from "@/lib/org/active-org";

function StatCard({
  label,
  value,
  capped,
  icon: Icon,
}: {
  label: string;
  value: number | null | undefined;
  capped: boolean;
  icon: typeof Users;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardDescription>{label}</CardDescription>
        <Icon className="size-4 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent>
        {value === undefined ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <p className="text-3xl font-semibold tabular-nums">
            {value}
            {capped ? "+" : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { org, organizationId, can } = useActiveOrg();
  const summary = useQuery(api.dashboard.summary, { organizationId });
  // P1: today's key numbers (each is null when the role may not see it)
  const today = useQuery(api.reports.today, { organizationId });

  const stats = [
    { key: "sites", label: "Active sites", icon: Building2, value: summary?.sites },
    { key: "gates", label: "Gates & entrances", icon: DoorOpen, value: summary?.gates },
    { key: "members", label: "Team members", icon: Users, value: summary?.members },
  ].filter((s) => summary === undefined || s.value !== null);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Signed in as ${ROLE_LABELS[org.membership.role]} at ${org.name}.`}
        actions={
          <Link href={`/kiosk/${org.slug}`} className={buttonVariants({ variant: "outline" })}>
            Open kiosk
          </Link>
        }
      />
      {/* P1: today at a glance */}
      {(today === undefined || [today.onSite, today.expected, today.checkedInToday, today.staffIn].some((n) => n !== null)) && (
        <section aria-label="Today" className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Today</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { key: "onSite", label: "On site now", icon: DoorOpen, value: today?.onSite },
              { key: "expected", label: "Expected", icon: CalendarClock, value: today?.expected },
              { key: "checkedIn", label: "Checked in today", icon: LogIn, value: today?.checkedInToday },
              { key: "staffIn", label: "Staff in", icon: UserCheck, value: today?.staffIn },
            ]
              .filter((s) => today === undefined || s.value !== null)
              .map((s) => (
                <StatCard key={s.key} label={s.label} icon={s.icon} value={s.value} capped={today?.capped ?? false} />
              ))}
          </div>
        </section>
      )}
      {/* end P1 */}
      {stats.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {stats.map((s) => (
            <StatCard key={s.key} label={s.label} icon={s.icon} value={s.value} capped={summary?.capped ?? false} />
          ))}
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Getting started</CardTitle>
          <CardDescription>
            Visitor, appointment and attendance figures will appear here as those modules are released.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {can("sites:manage") && (
            <Link href="/app/sites" className={buttonVariants({ variant: "secondary" })}>
              Set up sites and gates
            </Link>
          )}
          {can("members:read") && (
            <Link href="/app/team" className={buttonVariants({ variant: "secondary" })}>
              Review team
            </Link>
          )}
          {can("settings:manage") && (
            <Link href="/app/settings" className={buttonVariants({ variant: "secondary" })}>
              Configure kiosk branding
            </Link>
          )}
        </CardContent>
      </Card>
    </>
  );
}
