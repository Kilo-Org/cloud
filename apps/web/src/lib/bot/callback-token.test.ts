import { createHmac } from 'crypto';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';

jest.mock('@/lib/web-config.server', () => ({ CALLBACK_TOKEN_SECRET: 'callback-secret' }));

import {
  BOT_CALLBACK_TOKEN_SCOPE,
  LEGACY_BOT_CALLBACK_TOKEN_CUTOFF_MS,
  deriveBotCallbackToken,
  isLegacyBotCallbackTokenAllowed,
  matchBotCallbackToken,
} from '@/lib/bot/callback-token';

const BOT_REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const SECRET = 'callback-secret';

function legacyToken(botRequestId: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(`bot-callback:${botRequestId}`).digest('hex');
}

describe('bot callback token', () => {
  it('signs the callback purpose and the bot request id', async () => {
    await expect(deriveBotCallbackToken(BOT_REQUEST_ID)).resolves.toBe(
      await deriveCallbackToken({
        secret: SECRET,
        scope: 'bot-session-callback',
        resourceParts: [BOT_REQUEST_ID],
      })
    );
    expect(BOT_CALLBACK_TOKEN_SCOPE).toBe('bot-session-callback');
  });

  it('accepts the scoped derivation it mints', async () => {
    const token = await deriveBotCallbackToken(BOT_REQUEST_ID);

    await expect(matchBotCallbackToken({ botRequestId: BOT_REQUEST_ID, token })).resolves.toBe(
      'scoped'
    );
  });

  it('rejects a scoped token minted for another bot request', async () => {
    const token = await deriveCallbackToken({
      secret: SECRET,
      scope: BOT_CALLBACK_TOKEN_SCOPE,
      resourceParts: ['00000000-0000-4000-8000-000000000002'],
    });

    await expect(
      matchBotCallbackToken({ botRequestId: BOT_REQUEST_ID, token })
    ).resolves.toBeNull();
  });

  it('rejects a token minted for another callback scope', async () => {
    const token = await deriveCallbackToken({
      secret: SECRET,
      scope: 'code-review-status-callback',
      resourceParts: [BOT_REQUEST_ID],
    });

    await expect(
      matchBotCallbackToken({ botRequestId: BOT_REQUEST_ID, token })
    ).resolves.toBeNull();
  });

  it('rejects a token minted under a different secret', async () => {
    const scoped = await deriveCallbackToken({
      secret: 'unrelated-callback-secret',
      scope: BOT_CALLBACK_TOKEN_SCOPE,
      resourceParts: [BOT_REQUEST_ID],
    });

    await expect(
      matchBotCallbackToken({ botRequestId: BOT_REQUEST_ID, token: scoped })
    ).resolves.toBeNull();
    await expect(
      matchBotCallbackToken({
        botRequestId: BOT_REQUEST_ID,
        token: legacyToken(BOT_REQUEST_ID, 'unrelated-callback-secret'),
      })
    ).resolves.toBeNull();
  });

  it('reports the pre-scope derivation as legacy and nothing else', async () => {
    await expect(
      matchBotCallbackToken({ botRequestId: BOT_REQUEST_ID, token: legacyToken(BOT_REQUEST_ID) })
    ).resolves.toBe('legacy');
    await expect(
      matchBotCallbackToken({
        botRequestId: BOT_REQUEST_ID,
        token: legacyToken('00000000-0000-4000-8000-000000000002'),
      })
    ).resolves.toBeNull();
  });

  it('rejects missing and malformed tokens', async () => {
    for (const token of [null, undefined, '', 'not-a-token', 'a'.repeat(64)]) {
      await expect(
        matchBotCallbackToken({ botRequestId: BOT_REQUEST_ID, token })
      ).resolves.toBeNull();
    }
  });

  it('allows the legacy derivation only for requests created before the cutoff', () => {
    expect(isLegacyBotCallbackTokenAllowed(new Date(LEGACY_BOT_CALLBACK_TOKEN_CUTOFF_MS - 1))).toBe(
      true
    );
    expect(isLegacyBotCallbackTokenAllowed(new Date(LEGACY_BOT_CALLBACK_TOKEN_CUTOFF_MS))).toBe(
      false
    );
    expect(isLegacyBotCallbackTokenAllowed('2026-09-07T00:00:00.000Z')).toBe(true);
    expect(isLegacyBotCallbackTokenAllowed('2026-12-01T00:00:00.000Z')).toBe(false);
    expect(isLegacyBotCallbackTokenAllowed('not-a-date')).toBe(false);
  });
});
