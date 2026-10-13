"use client";

import { useParams } from "next/navigation";
import { FormBuilder } from "@/components/forms-builder/form-builder";
import type { Id } from "@/convex/_generated/dataModel";
import { useActiveOrg } from "@/lib/org/active-org";

export default function FormBuilderPage() {
  const { formId } = useParams<{ formId: string }>();
  const { can } = useActiveOrg();
  if (!can("forms:manage")) {
    return <p className="text-muted-foreground">You do not have permission to manage forms.</p>;
  }
  return <FormBuilder formId={formId as Id<"forms">} />;
}
