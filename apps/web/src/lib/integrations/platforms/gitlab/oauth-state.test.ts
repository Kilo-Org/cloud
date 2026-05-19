import {
  DEFAULT_GITLAB_OAUTH_INSTANCE_URL,
  createGitLabOAuthState,
  verifyGitLabOAuthState,
} from './oauth-state';

describe('gitlab oauth state', () => {
  test('round-trips self-hosted instance metadata and user binding', () => {
    const state = createGitLabOAuthState(
      {
        owner: { type: 'org', id: 'org_123' },
        instanceUrl: 'https://gitlab.example.com',
        customCredentials: {
          clientId: 'gitlab-client-id',
          clientSecret: 'gitlab-client-secret',
        },
      },
      'user_123'
    );

    expect(verifyGitLabOAuthState(state)).toEqual({
      owner: { type: 'org', id: 'org_123' },
      instanceUrl: 'https://gitlab.example.com',
      customCredentials: {
        clientId: 'gitlab-client-id',
        clientSecret: 'gitlab-client-secret',
      },
      userId: 'user_123',
    });
  });

  test('defaults verified first-party state to gitlab.com', () => {
    const state = createGitLabOAuthState(
      {
        owner: { type: 'user', id: 'user_123' },
      },
      'user_123'
    );

    expect(verifyGitLabOAuthState(state)).toEqual({
      owner: { type: 'user', id: 'user_123' },
      instanceUrl: DEFAULT_GITLAB_OAUTH_INSTANCE_URL,
      userId: 'user_123',
    });
  });

  test('rejects tampered state', () => {
    const state = createGitLabOAuthState(
      {
        owner: { type: 'user', id: 'user_123' },
      },
      'user_123'
    );

    const tampered = `${state.slice(0, -1)}x`;
    expect(verifyGitLabOAuthState(tampered)).toBeNull();
  });

  test('rejects malformed multibyte signatures without throwing', () => {
    const state = createGitLabOAuthState(
      {
        owner: { type: 'user', id: 'user_123' },
      },
      'user_123'
    );
    const dotIndex = state.indexOf('.');
    const payload = state.slice(0, dotIndex);
    const signature = state.slice(dotIndex + 1);

    expect(verifyGitLabOAuthState(`${payload}.${'\u00e9'.repeat(signature.length)}`)).toBeNull();
  });
});
