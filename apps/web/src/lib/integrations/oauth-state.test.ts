process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

import { createOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';

function tamperState(state: string): string {
  const dotIndex = state.indexOf('.');
  const payload = state.slice(0, dotIndex);
  const signature = state.slice(dotIndex + 1);
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const tamperedPayload = Buffer.from(JSON.stringify({ ...decoded, owner: 'user-other' })).toString(
    'base64url'
  );
  return `${tamperedPayload}.${signature}`;
}

describe('OAuth state', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('round-trips owner and user data', () => {
    const state = createOAuthState('user_user-1', 'user-1');

    expect(verifyOAuthState(state)).toEqual({ owner: 'user_user-1', userId: 'user-1' });
  });

  it('round-trips Slack marketplace install metadata', () => {
    const metadata = {
      source: 'slack_marketplace_install',
      installToken: 'signed-install-token',
    } as const;

    const state = createOAuthState('org_org-1', 'user-1', metadata);

    expect(verifyOAuthState(state)).toEqual({
      owner: 'org_org-1',
      userId: 'user-1',
      metadata,
    });
  });

  it('rejects tampered states', () => {
    const state = createOAuthState('user_user-1', 'user-1');

    expect(verifyOAuthState(tamperState(state))).toBeNull();
  });

  it('rejects expired states', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-04T10:00:00Z'));
    const state = createOAuthState('user_user-1', 'user-1');

    jest.setSystemTime(new Date('2026-05-04T10:11:00Z'));

    expect(verifyOAuthState(state)).toBeNull();
  });
});
