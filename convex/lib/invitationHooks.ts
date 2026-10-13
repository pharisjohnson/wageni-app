import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Hook point called inside the `invitations.create` transaction, after the
 * invitation row exists. It hands the invitation to the notifications module
 * (N1), which sends the link by email/SMS if the invitee left an address and
 * redacts the link in its outbox once the message is settled.
 *
 * `link` is the only moment the plaintext token exists (only its hash is
 * stored on the invitation). It is passed to the scheduler as an argument, so
 * it sits in the scheduled-function record until it runs. Never log it or put
 * it in audit metadata. Set `APP_BASE_URL` (e.g. https://app.example.com) in
 * the Convex environment so the link is absolute; without it the path is sent.
 */
export type InvitationCreatedEvent = {
  invitation: Doc<"invitations">;
  /** Path (no origin) the visitor opens, e.g. `/invite/wi_...`. */
  link: string;
};

export async function onInvitationCreated(ctx: MutationCtx, event: InvitationCreatedEvent): Promise<void> {
  const { invitation } = event;
  const base = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
  await ctx.scheduler.runAfter(0, internal.notifications.onInvitationCreated, {
    organizationId: invitation.organizationId,
    siteId: invitation.siteId,
    invitee: {
      name: invitation.visitorName,
      email: invitation.visitorEmail,
      phone: invitation.visitorPhone,
    },
    link: `${base}${event.link}`,
    idempotencyKey: `invite:${invitation._id}`,
  });
}
