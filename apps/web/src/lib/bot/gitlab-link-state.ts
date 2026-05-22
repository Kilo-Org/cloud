import 'server-only';
import crypto from 'node:crypto';
import { z } from 'zod';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

const HMAC_ALGORITHM = 'sha256';
const STATE_TTL_SECONDS = 10 * 60;
const NONCE_BYTES = 16;
const KIND = 'gitlab-bot-link';

const gitLabBotLinkStatePayloadSchema = z.object({
  kind: z.literal(KIND),
  userId: z.string().min(1),
  platformIntegrationId: z.string().min(1),
  callbackPath: z.string().startsWith('/'),
  iat: z.number(),
  nonce: z.string().min(1),
});

type GitLabBotLinkStatePayload = z.infer<typeof gitLabBotLinkStatePayloadSchema>;

export type VerifiedGitLabBotLinkState = {
  userId: string;
  platformIntegrationId: string;
  callbackPath: string;
};

function sign(data: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, NEXTAUTH_SECRET).update(data).digest('base64url');
}

export function createGitLabBotLinkState(params: {
  userId: string;
  platformIntegrationId: string;
  callbackPath?: string;
}): string {
  const payload: GitLabBotLinkStatePayload = {
    kind: KIND,
    userId: params.userId,
    platformIntegrationId: params.platformIntegrationId,
    callbackPath: params.callbackPath ?? '/gitlab/link',
    iat: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(NONCE_BYTES).toString('base64url'),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyGitLabBotLinkState(state: string | null): VerifiedGitLabBotLinkState | null {
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

  const result = gitLabBotLinkStatePayloadSchema.safeParse(parsed);
  if (!result.success) return null;

  const data = result.data;
  const ageSeconds = Math.floor(Date.now() / 1000) - data.iat;
  if (ageSeconds < 0 || ageSeconds > STATE_TTL_SECONDS) return null;

  return {
    userId: data.userId,
    platformIntegrationId: data.platformIntegrationId,
    callbackPath: data.callbackPath,
  };
}
