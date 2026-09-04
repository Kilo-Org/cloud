import 'server-only';
import { z } from 'zod';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';

// Signed `state` parameter for the Linear-bot account-link OAuth flow.
//
// The Linear callback route is shared between the workspace-install flow
// (which uses `verifyOAuthState` over a different payload shape) and this
// bot-link flow. The `kind: 'linear-bot-link'` discriminator is what lets
// the callback distinguish them — `verifyLinearBotLinkState` actively
// rejects payloads that lack that literal so an install-flow state cannot
// be misinterpreted as a bot-link state, and vice versa.

const STATE_TTL_SECONDS = 10 * 60;

const KIND = 'linear-bot-link';

const linearBotLinkStatePayloadSchema = z.object({
  kind: z.literal(KIND),
  userId: z.string().min(1),
  platformIntegrationId: z.string().min(1),
  organizationId: z.string().min(1),
  callbackPath: z.string().startsWith('/'),
});

export type VerifiedLinearBotLinkState = {
  userId: string;
  platformIntegrationId: string;
  organizationId: string;
  callbackPath: string;
};

export function createLinearBotLinkState(params: {
  userId: string;
  platformIntegrationId: string;
  organizationId: string;
  callbackPath?: string;
}): string {
  return createSignedToken({
    kind: KIND,
    userId: params.userId,
    platformIntegrationId: params.platformIntegrationId,
    organizationId: params.organizationId,
    callbackPath: params.callbackPath ?? '/linear/link',
  });
}

export function verifyLinearBotLinkState(state: string | null): VerifiedLinearBotLinkState | null {
  return verifySignedToken(state, {
    ttlSeconds: STATE_TTL_SECONDS,
    parse: payload => {
      const result = linearBotLinkStatePayloadSchema.safeParse(payload);
      if (!result.success) return null;
      return {
        userId: result.data.userId,
        platformIntegrationId: result.data.platformIntegrationId,
        organizationId: result.data.organizationId,
        callbackPath: result.data.callbackPath,
      };
    },
  });
}
