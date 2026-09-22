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

test('rejects a tampered signed state', () => {
  const state = createGitHubBotLinkState(
    'user-1',
    '777',
    '/github/link',
    'standard',
    '00000000-0000-4000-8000-000000000099'
  );
  const finalCharacter = state.at(-1);
  const tampered = `${state.slice(0, -1)}${finalCharacter === 'a' ? 'b' : 'a'}`;
  expect(verifyGitHubBotLinkState(tampered)).toBeNull();
});

test('rejects state after the ten-minute TTL', () => {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
    const state = createGitHubBotLinkState(
      'user-1',
      '777',
      '/github/link',
      'standard',
      '00000000-0000-4000-8000-000000000099'
    );
    jest.advanceTimersByTime(10 * 60_000 + 1_000);
    expect(verifyGitHubBotLinkState(state)).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});
