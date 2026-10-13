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

/** A phone number with at least 7 digits (the base regex alone would accept "-------"). */
const kioskPhone = (message: string) =>
  z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/, message)
    .refine((s) => s.replace(/\D/g, "").length >= 7, message);

/** Kiosk walk-in: a phone number is required (it is how the visitor checks out later). */
export const kioskWalkInSchema = z.object({
  name: visitorSchema.shape.name,
  phone: kioskPhone("Enter a valid phone number."),
  company: visitorSchema.shape.company,
  purpose: walkInPurposeSchema,
});

/** Phone number used to find an appointment at the kiosk. */
export const kioskPhoneSchema = kioskPhone("Enter the phone number you booked with.");

/** Self check-out: the 6-digit badge code plus the last 4 digits of the visitor's phone. */
export const kioskCheckOutSchema = z.object({
  badgeCode: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, "Enter the 6-digit code on your badge."),
  phoneLast4: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, "Enter the last 4 digits of your phone number."),
});
