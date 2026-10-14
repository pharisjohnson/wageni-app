import { normalizePhone } from "../notifications/address";

/**
 * A Kenyan mobile number for M-Pesa. Accepts 0712345678, 712345678,
 * +254712345678, 254712345678 and 00254712345678 (spaces and dashes allowed).
 * Returns the E.164 form and the local `07xxxxxxxx` form PayHero's examples
 * use, or null for anything else (landlines, other countries, junk).
 */
export function normalizeKenyanMobile(input: string | undefined | null): { e164: string; local: string } | null {
  let raw = (input ?? "").trim();
  if (!raw || raw.length > 20) return null;
  const compact = raw.replace(/[\s().-]/g, "");
  if (/^254\d+$/.test(compact)) raw = `+${compact}`;
  else if (/^[17]\d{8}$/.test(compact)) raw = `0${compact}`;
  const e164 = normalizePhone(raw, "254");
  if (!e164 || !/^\+254[17]\d{8}$/.test(e164)) return null;
  return { e164, local: `0${e164.slice(4)}` };
}
