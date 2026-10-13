import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * HOOK POINT for notifications (N1). Called inside the `invitations.create`
 * transaction after the invitation row exists. Nothing is sent from here today:
 * this repository has no email/SMS delivery yet, so the admin UI shows the link
 * with a copy button instead.
 *
 * `link` is the only moment the plaintext token exists (only its hash is
 * stored). An implementation that sends the link should do so directly, or
 * schedule an action with the link as an argument and accept that the token
 * then sits in the scheduler's job record until it runs. Do not log it or copy
 * it into audit metadata.
 */
export type InvitationCreatedEvent = {
  invitation: Doc<"invitations">;
  /** Path (no origin) the visitor opens, e.g. `/invite/wi_...`. */
  link: string;
};

export async function onInvitationCreated(ctx: MutationCtx, event: InvitationCreatedEvent): Promise<void> {
  void ctx;
  void event;
}
