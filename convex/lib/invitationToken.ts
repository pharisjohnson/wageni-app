const PREFIX = "wi_";
const MAX_LENGTH = 128;

/** A new random invitation token (256 bits, base64url). Shown once, never stored. */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isInviteTokenShape(token: string): boolean {
  return token.startsWith(PREFIX) && token.length <= MAX_LENGTH && /^[A-Za-z0-9_-]+$/.test(token);
}

export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
