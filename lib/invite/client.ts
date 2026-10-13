import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

/**
 * Browser side of the invitation proxy (`app/api/invite/[action]`). The public
 * invite page never talks to Convex directly: every call goes through the
 * Next.js route so a per-IP limit applies.
 */

export class InviteCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function post<T>(action: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/invite/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new InviteCallError("NETWORK", "Could not reach the server. Check your connection and try again.", 0);
  }
  let json: { ok?: boolean; data?: T; code?: string; message?: string } | null = null;
  try {
    json = await res.json();
  } catch {
    // fall through to the generic error
  }
  if (json?.ok) return json.data as T;
  const message =
    res.status === 429
      ? "Too many attempts. Please wait a minute and try again."
      : (json?.message ?? "Something went wrong. Please try again.");
  throw new InviteCallError(json?.code ?? "INTERNAL", message, res.status);
}

type Fn<K extends keyof typeof api.invitations> = (typeof api.invitations)[K];

export type InviteLookup = FunctionReturnType<Fn<"lookup">>;
export type InviteUploadUrl = FunctionReturnType<Fn<"generateUploadUrl">>;
export type InviteRegister = FunctionReturnType<Fn<"registerUploaded">>;
export type InviteSubmit = FunctionReturnType<Fn<"submit">>;

export const inviteApi = {
  lookup: (token: string) => post<InviteLookup>("lookup", { token }),
  uploadUrl: (token: string, kind: string) => post<InviteUploadUrl>("upload-url", { token, kind }),
  registerUpload: (token: string, storageId: string, kind: string) =>
    post<InviteRegister>("register-upload", { token, storageId, kind }),
  submit: (args: Record<string, unknown>) => post<InviteSubmit>("submit", args),
};
