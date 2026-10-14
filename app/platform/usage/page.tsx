"use client";

import { usePaginatedQuery } from "convex/react";
import { PageHeader } from "@/components/layout/page-header";
import { GrantPlan } from "@/components/platform/grant-plan";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/convex/_generated/api";
import { TIER_LABELS, type Limit } from "@/lib/billing/entitlements";

const of = (used: number, limit: Limit) => (limit === null ? `${used}` : `${used} / ${limit}`);

export default function PlatformUsagePage() {
  const { results, status, loadMore } = usePaginatedQuery(api.billing.platformUsage, {}, { initialNumItems: 25 });
  return (
    <>
      <PageHeader
        title="Usage"
        description="Plan and usage counts per organization for the current month (UTC). Counts only: no visitor or staff data."
      />
      {status === "LoadingFirstPage" ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organization</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Sites</TableHead>
                <TableHead>Gates</TableHead>
                <TableHead>Staff</TableHead>
                <TableHead>Visits (month)</TableHead>
                <TableHead>Messages (month)</TableHead>
                <TableHead>Files (month)</TableHead>
                <TableHead>Plan access</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((o) => (
                <TableRow key={o._id}>
                  <TableCell className="font-medium">
                    {o.name} <span className="text-muted-foreground">({o.slug})</span>{" "}
                    {o.isDemo && <Badge variant="secondary">Demo</Badge>}
                  </TableCell>
                  <TableCell>
                    {o.enforced ? TIER_LABELS[o.tier] : <span className="text-muted-foreground">Not enforced</span>}
                    {o.subscriptionStatus && <span className="text-muted-foreground"> · {o.subscriptionStatus}</span>}
                  </TableCell>
                  <TableCell>{of(o.sites, o.enforced ? o.limits.sites : null)}</TableCell>
                  <TableCell>{of(o.gates, o.enforced ? o.limits.gates : null)}</TableCell>
                  <TableCell>{of(o.staff, o.enforced ? o.limits.staff : null)}</TableCell>
                  <TableCell>{of(o.visits, o.enforced ? o.limits.visitsPerMonth : null)}</TableCell>
                  <TableCell>{of(o.notifications, o.enforced ? o.limits.notificationsPerMonth : null)}</TableCell>
                  <TableCell>
                    {o.files} ({Math.round(o.fileBytes / 1024 / 1024)} MB)
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1.5">
                      {o.subscriptionEnd && (
                        <p className="text-xs text-muted-foreground">
                          {o.subscriptionSource ?? "payment"} until {new Date(o.subscriptionEnd).toLocaleDateString()}
                        </p>
                      )}
                      <GrantPlan organizationId={o._id} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {status === "CanLoadMore" && (
        <Button variant="outline" onClick={() => loadMore(25)}>
          Load more
        </Button>
      )}
    </>
  );
}
