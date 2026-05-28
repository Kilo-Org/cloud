import { createOAuthState, verifyOAuthState } from './oauth-state';

describe('oauth state', () => {
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
