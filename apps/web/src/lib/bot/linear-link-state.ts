import 'server-only';
import crypto from 'node:crypto';
import { z } from 'zod';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

// Signed `state` parameter for the Linear-bot account-link OAuth flow.
//
// The Linear callback route is shared between the workspace-install flow
// (which uses `verifyOAuthState` over a different payload shape) and this
// bot-link flow. The `kind: 'linear-bot-link'` discriminator is what lets
// the callback distinguish them — `verifyLinearBotLinkState` actively
// rejects payloads that lack that literal so an install-flow state cannot
// be misinterpreted as a bot-link state, and vice versa.

const HMAC_ALGORITHM = 'sha256';
const STATE_TTL_SECONDS = 10 * 60;
const NONCE_BYTES = 16;

const KIND = 'linear-bot-link';

const linearBotLinkStatePayloadSchema = z.object({
  kind: z.literal(KIND),
  userId: z.string().min(1),
  platformIntegrationId: z.string().min(1),
  organizationId: z.string().min(1),
  callbackPath: z.string().startsWith('/'),
  iat: z.number(),
  nonce: z.string().min(1),
});

type LinearBotLinkStatePayload = z.infer<typeof linearBotLinkStatePayloadSchema>;

export type VerifiedLinearBotLinkState = {
  userId: string;
  platformIntegrationId: string;
  organizationId: string;
  callbackPath: string;
};

function sign(data: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, NEXTAUTH_SECRET).update(data).digest('base64url');
}

export function createLinearBotLinkState(params: {
  userId: string;
  platformIntegrationId: string;
  organizationId: string;
  callbackPath?: string;
}): string {
  const payload: LinearBotLinkStatePayload = {
    kind: KIND,
    userId: params.userId,
    platformIntegrationId: params.platformIntegrationId,
    organizationId: params.organizationId,
    callbackPath: params.callbackPath ?? '/linear/link',
    iat: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(NONCE_BYTES).toString('base64url'),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyLinearBotLinkState(state: string | null): VerifiedLinearBotLinkState | null {
  if (!state) return null;

  const dotIndex = state.indexOf('.');
  if (dotIndex === -1) return null;

  const payload = state.slice(0, dotIndex);
  const providedSig = state.slice(dotIndex + 1);
  const expectedSig = sign(payload);

  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const result = linearBotLinkStatePayloadSchema.safeParse(parsed);
  if (!result.success) return null;

  const data = result.data;
  const ageSeconds = Math.floor(Date.now() / 1000) - data.iat;
  if (ageSeconds < 0 || ageSeconds > STATE_TTL_SECONDS) return null;

  return {
    userId: data.userId,
    platformIntegrationId: data.platformIntegrationId,
    organizationId: data.organizationId,
    callbackPath: data.callbackPath,
  };
}
