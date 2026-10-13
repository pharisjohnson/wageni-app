/**
 * Where invitation links point. The link must be absolute so email/SMS work,
 * but Convex does not know the app's public URL unless `APP_BASE_URL` is set.
 * The signed-in browser therefore sends its own origin, which is validated
 * here. `APP_BASE_URL`, when set, always wins.
 *
 * Accepted origin: `https://host[:port]` or (only when `allowLocal`)
 * `http://localhost`, `http://127.0.0.1`, `http://[::1]` with any port.
 * Anything with credentials, a path other than "/", a query or a fragment is
 * rejected. A returned value has no trailing slash.
 *
 * Trust note: without APP_BASE_URL any https origin is accepted from a
 * signed-in member, so that member could point THEIR OWN invitation at a host
 * they control. Set APP_BASE_URL in production to remove that.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `https://app.example.com` or null when the value is not a clean origin. */
export function cleanOrigin(value: string | undefined | null, opts: { allowLocal?: boolean } = {}): string | null {
  if (!value || value.length > 300) return null;
  const text = value.trim();
  // A bare trailing "?" or "#" parses as empty search/hash, so look at the text.
  if (/[?#]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.protocol === "https:") return url.hostname ? url.origin : null;
  if (url.protocol === "http:" && opts.allowLocal && LOCAL_HOSTS.has(url.hostname)) return url.origin;
  return null;
}

/**
 * The origin to put in invitation links, or "" (links stay relative paths).
 * `configured` is the APP_BASE_URL environment value; `requested` is what the
 * browser sent.
 */
export function resolveInviteOrigin(opts: {
  configured?: string | null;
  requested?: string | null;
  allowLocal?: boolean;
}): string {
  const configured = opts.configured?.trim();
  // A configured value may carry a path prefix; keep it, minus trailing slashes.
  if (configured) return configured.replace(/\/+$/, "");
  return cleanOrigin(opts.requested, { allowLocal: opts.allowLocal }) ?? "";
}
