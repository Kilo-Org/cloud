import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GitHubAppPage from './page';
import { GitHubIntegrationDetails } from '@/components/integrations/GitHubIntegrationDetails';
import { checkInstallState } from '@/lib/integrations/github/install-state';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';

jest.mock('@/components/integrations/GitHubIntegrationDetails', () => ({
  GitHubIntegrationDetails: jest.fn(() => React.createElement('button', null, 'Open GitHub setup')),
}));
jest.mock('@/lib/integrations/github/install-state', () => ({
  checkInstallState: jest.fn(),
}));
jest.mock('@/lib/user/server', () => ({
  getUserFromAuthOrRedirect: jest.fn(),
}));

const mockedCheckInstallState = jest.mocked(checkInstallState);
const mockedGetUser = jest.mocked(getUserFromAuthOrRedirect);
const mockedDetails = jest.mocked(GitHubIntegrationDetails);
const browserUserId = 'oauth/test-browser-alice';
const token = 'test-preminted-install-state';

beforeEach(() => {
  jest.resetAllMocks();
  mockedGetUser.mockResolvedValue({ id: browserUserId } as Awaited<
    ReturnType<typeof getUserFromAuthOrRedirect>
  >);
  mockedCheckInstallState.mockResolvedValue({ status: 'valid' });
  mockedDetails.mockImplementation(() => React.createElement('button', null, 'Open GitHub setup'));
});

async function renderPage(search: Record<string, string> = {}) {
  return renderToStaticMarkup(await GitHubAppPage({ searchParams: Promise.resolve(search) }));
}

describe('GitHubAppPage install-state preflight', () => {
  test('forwards matching pre-minted state unchanged after checking the browser user', async () => {
    const html = await renderPage({
      installState: token,
      fromApp: '1',
      organizationId: 'test-org',
    });
    expect(mockedCheckInstallState).toHaveBeenCalledWith(token, browserUserId);
    expect(html).toContain('Open GitHub setup');
    expect(mockedDetails.mock.calls[0][0]).toMatchObject({
      installState: token,
      fromApp: true,
      organizationId: 'test-org',
      appReturnPath: `/github-app?organizationId=test-org&installState=${token}&fromApp=1`,
    });
  });

  test.each(['1', '0'])(
    'blocks foreign state without mounting the installation component (fromApp=%s)',
    async fromApp => {
      mockedCheckInstallState.mockResolvedValue({
        status: 'user_mismatch',
        organizationId: 'test-org',
        returnTo: '/cloud/sessions',
      });
      const html = await renderPage({ installState: token, fromApp });
      expect(html).toContain('Account mismatch');
      expect(html).not.toContain('Open GitHub setup');
      expect(html).not.toContain(token);
      expect(html).not.toContain('test-org');
      expect(mockedDetails).not.toHaveBeenCalled();
      expect(html).toContain(fromApp === '1' ? 'Return to Kilo App' : 'Go to dashboard');
    }
  );

  test.each(['expired-state', 'consumed-state', 'unknown-state', ''])(
    'shows restart recovery for unusable state %j',
    async installState => {
      mockedCheckInstallState.mockResolvedValue({ status: 'unusable' });
      const html = await renderPage({ installState, fromApp: '1' });
      expect(mockedCheckInstallState).toHaveBeenCalledWith(installState, browserUserId);
      expect(html).toContain('Restart GitHub setup');
      expect(html).toContain('/cloud/sessions?error=install_state_unusable');
      expect(html).not.toContain('Open GitHub setup');
      expect(mockedDetails).not.toHaveBeenCalled();
    }
  );

  test('query-string success and pending outcomes cannot bypass a failed preflight', async () => {
    mockedCheckInstallState.mockResolvedValue({ status: 'unusable' });
    const html = await renderPage({
      installState: token,
      fromApp: '1',
      github_install: 'success',
      pending_approval: 'true',
    });
    expect(html).toContain('Restart GitHub setup');
    expect(mockedDetails).not.toHaveBeenCalled();
  });

  test('does not preflight ordinary web setup or callback outcomes without pre-minted state', async () => {
    await renderPage({ fromApp: '1', error: 'install_state_user_mismatch' });
    expect(mockedCheckInstallState).not.toHaveBeenCalled();
    expect(mockedDetails.mock.calls[0][0]).toMatchObject({
      installState: undefined,
      error: 'install_state_user_mismatch',
    });
  });

  test('authenticates before preflight and preserves the original handoff through sign-in', async () => {
    mockedGetUser.mockRejectedValue(new Error('test sign-in redirect'));
    await expect(renderPage({ installState: token, fromApp: '1' })).rejects.toThrow(
      'test sign-in redirect'
    );
    expect(mockedGetUser).toHaveBeenCalledWith(
      `/users/sign_in?callbackPath=${encodeURIComponent(`/github-app?installState=${token}&fromApp=1`)}`
    );
    expect(mockedCheckInstallState).not.toHaveBeenCalled();
    expect(mockedDetails).not.toHaveBeenCalled();
  });
});
