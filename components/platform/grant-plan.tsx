"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { toastError } from "@/components/billing/plan-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/** Platform operators: give an organization a plan until a date (manual or invoiced customers). Audit-logged. */
export function GrantPlan({ organizationId }: { organizationId: Id<"organizations"> }) {
  const grant = useMutation(api.platform.grantPlan);
  const [open, setOpen] = useState(false);
  const [planKey, setPlanKey] = useState<"business" | "enterprise">("enterprise");
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Grant plan
      </Button>
    );
  }
  return (
    <form
      className="flex min-w-64 flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const end = new Date(`${until}T23:59:59Z`).getTime();
        grant({ organizationId, planKey, until: end, reason })
          .then(() => {
            toast.success("Plan granted");
            setOpen(false);
            setReason("");
          })
          .catch(toastError);
      }}
    >
      <NativeSelect aria-label="Plan" value={planKey} onChange={(e) => setPlanKey(e.target.value as "business" | "enterprise")}>
        <option value="business">Business</option>
        <option value="enterprise">Enterprise</option>
      </NativeSelect>
      <Input type="date" aria-label="Until" required value={until} onChange={(e) => setUntil(e.target.value)} />
      <Input
        aria-label="Reason"
        placeholder="Reason (audit log)"
        required
        minLength={5}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" type="submit">
          Grant
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
