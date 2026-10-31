import 'server-only';
import { createHmac, timingSafeEqual } from 'crypto';
import { deriveCallbackToken, verifyCallbackToken } from '@kilocode/worker-utils/callback-token';
import { CALLBACK_TOKEN_SECRET } from '@/lib/web-config.server';

export const BOT_CALLBACK_TOKEN_SCOPE = 'bot-session-callback';

/**
 * Compatibility derivation kept for bot sessions that were spawned before the
 * scoped token rolled out: their stored callback target already carries the
 * older token, and nothing else re-mints it. Valid only for bot requests
 * created before this instant, so the branch drains and can then be deleted.
 */
export const LEGACY_BOT_CALLBACK_TOKEN_CUTOFF_MS = Date.parse('2026-11-15T00:00:00.000Z');

export type BotCallbackTokenMatch = 'scoped' | 'legacy';

export async function deriveBotCallbackToken(botRequestId: string): Promise<string> {
  return deriveCallbackToken({
    secret: CALLBACK_TOKEN_SECRET,
    scope: BOT_CALLBACK_TOKEN_SCOPE,
    resourceParts: [botRequestId],
  });
}

function matchesLegacyBotCallbackToken(botRequestId: string, token: string): boolean {
  const expectedToken = createHmac('sha256', CALLBACK_TOKEN_SECRET)
    .update(`bot-callback:${botRequestId}`)
    .digest('hex');
  const expectedBuf = Buffer.from(expectedToken);
  const tokenBuf = Buffer.from(token);
  return tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf);
}

/**
 * `scoped` is the current derivation, bound to the callback purpose and the bot
 * request id. `legacy` is the pre-scope derivation, still accepted while a
 * pre-cutover bot request can report back.
 */
export async function matchBotCallbackToken(params: {
  botRequestId: string;
  token: string | null | undefined;
}): Promise<BotCallbackTokenMatch | null> {
  const { botRequestId, token } = params;
  if (!token) {
    return null;
  }

  const scopedTokenValid = await verifyCallbackToken({
    token,
    secret: CALLBACK_TOKEN_SECRET,
    scope: BOT_CALLBACK_TOKEN_SCOPE,
    resourceParts: [botRequestId],
  });
  if (scopedTokenValid) {
    return 'scoped';
  }

  return matchesLegacyBotCallbackToken(botRequestId, token) ? 'legacy' : null;
}

/** Whether a bot request created at this instant may still use the legacy token. */
export function isLegacyBotCallbackTokenAllowed(createdAt: string | Date): boolean {
  return new Date(createdAt).getTime() < LEGACY_BOT_CALLBACK_TOKEN_CUTOFF_MS;
}
