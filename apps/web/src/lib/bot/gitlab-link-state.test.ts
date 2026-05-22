import { createGitLabBotLinkState, verifyGitLabBotLinkState } from './gitlab-link-state';

describe('GitLab bot link state', () => {
  it('round-trips a signed bot-link state', () => {
    const state = createGitLabBotLinkState({
      userId: 'user_1',
      platformIntegrationId: 'pi_gitlab_1',
    });

    expect(verifyGitLabBotLinkState(state)).toEqual({
      userId: 'user_1',
      platformIntegrationId: 'pi_gitlab_1',
      callbackPath: '/gitlab/link',
    });
  });

  it('rejects non-GitLab bot-link state shapes', () => {
    const payload = Buffer.from(
      JSON.stringify({
        kind: 'linear-bot-link',
        userId: 'user_1',
        iat: Date.now() / 1000,
        nonce: 'n',
      })
    ).toString('base64url');

    expect(verifyGitLabBotLinkState(`${payload}.signature`)).toBeNull();
  });
});
