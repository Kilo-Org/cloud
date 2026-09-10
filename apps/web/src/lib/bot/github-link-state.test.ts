import { createGitHubBotLinkState, verifyGitHubBotLinkState } from './github-link-state';
import { createSignedToken } from '@/lib/signed-token';

test.each(['standard', 'lite'] as const)('preserves optional %s app identity', githubAppType => {
  const platformIntegrationId = '00000000-0000-4000-8000-000000000099';
  const state = createGitHubBotLinkState(
    'user-1',
    '777',
    '/github/link',
    githubAppType,
    platformIntegrationId
  );
  expect(verifyGitHubBotLinkState(state)).toEqual({
    userId: 'user-1',
    installationId: '777',
    callbackPath: '/github/link',
    githubAppType,
    platformIntegrationId,
  });
});

test('rejects a malformed platform integration identity', () => {
  const state = createSignedToken({
    userId: 'user-1',
    installationId: '777',
    callbackPath: '/github/link',
    platformIntegrationId: 'not-a-uuid',
  });
  expect(verifyGitHubBotLinkState(state)).toBeNull();
});

test('accepts legacy state without app identity as Standard-compatible', () => {
  const state = createGitHubBotLinkState('user-1', '777');
  expect(verifyGitHubBotLinkState(state)).toMatchObject({
    userId: 'user-1',
    installationId: '777',
    githubAppType: undefined,
  });
});
