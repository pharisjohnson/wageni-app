"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";

/** Approval and face-capture policy (F1). Settings page shows this card. */
export function PolicySettingsCard() {
  const { organizationId } = useActiveOrg();
  const policy = useQuery(api.policies.get, { organizationId });
  const updateOrg = useMutation(api.policies.updateOrganization);
  const updateSite = useMutation(api.policies.updateSite);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!policy) return <Skeleton className="h-40 w-full" />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Approvals and face capture</CardTitle>
        <CardDescription>Applies to appointments and invitation links.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={policy.requireApproval}
            disabled={busy}
            onChange={(e) =>
              run(
                () => updateOrg({ organizationId, faceCaptureEnabled: policy.faceCaptureEnabled, requireApproval: e.target.checked }),
                "Approval policy saved",
              )
            }
          />
          <span>
            <span className="font-medium">Hosts must approve appointments</span>
            <span className="block text-muted-foreground">When off, appointments and invitation submissions are approved automatically.</span>
          </span>
        </label>

        {policy.sites.length > 1 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Per-site override</p>
            {policy.sites.map((s) => (
              <label key={s.siteId} className="flex items-center justify-between gap-3 text-sm">
                {s.name}
                <NativeSelect
                  className="w-56"
                  disabled={busy}
                  value={s.requireApproval === null ? "inherit" : String(s.requireApproval)}
                  onChange={(e) =>
                    run(
                      () =>
                        updateSite({
                          organizationId,
                          siteId: s.siteId as Id<"sites">,
                          requireApproval: e.target.value === "inherit" ? null : e.target.value === "true",
                        }),
                      "Site policy saved",
                    )
                  }
                >
                  <option value="inherit">Follow organization</option>
                  <option value="true">Approval required</option>
                  <option value="false">No approval needed</option>
                </NativeSelect>
              </label>
            ))}
          </div>
        )}

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={policy.faceCaptureEnabled}
            disabled={busy}
            onChange={(e) =>
              run(
                () => updateOrg({ organizationId, faceCaptureEnabled: e.target.checked, requireApproval: policy.requireApproval }),
                e.target.checked ? "Face capture enabled" : "Face capture disabled",
              )
            }
          />
          <span>
            <span className="font-medium">Allow face photos on forms</span>
            <span className="block text-muted-foreground">
              Off by default. This only allows a plain photo for the badge and visit record, and every face field needs an explicit
              consent checkbox. No face matching or recognition exists. Face photos are sensitive and deleted on the field&apos;s retention date.
              Turning this off hides face fields from visitors immediately.
            </span>
          </span>
        </label>
      </CardContent>
    </Card>
  );
}
