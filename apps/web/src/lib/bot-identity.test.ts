import { createLinkToken, verifyLinkToken } from '@/lib/bot-identity';

describe('bot identity link tokens', () => {
  it('round trips link-account replay context', () => {
    const token = createLinkToken({
      platform: 'slack',
      teamId: 'T123',
      userId: 'U123',
      linkContext: {
        threadId: 'slack:T123:C456:1710000000.000000',
        messageId: '1710000000.000000',
      },
    });

    const payload = verifyLinkToken(token);

    expect(payload).toMatchObject({
      platform: 'slack',
      teamId: 'T123',
      userId: 'U123',
      linkContext: {
        threadId: 'slack:T123:C456:1710000000.000000',
        messageId: '1710000000.000000',
      },
    });
    expect(payload?.nonce).toEqual(expect.any(String));
  });

  it('rejects invalid replay context payloads', () => {
    const token = createLinkToken({
      platform: 'slack',
      teamId: 'T123',
      userId: 'U123',
      linkContext: { threadId: '', messageId: '1710000000.000000' },
    });

    expect(verifyLinkToken(token)).toBeNull();
  });
});
