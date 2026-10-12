"use client";

import { useMutation, usePaginatedQuery } from "convex/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";

export default function PlatformOrganizationsPage() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.platform.listOrganizations,
    {},
    { initialNumItems: 50 },
  );
  const setStatus = useMutation(api.platform.setOrganizationStatus);

  async function toggle(id: Id<"organizations">, current: string) {
    const next = current === "suspended" ? "active" : "suspended";
    // A reason is mandatory and recorded in the organization's audit log.
    const reason = window.prompt(`Reason for setting this organization to "${next}"?`);
    if (!reason) return;
    try {
      await setStatus({ organizationId: id, status: next, reason });
      toast.success(`Organization ${next}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader title="Organizations" description="Account metadata only." />
      {status === "LoadingFirstPage" ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((o) => (
                <TableRow key={o._id}>
                  <TableCell className="font-medium">
                    {o.name} {o.isDemo && <Badge variant="secondary">Demo</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{o.slug}</TableCell>
                  <TableCell>
                    <Badge variant={o.status === "suspended" ? "destructive" : "outline"}>{o.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(o.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => toggle(o._id, o.status)}>
                      {o.status === "suspended" ? "Reactivate" : "Suspend"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {status === "CanLoadMore" && (
        <Button variant="outline" onClick={() => loadMore(50)}>
          Load more
        </Button>
      )}
    </>
  );
}
