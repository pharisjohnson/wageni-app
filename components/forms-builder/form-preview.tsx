"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { FormField } from "@/lib/validation/forms";
import { FormRenderer, type RendererVariant } from "./form-renderer";
import { useFormController } from "./use-form-controller";

/**
 * Live preview: the same renderer visitors use. Nothing is uploaded or saved.
 * "Check" runs the shared validation so the admin can try required fields
 * and show-if rules.
 */
export function FormPreview({
  fields,
  faceCaptureEnabled,
  title = "Live preview",
  description = "This is what visitors will see. Nothing you type here is saved.",
}: {
  fields: FormField[];
  faceCaptureEnabled: boolean;
  title?: string;
  description?: string;
}) {
  const [variant, setVariant] = useState<RendererVariant>("page");
  const [result, setResult] = useState<string | null>(null);
  const skip = useMemo(() => (faceCaptureEnabled ? [] : (["face_photo"] as const)), [faceCaptureEnabled]);
  const ctrl = useFormController(fields, { skipTypes: skip });
  // Previewing never uploads: a captured file just gets a placeholder id.
  const uploader = useMemo(() => async () => "preview", []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Button type="button" size="sm" variant={variant === "page" ? "default" : "outline"} onClick={() => setVariant("page")}>
            Phone / page
          </Button>
          <Button type="button" size="sm" variant={variant === "kiosk" ? "default" : "outline"} onClick={() => setVariant("kiosk")}>
            Kiosk
          </Button>
        </div>
        <div className="max-w-xl space-y-4 rounded-xl border p-4">
          {fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">Add fields to see a preview.</p>
          ) : (
            <FormRenderer fields={fields} ctrl={ctrl} uploader={uploader} variant={variant} />
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => setResult(ctrl.validate() ? "Everything is valid." : "Some answers need attention.")}
          >
            Check answers
          </Button>
          {result && (
            <span role="status" className="text-sm text-muted-foreground">
              {result}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
