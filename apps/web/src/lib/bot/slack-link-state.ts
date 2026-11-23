import 'server-only';
import { z } from 'zod';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';

// Signed `state` parameter for the Slack-bot account-link Sign-in-with-Slack
// round trip.
//
// The Slack callback route is shared with the workspace-install flow, which
// uses `verifyOAuthState` over a different payload shape. The
// `kind: 'slack-bot-link'` discriminator is what lets the callback dispatch
// between them: `verifySlackBotLinkState` rejects payloads without that
// literal, and `verifyOAuthState` rejects this payload because it has no
// `provider`/`purpose`/owner fields.
//
// The payload binds the pending link to (a) the Kilo user who started it,
// (b) the Slack identity that link token names, and (c) the stored context of
// the chat message that asked for the link. The Slack user id here is only a
// claim to compare against: the identity the flow actually trusts comes from
// Slack's own sign-in response, never from this parameter alone.

// The state must outlive the pause a person can take at the provider's sign-in
// screen and must not outlive the pending link it names, so it matches the
// pending link's 30-minute lifetime.
const STATE_TTL_SECONDS = 30 * 60;

const KIND = 'slack-bot-link';

const slackBotLinkStatePayloadSchema = z.object({
  kind: z.literal(KIND),
  userId: z.string().min(1),
  slackTeamId: z.string().min(1),
  slackUserId: z.string().min(1),
  contextKey: z.string().min(1),
});

export type VerifiedSlackBotLinkState = {
  userId: string;
  slackTeamId: string;
  slackUserId: string;
  contextKey: string;
};

export function createSlackBotLinkState(params: {
  userId: string;
  slackTeamId: string;
  slackUserId: string;
  contextKey: string;
}): string {
  return createSignedToken({
    kind: KIND,
    userId: params.userId,
    slackTeamId: params.slackTeamId,
    slackUserId: params.slackUserId,
    contextKey: params.contextKey,
  });
}

const slackBotLinkStateKindSchema = z.object({ kind: z.literal(KIND) });

/**
 * Classify a state as a Slack bot-link state by decoding only its payload half.
 *
 * This exists to pick an error page for a state that failed verification — a
 * paused sign-in outlives the 30-minute TTL — so it checks neither the
 * signature nor the age and must never authorize anything.
 */
export function isSlackBotLinkState(state: string | null): boolean {
  if (!state) return false;

  const dotIndex = state.indexOf('.');
  if (dotIndex === -1) return false;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(state.slice(0, dotIndex), 'base64url').toString('utf8'));
  } catch {
    return false;
  }

  return slackBotLinkStateKindSchema.safeParse(payload).success;
}

export function verifySlackBotLinkState(state: string | null): VerifiedSlackBotLinkState | null {
  return verifySignedToken(state, {
    ttlSeconds: STATE_TTL_SECONDS,
    parse: payload => {
      const result = slackBotLinkStatePayloadSchema.safeParse(payload);
      if (!result.success) return null;
      return {
        userId: result.data.userId,
        slackTeamId: result.data.slackTeamId,
        slackUserId: result.data.slackUserId,
        contextKey: result.data.contextKey,
      };
    },
  });
}
