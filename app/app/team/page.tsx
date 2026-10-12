"use client";

import { useMutation, usePaginatedQuery } from "convex/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { canAssignRole, ORG_ROLES, ROLE_LABELS, ROLE_RANK, type OrgRole } from "@/lib/permissions";
import { useActiveOrg } from "@/lib/org/active-org";

export default function TeamPage() {
  const { organizationId, org, can } = useActiveOrg();
  const { results, status, loadMore } = usePaginatedQuery(
    api.memberships.list,
    { organizationId },
    { initialNumItems: 50 },
  );
  const updateRole = useMutation(api.memberships.updateRole);
  const setStatus = useMutation(api.memberships.setStatus);
  const actorRole = org.membership.role;
  const canManage = can("members:manage");

  const manageable = (role: OrgRole, isSelf: boolean) =>
    canManage && !isSelf && (actorRole === "owner" || ROLE_RANK[role] < ROLE_RANK[actorRole]);

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      toast.success(success);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader
        title="Team"
        description="Members of this organization and their roles. Invitations arrive in Phase 4."
      />
      {status === "LoadingFirstPage" ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Sites</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((m) => {
                const editable = manageable(m.role, m.isSelf);
                const id = m._id as Id<"memberships">;
                return (
                  <TableRow key={m._id}>
                    <TableCell>
                      <div className="font-medium">
                        {m.user.name ?? "Unnamed user"} {m.isSelf && <Badge variant="secondary">You</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground">{m.user.email}</div>
                    </TableCell>
                    <TableCell>
                      {editable ? (
                        <NativeSelect
                          aria-label={`Role for ${m.user.name ?? m.user.email ?? "member"}`}
                          className="w-40"
                          value={m.role}
                          onChange={(e) =>
                            run(
                              () =>
                                updateRole({ organizationId, membershipId: id, role: e.target.value as OrgRole }),
                              "Role updated",
                            )
                          }
                        >
                          {ORG_ROLES.filter((r) => r === m.role || canAssignRole(actorRole, m.role, r)).map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </NativeSelect>
                      ) : (
                        ROLE_LABELS[m.role]
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {m.siteAccess === "all" ? "All sites" : `${m.siteAccess.length} site(s)`}
                    </TableCell>
                    <TableCell>
                      <Badge variant={m.status === "active" ? "outline" : "secondary"}>{m.status}</Badge>
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        {editable && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              run(
                                () =>
                                  setStatus({
                                    organizationId,
                                    membershipId: id,
                                    status: m.status === "active" ? "disabled" : "active",
                                  }),
                                m.status === "active" ? "Member disabled" : "Member re-enabled",
                              )
                            }
                          >
                            {m.status === "active" ? "Disable" : "Enable"}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
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
