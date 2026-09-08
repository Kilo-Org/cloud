import { createGitHubBotLinkState, verifyGitHubBotLinkState } from './github-link-state';

test.each(['standard', 'lite'] as const)('preserves optional %s app identity', githubAppType => {
  const state = createGitHubBotLinkState('user-1', '777', '/github/link', githubAppType);
  expect(verifyGitHubBotLinkState(state)).toEqual({
    userId: 'user-1',
    installationId: '777',
    callbackPath: '/github/link',
    githubAppType,
  });
});

test('accepts legacy state without app identity as Standard-compatible', () => {
  const state = createGitHubBotLinkState('user-1', '777');
  expect(verifyGitHubBotLinkState(state)).toMatchObject({
    userId: 'user-1',
    installationId: '777',
    githubAppType: undefined,
  });
});
