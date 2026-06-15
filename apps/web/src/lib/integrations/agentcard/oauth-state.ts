import 'server-only';

import { z } from 'zod';
import { createOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';

/**
 * Signed OAuth state for the AgentCard connect flow.
 *
 * Mirrors the Google integration: the structured payload (owner, instanceId,
 * PKCE verifier, optional returnTo) is base64url-encoded and carried as the
 * `owner` string of the shared HMAC-signed state (see `oauth-state.ts`). The
 * HMAC binds the flow to the initiating user and enforces a TTL, defending
 * against CSRF / authorization-code injection.
 *
 * The PKCE `codeVerifier` is stored inside the signed (tamper-evident) state
 * rather than a cookie so the callback can complete the exchange statelessly.
 */

const AGENTCARD_OAUTH_STATE_PREFIX = 'agentcard:';

const AgentCardOAuthStatePayloadSchema = z.object({
  owner: z.discriminatedUnion('type', [
    z.object({ type: z.literal('user'), id: z.string().min(1) }),
    z.object({ type: z.literal('org'), id: z.string().uuid() }),
  ]),
  instanceId: z.string().uuid(),
  // OAuth client_id used for the authorize request; must match the token
  // exchange. Carried here (not secret) so the callback is stateless.
  clientId: z.string().min(1),
  codeVerifier: z.string().min(43).max(128),
  returnTo: z
    .string()
    .refine(value => validateReturnPath(value) !== null, 'returnTo failed safety validation')
    .optional(),
});

export type AgentCardOAuthStatePayload = z.infer<typeof AgentCardOAuthStatePayloadSchema>;

export type VerifiedAgentCardOAuthState = AgentCardOAuthStatePayload & {
  userId: string;
};

export function isSafeAgentCardOAuthReturnTo(value: string): boolean {
  return validateReturnPath(value) !== null;
}

export function createAgentCardOAuthState(
  payload: AgentCardOAuthStatePayload,
  userId: string
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return createOAuthState(`${AGENTCARD_OAUTH_STATE_PREFIX}${encodedPayload}`, userId);
}

export function verifyAgentCardOAuthState(
  state: string | null
): VerifiedAgentCardOAuthState | null {
  const verified = verifyOAuthState(state);
  if (!verified) return null;

  if (!verified.owner.startsWith(AGENTCARD_OAUTH_STATE_PREFIX)) {
    return null;
  }

  const encodedPayload = verified.owner.slice(AGENTCARD_OAUTH_STATE_PREFIX.length);
  if (!encodedPayload) return null;

  try {
    const decodedJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const parsed = AgentCardOAuthStatePayloadSchema.safeParse(JSON.parse(decodedJson));
    if (!parsed.success) return null;

    return {
      ...parsed.data,
      userId: verified.userId,
    };
  } catch {
    return null;
  }
}
