/**
 * Client IP for per-IP rate limiting, read from headers the hosting platform
 * sets. TRUST ASSUMPTION: the app runs behind a platform (Vercel) that
 * overwrites `x-forwarded-for` / `x-real-ip` with the connecting client's
 * address, so a caller cannot choose it. If you host somewhere that passes
 * client-supplied `x-forwarded-for` through, the limit can be dodged by
 * rotating that header; put a proxy that overwrites it in front, or set
 * CLIENT_IP_HEADER to a header your proxy controls.
 */

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-fA-F:.]+$/;

function plausible(ip: string) {
  return ip.length <= 45 && (IPV4.test(ip) || (ip.includes(":") && IPV6.test(ip)));
}

export function clientIp(
  headers: { get(name: string): string | null },
  opts: { header?: string } = {},
): string | null {
  const order = [opts.header, "x-real-ip", "x-vercel-forwarded-for", "x-forwarded-for"].filter(Boolean) as string[];
  for (const name of order) {
    const raw = headers.get(name);
    if (!raw) continue;
    // x-forwarded-for may be a list; the platform puts the client first.
    const first = raw.split(",")[0]?.trim() ?? "";
    if (plausible(first)) return first.toLowerCase();
  }
  return null;
}

/**
 * HMAC-SHA256(secret, "ip:" + ip), hex. The raw address never leaves the
 * Next.js server and is never stored: Convex only sees this keyed hash, so
 * counters cannot be reversed to addresses without the secret.
 */
export async function hashIp(ip: string | null, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`ip:${ip ?? "unknown"}`));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}
