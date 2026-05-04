process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

jest.mock('@/lib/bot', () => ({
  bot: {
    getState: jest.fn(() => ({ state: true })),
    initialize: jest.fn(),
    getAdapter: jest.fn(),
  },
}));

jest.mock('@/lib/bot-identity', () => ({
  linkKiloUser: jest.fn(),
  verifyPlatformInstallToken: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { captureMessage } from '@sentry/nextjs';
import {
  buildSlackRedirectPath,
  completeSlackMarketplaceInstall,
} from '@/lib/integrations/slack-callback-helpers';
import { linkKiloUser, verifyPlatformInstallToken } from '@/lib/bot-identity';
import { createOAuthState } from '@/lib/integrations/oauth-state';

const mockedLinkKiloUser = jest.mocked(linkKiloUser);
const mockedVerifyPlatformInstallToken = jest.mocked(verifyPlatformInstallToken);
const mockedCaptureMessage = jest.mocked(captureMessage);

function buildVerifiedMarketplaceState(installToken = 'install-token') {
  return {
    owner: 'user_user-1',
    userId: 'user-1',
    metadata: {
      source: 'slack_marketplace_install',
      installToken,
    },
  } as const;
}

describe('Slack OAuth callback helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes marketplace install redirects back to get-started with namespaced status params', () => {
    const state = createOAuthState('user_user-1', 'user-1', {
      source: 'slack_marketplace_install',
      installToken: 'install-token',
    });

    const successPath = buildSlackRedirectPath(state, { success: 'installed' });
    expect(successPath.startsWith('/get-started/slack?')).toBe(true);
    const successParams = new URLSearchParams(successPath.split('?')[1]);
    expect(successParams.get('slackSuccess')).toBe('installed');
    expect(successParams.get('source')).toBe('slack_marketplace_install');
    expect(successParams.get('installToken')).toBe('install-token');

    const errorPath = buildSlackRedirectPath(state, { error: 'workspace_mismatch' });
    expect(errorPath.startsWith('/get-started/slack?')).toBe(true);
    const params = new URLSearchParams(errorPath.split('?')[1]);
    expect(params.get('slackError')).toBe('workspace_mismatch');
    expect(params.get('source')).toBe('slack_marketplace_install');
    expect(params.get('installToken')).toBe('install-token');
  });

  it('keeps normal personal Slack redirects on integrations pages', () => {
    const state = createOAuthState('user_user-1', 'user-1');

    expect(buildSlackRedirectPath(state, { success: 'installed' })).toBe(
      '/integrations/slack?success=installed'
    );
  });

  it('links the Slack identity and posts a confirmation for marketplace installs', async () => {
    const postMessage = jest.fn(async () => {});
    mockedVerifyPlatformInstallToken.mockReturnValue({
      platform: 'slack',
      teamId: 'T123',
      userId: 'U456',
      threadId: 'slack:T123:C123:1700000000.000100',
    });

    await expect(
      completeSlackMarketplaceInstall({
        verified: buildVerifiedMarketplaceState(),
        teamId: 'T123',
        userId: 'user-1',
        teamName: 'Kilo Team',
        slackAdapter: { postMessage } as never,
      })
    ).resolves.toEqual({ ok: true });

    expect(mockedLinkKiloUser).toHaveBeenCalledWith(
      { state: true },
      { platform: 'slack', teamId: 'T123', userId: 'U456' },
      'user-1'
    );
    expect(postMessage).toHaveBeenCalledWith(
      'slack:T123:C123:1700000000.000100',
      expect.objectContaining({
        markdown: expect.stringContaining('Kilo is connected to Kilo Team'),
      })
    );
  });

  it('rejects marketplace installs when the token Slack team does not match OAuth', async () => {
    mockedVerifyPlatformInstallToken.mockReturnValue({
      platform: 'slack',
      teamId: 'T999',
      userId: 'U456',
    });

    await expect(
      completeSlackMarketplaceInstall({
        verified: buildVerifiedMarketplaceState(),
        teamId: 'T123',
        userId: 'user-1',
        teamName: 'Kilo Team',
        slackAdapter: { postMessage: jest.fn() } as never,
      })
    ).resolves.toEqual({ ok: false, error: 'workspace_mismatch' });

    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      'Slack marketplace install team mismatch',
      expect.any(Object)
    );
  });
});
