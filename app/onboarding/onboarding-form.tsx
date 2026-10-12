"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/auth/errors";
import { rememberActiveOrganization } from "@/lib/org/active-org";
import { browserTimeZone, timeZoneOptions } from "@/lib/time-zones";
import { createOrganizationSchema, type CreateOrganizationInput } from "@/lib/validation/organization";

function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function OnboardingForm() {
  const router = useRouter();
  const createOrganization = useMutation(api.organizations.create);
  const form = useForm<CreateOrganizationInput>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: { name: "", slug: "", timeZone: browserTimeZone(), siteName: "Head office" },
  });
  const { errors, isSubmitting, dirtyFields } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const { organizationId } = await createOrganization(values);
      rememberActiveOrganization(organizationId);
      toast.success("Organization created");
      router.push("/app");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Create your organization</CardTitle>
        <CardDescription>
          You will be the owner. You can add more sites, gates and team members afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <Field id="name" label="Organization name" error={errors.name?.message}>
            <Input
              id="name"
              autoFocus
              aria-invalid={!!errors.name}
              {...form.register("name", {
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                  if (!dirtyFields.slug) form.setValue("slug", slugify(e.target.value));
                },
              })}
            />
          </Field>
          <Field
            id="slug"
            label="Kiosk address"
            error={errors.slug?.message}
            help="Used in your kiosk link: /kiosk/your-address"
          >
            <Input id="slug" aria-invalid={!!errors.slug} {...form.register("slug")} />
          </Field>
          <Field id="siteName" label="First site name" error={errors.siteName?.message}>
            <Input id="siteName" aria-invalid={!!errors.siteName} {...form.register("siteName")} />
          </Field>
          <Field id="timeZone" label="Time zone" error={errors.timeZone?.message}>
            <NativeSelect id="timeZone" {...form.register("timeZone")}>
              {timeZoneOptions().map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Button type="submit" size="lg" disabled={isSubmitting}>
            {isSubmitting ? "Creating…" : "Create organization"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
