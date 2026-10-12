import { z } from "zod";

export const RESERVED_SLUGS = new Set([
  "app",
  "api",
  "admin",
  "platform",
  "kiosk",
  "sign-in",
  "sign-up",
  "onboarding",
  "pricing",
  "www",
]);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Use at least 3 characters.")
  .max(48, "Use at most 48 characters.")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens.")
  .refine((s) => !RESERVED_SLUGS.has(s), "This address is reserved.");

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone.");

export const nameSchema = z.string().trim().min(2, "Too short.").max(120, "Too long.");

export const createOrganizationSchema = z.object({
  name: nameSchema,
  slug: slugSchema,
  timeZone: timeZoneSchema,
  siteName: nameSchema,
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const siteSchema = z.object({
  name: nameSchema,
  address: z.string().trim().max(300).optional(),
  timeZone: timeZoneSchema,
});
export type SiteInput = z.infer<typeof siteSchema>;

export const gateSchema = z.object({
  name: nameSchema,
  type: z.enum(["pedestrian", "vehicle", "reception", "other"]),
});
export type GateInput = z.infer<typeof gateSchema>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #0F766E.");

export const brandingSchema = z.object({
  logoUrl: z.string().url().startsWith("https://", "Logo must use https.").max(500).optional(),
  primaryColor: hexColor.optional(),
  welcomeText: z.string().trim().max(200).optional(),
  privacyNotice: z.string().trim().max(2000).optional(),
});
