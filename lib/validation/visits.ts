import { z } from "zod";

export const visitorSchema = z.object({
  name: z.string().trim().min(2, "Enter the visitor's name.").max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/, "Enter a valid phone number.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  email: z
    .email("Enter a valid email address.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  company: z.string().trim().max(120, "Use at most 120 characters.").optional(),
});

export const appointmentSchema = z
  .object({
    purpose: z.string().trim().min(2, "Enter the purpose of the visit.").max(300),
    scheduledStart: z.number().int(),
    scheduledEnd: z.number().int(),
  })
  .refine((a) => a.scheduledEnd > a.scheduledStart, {
    path: ["scheduledEnd"],
    message: "The end time must be after the start time.",
  });

export const walkInPurposeSchema = z
  .string()
  .trim()
  .min(2, "Enter the purpose of the visit.")
  .max(300);
