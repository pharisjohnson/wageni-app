"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { Field } from "@/components/forms/field";
import { RetentionSettings } from "@/components/reports/retention-form"; // P1
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/auth/errors";
import { useActiveOrg } from "@/lib/org/active-org";
import { brandingSchema } from "@/lib/validation/organization";

type BrandingForm = z.input<typeof brandingSchema>;

/** Empty inputs mean "not set" rather than an empty string. */
function clean(values: BrandingForm) {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => typeof v === "string" && v.trim() !== ""),
  ) as BrandingForm;
}

export default function SettingsPage() {
  const { org, organizationId, can } = useActiveOrg();
  const updateBranding = useMutation(api.organizations.updateBranding);
  const form = useForm<BrandingForm>({
    resolver: async (values, ctx, opts) => zodResolver(brandingSchema)(clean(values), ctx, opts),
    defaultValues: {
      logoUrl: org.branding.logoUrl ?? "",
      primaryColor: org.branding.primaryColor ?? "",
      welcomeText: org.branding.welcomeText ?? "",
      privacyNotice: org.branding.privacyNotice ?? "",
    },
  });
  const { errors, isSubmitting, isDirty } = form.formState;

  if (!can("settings:manage")) {
    return <p className="text-muted-foreground">You do not have permission to change settings.</p>;
  }

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await updateBranding({ organizationId, branding: clean(values) });
      form.reset(values);
      toast.success("Branding saved");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  return (
    <>
      <PageHeader title="Settings" description={`Organization address: /kiosk/${org.slug}`} />
      <Card>
        <CardHeader>
          <CardTitle>Kiosk branding</CardTitle>
          <CardDescription>Shown on your organization&apos;s visitor and staff kiosk.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid max-w-xl gap-4" noValidate>
            <Field id="logoUrl" label="Logo URL (https)" error={errors.logoUrl?.message}>
              <Input id="logoUrl" type="url" placeholder="https://…" {...form.register("logoUrl")} />
            </Field>
            <Field id="primaryColor" label="Brand colour" error={errors.primaryColor?.message} help="Hex value, e.g. #0F766E">
              <Input id="primaryColor" placeholder="#0F766E" {...form.register("primaryColor")} />
            </Field>
            <Field id="welcomeText" label="Welcome text" error={errors.welcomeText?.message}>
              <Input id="welcomeText" {...form.register("welcomeText")} />
            </Field>
            <Field
              id="privacyNotice"
              label="Privacy notice"
              error={errors.privacyNotice?.message}
              help="Explain what visitor data you collect, why, and how long you keep it."
            >
              <Textarea id="privacyNotice" rows={5} {...form.register("privacyNotice")} />
            </Field>
            <Button type="submit" className="justify-self-start" disabled={isSubmitting || !isDirty}>
              {isSubmitting ? "Saving…" : "Save branding"}
            </Button>
          </form>
        </CardContent>
      </Card>
      {/* P1: data retention */}
      <RetentionSettings />
      {/* end P1 */}
    </>
  );
}
