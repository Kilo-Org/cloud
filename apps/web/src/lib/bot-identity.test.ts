process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

import {
  createLinkToken,
  createPlatformInstallToken,
  verifyLinkToken,
  verifyPlatformInstallToken,
  type PlatformIdentity,
} from '@/lib/bot-identity';

const identity = {
  platform: 'slack',
  teamId: 'T123',
  userId: 'U456',
} satisfies PlatformIdentity;

function tamperToken(token: string): string {
  const dotIndex = token.indexOf('.');
  const payload = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const tamperedPayload = Buffer.from(JSON.stringify({ ...decoded, teamId: 'T999' })).toString(
    'base64url'
  );
  return `${tamperedPayload}.${signature}`;
}

describe('bot identity tokens', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('round-trips link tokens without exposing install context', () => {
    const token = createLinkToken(identity);

    expect(verifyLinkToken(token)).toEqual(identity);
  });

  it('round-trips platform install tokens with Slack return context', () => {
    const token = createPlatformInstallToken({
      ...identity,
      threadId: 'slack:T123:C123:1700000000.000100',
      messageId: '1700000000.000100',
    });

    expect(verifyPlatformInstallToken(token)).toEqual({
      ...identity,
      threadId: 'slack:T123:C123:1700000000.000100',
      messageId: '1700000000.000100',
    });
    expect(verifyLinkToken(token)).toEqual(identity);
  });

  it('rejects tampered install tokens', () => {
    const token = createPlatformInstallToken(identity);

    expect(verifyPlatformInstallToken(tamperToken(token))).toBeNull();
  });

  it('rejects expired install tokens', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-04T10:00:00Z'));
    const token = createPlatformInstallToken(identity);

    jest.setSystemTime(new Date('2026-05-04T10:31:00Z'));

    expect(verifyPlatformInstallToken(token)).toBeNull();
  });
});
