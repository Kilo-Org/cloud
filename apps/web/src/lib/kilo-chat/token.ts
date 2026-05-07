import 'server-only';
import type { User } from '@kilocode/db/schema';

import { generateApiToken } from '@/lib/tokens';

import type { KiloChatTokenResponse } from './token-schema';

const KILO_CHAT_TOKEN_TTL_SECONDS = 60 * 60;

export function createKiloChatTokenResponse(user: User): KiloChatTokenResponse {
  const token = generateApiToken(
    user,
    { tokenSource: 'kilo-chat' },
    { expiresIn: KILO_CHAT_TOKEN_TTL_SECONDS }
  );
  const expiresAt = new Date(Date.now() + KILO_CHAT_TOKEN_TTL_SECONDS * 1000).toISOString();
  return { token, expiresAt, userId: user.id } satisfies KiloChatTokenResponse;
}
