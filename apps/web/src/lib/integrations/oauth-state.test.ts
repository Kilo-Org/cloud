import { createHmac } from 'node:crypto';
import { createOAuthState, OAUTH_STATE_TTL_SECONDS, verifyOAuthState } from './oauth-state';

jest.mock('@/lib/config.server', () => ({ NEXTAUTH_SECRET: 'oauth-state-test-secret' }));

const recovery = {
  integrationId: '33333333-3333-4333-8333-333333333333',
  credentialId: '44444444-4444-4444-8444-444444444444',
  credentialVersion: 2,
  workspaceUuid: 'workspace-one',
  workspaceSlug: 'workspace-one',
};

function signPayload(payload: object) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${createHmac('sha256', 'oauth-state-test-secret').update(encoded).digest('base64url')}`;
}

describe('oauth state', () => {
  test('binds Bitbucket recovery to the owner, actor, credential revision, and workspace', () => {
    const state = createOAuthState(
      'org_organization',
      'oauth/actor',
      '/integrations/bitbucket',
      recovery
    );
    expect(verifyOAuthState(state)).toEqual({
      owner: 'org_organization',
      userId: 'oauth/actor',
      returnTo: '/integrations/bitbucket',
      bitbucketRecovery: recovery,
    });
  });

  test.each([
    ['integrationId', '55555555-5555-4555-8555-555555555555'],
    ['credentialId', '66666666-6666-4666-8666-666666666666'],
    ['credentialVersion', 3],
    ['workspaceUuid', 'workspace-two'],
    ['workspaceSlug', 'workspace-two'],
  ] as const)('rejects a tampered recovery %s', (field, value) => {
    const state = createOAuthState('org_organization', 'oauth/actor', undefined, recovery);
    const [encoded, signature] = state.split('.');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    payload.bitbucketRecovery = { ...recovery, [field]: value };
    const tampered = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifyOAuthState(`${tampered}.${signature}`)).toBeNull();
  });

  test.each([
    null,
    {},
    { ...recovery, integrationId: '' },
    { ...recovery, credentialId: 'not-a-uuid' },
    { ...recovery, credentialVersion: 0 },
    { ...recovery, credentialVersion: 1.5 },
    { ...recovery, credentialVersion: 2_147_483_647 },
    { ...recovery, workspaceUuid: '' },
    { ...recovery, workspaceSlug: ' padded' },
    { ...recovery, replaceAnything: true },
  ])(
    'rejects malformed signed recovery instead of downgrading to first-connect',
    bitbucketRecovery => {
      expect(
        verifyOAuthState(
          signPayload({
            owner: 'org_organization',
            uid: 'oauth/actor',
            iat: Math.floor(Date.now() / 1000),
            nonce: 'nonce',
            bitbucketRecovery,
          })
        )
      ).toBeNull();
    }
  );

  test('expires recovery with the existing state lifetime', () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const state = createOAuthState('org_organization', 'oauth/actor', undefined, recovery);
      clock.mockReturnValue(now + (OAUTH_STATE_TTL_SECONDS + 1) * 1000);
      expect(verifyOAuthState(state)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  test('preserves the legacy two-argument state contract for other providers', () => {
    expect(verifyOAuthState(createOAuthState('google:encoded-owner', 'oauth/actor'))).toEqual({
      owner: 'google:encoded-owner',
      userId: 'oauth/actor',
    });
  });

  test('round-trips a validated return path', () => {
    const state = createOAuthState('user_123', 'user_123', '/claw/new?step=linear');

    expect(verifyOAuthState(state)).toEqual(
      expect.objectContaining({
        owner: 'user_123',
        userId: 'user_123',
        returnTo: '/claw/new?step=linear',
      })
    );
  });

  test('drops invalid return paths when creating state', () => {
    const state = createOAuthState('user_123', 'user_123', 'https://evil.example.com/path');

    expect(verifyOAuthState(state)).toEqual(
      expect.objectContaining({
        owner: 'user_123',
        userId: 'user_123',
      })
    );
    expect(verifyOAuthState(state)).not.toHaveProperty('returnTo');
  });
});
