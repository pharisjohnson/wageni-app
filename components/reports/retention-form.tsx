"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";
import { RETENTION_LABELS, retentionSchema, type Retention } from "@/lib/retention";

const HELP: Record<keyof Retention, string> = {
  visitRecordsDays:
    "After this, visitor names, phone numbers, emails and badge codes are anonymised. Counts, durations and busy-hour figures are kept for reports.",
  auditLogDays: "After this, audit entries are deleted.",
  attendanceDays: "After this, clock-in/out events and decided corrections are deleted.",
};

const KEYS = Object.keys(RETENTION_LABELS) as (keyof Retention)[];

export function RetentionSettings() {
  const { organizationId, can } = useActiveOrg();
  const allowed = can("settings:manage");
  const current = useQuery(api.retention.get, allowed ? { organizationId } : "skip");
  const preview = useQuery(api.retention.preview, allowed ? { organizationId } : "skip");
  const update = useMutation(api.retention.update);
  const [draft, setDraft] = useState<Record<keyof Retention, string> | null>(null);
  const [saving, setSaving] = useState(false);
  if (!allowed) return null;

  if (current === undefined) {
    return <Skeleton className="h-64 w-full" aria-label="Loading retention settings" />;
  }

  const values: Record<keyof Retention, string> =
    draft ?? Object.fromEntries(KEYS.map((k) => [k, String(current.retention[k])])) as Record<keyof Retention, string>;
  const parsed = retentionSchema.safeParse(Object.fromEntries(KEYS.map((k) => [k, values[k] === "" ? Number.NaN : Number(values[k])])));
  const errors: Partial<Record<keyof Retention, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof Retention;
      errors[key] ??= Number.isNaN(Number(values[key])) || values[key] === "" ? "Enter a number of days." : issue.message;
    }
  }
  const dirty = KEYS.some((k) => values[k] !== String(current.retention[k]));

  async function save() {
    if (!parsed.success) return;
    setSaving(true);
    try {
      await update({ organizationId, retention: parsed.data });
      setDraft(null);
      toast.success("Retention settings saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const pending = preview?.counts;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Data retention</CardTitle>
        <CardDescription>
          How long personal data is kept. Expired data is cleaned up automatically by a scheduled job. Audit and attendance
          records must be kept for at least a year.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid max-w-xl gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {KEYS.map((k) => (
            <Field
              key={k}
              id={`retention-${k}`}
              label={`${RETENTION_LABELS[k]} (days)`}
              error={errors[k]}
              help={`${HELP[k]} Minimum ${current.minimums[k]}, maximum ${current.maxDays}. Default ${current.defaults[k]}.`}
            >
              <Input
                id={`retention-${k}`}
                inputMode="numeric"
                value={values[k]}
                onChange={(e) => setDraft({ ...values, [k]: e.target.value })}
                aria-invalid={Boolean(errors[k])}
              />
            </Field>
          ))}
          <Button type="submit" className="justify-self-start" disabled={saving || !dirty || !parsed.success}>
            {saving ? "Saving…" : "Save retention"}
          </Button>
        </form>
        {pending && (
          <p className="text-sm text-muted-foreground" role="status">
            Past retention right now:{" "}
            {pending.visits + pending.auditLogs + pending.attendanceEvents + pending.attendanceCorrections === 0
              ? "nothing is waiting to be cleaned up."
              : `${pending.visits} visit record(s) to anonymise, ${pending.auditLogs} audit entr${pending.auditLogs === 1 ? "y" : "ies"} and ${pending.attendanceEvents} attendance event(s) to delete${preview?.hasMore ? " (and more)" : ""}. Saving shorter periods applies from the next scheduled run.`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
