import 'server-only';
import type { User } from '@kilocode/db/schema';
import jwt from 'jsonwebtoken';
import {
  EVENT_SERVICE_AUDIENCE,
  KILO_CHAT_AUDIENCE,
  NOTIFICATIONS_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { buildModernKiloTokenPayload } from '@kilocode/worker-utils/kilo-token-policy';

import { getResourceDelegationAuthority } from '@/lib/auth/resource-delegation';
import { isSharedResourceTokenIssuanceEnabled, NEXTAUTH_SECRET } from '@/lib/config.server';
import { generateApiToken } from '@/lib/tokens';

import type { KiloChatTokenResponse } from './token-schema';

const KILO_CHAT_TOKEN_TTL_SECONDS = 60 * 60;

export async function createKiloChatTokenResponse(
  user: User,
  headersList: Headers = new Headers()
): Promise<KiloChatTokenResponse> {
  const authority = await getResourceDelegationAuthority(user, { headers: headersList });
  if (authority.credentialKind !== 'human-api' && authority.credentialKind !== 'device-access') {
    throw new Error('Kilo Chat requires a fresh user credential');
  }
  if (isSharedResourceTokenIssuanceEnabled()) {
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = Math.min(
      KILO_CHAT_TOKEN_TTL_SECONDS,
      authority.expiresAt ? authority.expiresAt - now : KILO_CHAT_TOKEN_TTL_SECONDS
    );
    if (expiresIn <= 0) throw new Error('Kilo Chat delegation authority has expired');
    const singleAudiencePayload = buildModernKiloTokenPayload({
      userId: authority.user.id,
      pepper: authority.user.api_token_pepper,
      env: process.env.NODE_ENV,
      audience: [KILO_CHAT_AUDIENCE, EVENT_SERVICE_AUDIENCE, NOTIFICATIONS_AUDIENCE],
      issuedAt: now,
      expiresAt: now + expiresIn,
      tokenPurpose: 'delegated-workload',
      credentialExchange: false,
      extra: { tokenSource: 'kilo-chat' },
    });
    const token = jwt.sign(singleAudiencePayload, NEXTAUTH_SECRET, { algorithm: 'HS256' });
    return {
      token,
      expiresAt: new Date((now + expiresIn) * 1000).toISOString(),
      userId: authority.user.id,
    };
  }
  if (authority.isModern) {
    throw new Error('Shared resource token migration is unavailable');
  }
  const legacyExpiresIn = Math.min(
    KILO_CHAT_TOKEN_TTL_SECONDS,
    authority.expiresAt
      ? authority.expiresAt - Math.floor(Date.now() / 1000)
      : KILO_CHAT_TOKEN_TTL_SECONDS
  );
  if (legacyExpiresIn <= 0) throw new Error('Kilo Chat delegation authority has expired');
  const token = generateApiToken(
    authority.user,
    { tokenSource: 'kilo-chat' },
    { expiresIn: legacyExpiresIn }
  );
  const expiresAt = new Date(Date.now() + legacyExpiresIn * 1000).toISOString();
  return { token, expiresAt, userId: authority.user.id } satisfies KiloChatTokenResponse;
}
