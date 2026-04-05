import { flyAppNameFromUserId } from './fly-app-name';

async function webCryptoAppNameFromUserId(userId: string, prefix?: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(userId));
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray.slice(0, 10))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  return prefix ? `${prefix}-${hex}` : `acct-${hex}`;
}

describe('flyAppNameFromUserId', () => {
  it('matches worker Web Crypto output for representative IDs', async () => {
    const userIds = [
      '',
      'user-123',
      'cf667948-86c8-4e0f-a374-708ec21cd5c4',
      'user-e\u0301',
      'user-\u00e9\u00e8\u00ea',
      'User-ABC',
      'user-abc',
      '  spaced-user  ',
      'user-with-emoji-\ud83d\ude80',
    ];

    for (const userId of userIds) {
      const expected = await webCryptoAppNameFromUserId(userId);
      expect(flyAppNameFromUserId(userId)).toBe(expected);
    }
  });

  it('matches worker Web Crypto output with custom prefixes', async () => {
    const userId = 'user-123';
    const prefixes = ['dev', 'stg', 'prod'];

    for (const prefix of prefixes) {
      const expected = await webCryptoAppNameFromUserId(userId, prefix);
      expect(flyAppNameFromUserId(userId, prefix)).toBe(expected);
    }
  });
});
