import { createGitLabLinkToken, verifyGitLabLinkToken } from './gitlab-link-token';

describe('GitLab bot link token', () => {
  it('round-trips a signed token', () => {
    const token = createGitLabLinkToken({
      platformIntegrationId: 'pi_gitlab_1',
      integrationId: 'pi_gitlab_1',
    });

    expect(verifyGitLabLinkToken(token)).toEqual({
      platformIntegrationId: 'pi_gitlab_1',
      integrationId: 'pi_gitlab_1',
    });
  });

  it('rejects tampered tokens', () => {
    const token = createGitLabLinkToken({
      platformIntegrationId: 'pi_gitlab_1',
      integrationId: 'pi_gitlab_1',
    });

    expect(verifyGitLabLinkToken(`${token}tampered`)).toBeNull();
  });
});
