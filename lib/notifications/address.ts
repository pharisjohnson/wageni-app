const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** A plain single email address, or null. Rejects anything that could inject headers or recipients. */
export function normalizeEmail(input: string | undefined | null): string | null {
  const value = input?.trim().toLowerCase();
  return value && value.length <= 254 && EMAIL.test(value) ? value : null;
}

/**
 * E.164 phone number, or null. A leading `0` becomes `+<defaultCountryCode>`
 * (set `NOTIFY_DEFAULT_COUNTRY_CODE`, e.g. 254 for Kenya); otherwise the
 * number must already be international.
 */
export function normalizePhone(input: string | undefined | null, defaultCountryCode?: string): string | null {
  const raw = input?.trim();
  if (!raw || !/^\+?[\d\s().-]{7,20}$/.test(raw)) return null;
  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) digits = `+${digits}`;
  else if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  else if (digits.startsWith("0") && defaultCountryCode && /^\d{1,3}$/.test(defaultCountryCode)) {
    digits = `+${defaultCountryCode}${digits.slice(1)}`;
  } else return null;
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/** `j***@example.com` or `+254***789`: enough to recognise, not to reuse. */
export function maskAddress(address: string | undefined): string {
  if (!address) return "";
  const at = address.indexOf("@");
  if (at > 0) return `${address[0]}***${address.slice(at)}`;
  return address.length > 6 ? `${address.slice(0, 4)}***${address.slice(-3)}` : "***";
}
