"use client";

import { useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { FormPreview } from "@/components/forms-builder/form-preview";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useActiveOrg } from "@/lib/org/active-org";
import { FIELD_TYPE_LABELS, MAPS_TO_LABELS, type FormField } from "@/lib/validation/forms";

/** A published version, read-only. Versions can never be edited. */
export default function FormVersionPage() {
  const { formId, versionId } = useParams<{ formId: string; versionId: string }>();
  const { organizationId, can } = useActiveOrg();
  const allowed = can("forms:manage");
  const version = useQuery(
    api.forms.getVersion,
    allowed ? { organizationId, versionId: versionId as Id<"formVersions"> } : "skip",
  );
  const back = { href: `/app/forms/${formId}`, label: "Back to form" };

  if (!allowed) return <p className="text-muted-foreground">You do not have permission to manage forms.</p>;
  if (version === undefined) {
    return (
      <>
        <PageHeader title="Version" back={back} />
        <Skeleton className="h-48 w-full" />
      </>
    );
  }
  const fields = version.fields as FormField[];
  return (
    <>
      <PageHeader
        title={`${version.name}, version ${version.version}`}
        back={back}
        description={`Published ${new Date(version.publishedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}. This version is read-only.`}
        actions={<Badge variant="secondary">Read-only</Badge>}
      />
      <Card>
        <CardHeader>
          <CardTitle>Fields ({fields.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="divide-y text-sm">
            {fields.map((f, i) => (
              <li key={f.id} className="py-2">
                <span className="font-medium">
                  {i + 1}. {f.label}
                </span>{" "}
                <span className="text-muted-foreground">
                  {FIELD_TYPE_LABELS[f.type]}
                  {f.required && " · required"}
                  {f.sensitive && " · sensitive"}
                  {f.retentionDays && ` · keep ${f.retentionDays} days`}
                  {f.mapsTo && ` · fills ${MAPS_TO_LABELS[f.mapsTo]}`}
                  {f.showIf && ` · shown if ${fields.find((x) => x.id === f.showIf!.fieldId)?.label ?? f.showIf.fieldId} = ${f.showIf.equals}`}
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
      <FormPreview fields={fields} faceCaptureEnabled title="Preview" description="Nothing you type here is saved." />
    </>
  );
}
