import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { resolveInviteOrigin } from "../../lib/invite/origin";

/**
 * Hook point called inside the `invitations.create` transaction, after the
 * invitation row exists. It hands the invitation to the notifications module
 * (N1), which sends the link by email/SMS if the invitee left an address and
 * redacts the link in its outbox once the message is settled.
 *
 * `link` is the only moment the plaintext token exists (only its hash is
 * stored on the invitation). It is passed to the scheduler as an argument, so
 * it sits in the scheduled-function record until it runs. Never log it or put
 * it in audit metadata.
 *
 * Absolute links: `APP_BASE_URL` (Convex environment) wins when set. Otherwise
 * the origin the signed-in browser sent is used, after validation
 * (`lib/invite/origin.ts`: https, or http://localhost when
 * `ALLOW_LOCAL_ORIGIN=true`; no credentials, path, query or fragment). With
 * neither, only the path is sent.
 */
export type InvitationCreatedEvent = {
  invitation: Doc<"invitations">;
  /** Path (no origin) the visitor opens, e.g. `/invite/wi_...`. */
  link: string;
  /** Origin the creating browser reported (`window.location.origin`); validated before use. */
  origin?: string;
};

/** The absolute link for `path`, or `path` itself when no trusted origin is known. */
export function absoluteInviteLink(path: string, requestedOrigin?: string): string {
  const base = resolveInviteOrigin({
    configured: process.env.APP_BASE_URL,
    requested: requestedOrigin,
    allowLocal: process.env.ALLOW_LOCAL_ORIGIN === "true",
  });
  return `${base}${path}`;
}

export async function onInvitationCreated(ctx: MutationCtx, event: InvitationCreatedEvent): Promise<void> {
  const { invitation } = event;
  await ctx.scheduler.runAfter(0, internal.notifications.onInvitationCreated, {
    organizationId: invitation.organizationId,
    siteId: invitation.siteId,
    invitee: {
      name: invitation.visitorName,
      email: invitation.visitorEmail,
      phone: invitation.visitorPhone,
    },
    link: absoluteInviteLink(event.link, event.origin),
    idempotencyKey: `invite:${invitation._id}`,
  });
}
