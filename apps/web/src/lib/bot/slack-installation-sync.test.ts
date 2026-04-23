const mockInitialize = jest.fn();
const mockSetInstallation = jest.fn();
const mockGetAdapter = jest.fn((_name: string) => ({ setInstallation: mockSetInstallation }));
const mockLimit = jest.fn();

jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: () => mockInitialize(),
    getAdapter: (name: string) => mockGetAdapter(name),
  },
}));

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: mockLimit,
        })),
      })),
    })),
  },
}));

import type { OAuthV2Response } from '@slack/oauth';
import {
  ensureSlackInstallationSyncedForTeam,
  extractSdkInstallationData,
  syncOldSlackInstallationToSdk,
  syncSlackPlatformIntegrationToSdk,
} from './slack-installation-sync';

const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

function makeOAuthResponse(overrides: Partial<OAuthV2Response> = {}): OAuthV2Response {
  return {
    ok: true,
    app_id: 'A123',
    authed_user: { id: 'U123' },
    team: { id: 'T123', name: 'Test Team' },
    enterprise: null,
    is_enterprise_install: false,
    access_token: 'xoxb-test-token',
    bot_user_id: 'B123',
    ...overrides,
  };
}

describe('extractSdkInstallationData', () => {
  beforeEach(() => {
    mockInitialize.mockReset();
    mockSetInstallation.mockReset();
    mockGetAdapter.mockClear();
    mockLimit.mockReset();
    consoleErrorSpy.mockClear();
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  it('stores team.id as teamId', () => {
    const result = extractSdkInstallationData(
      makeOAuthResponse({ team: { id: 'T456', name: 'Team Name' } })
    );
    expect(result.teamId).toBe('T456');
  });

  it('stores access_token as botToken', () => {
    const result = extractSdkInstallationData(makeOAuthResponse({ access_token: 'xoxb-abc' }));
    expect(result.botToken).toBe('xoxb-abc');
  });

  it('stores bot_user_id when present', () => {
    const result = extractSdkInstallationData(makeOAuthResponse({ bot_user_id: 'B456' }));
    expect(result.botUserId).toBe('B456');
  });

  it('stores team.name when present', () => {
    const result = extractSdkInstallationData(
      makeOAuthResponse({ team: { id: 'T789', name: 'Acme' } })
    );
    expect(result.teamName).toBe('Acme');
  });

  it('omits botUserId when bot_user_id is missing', () => {
    const { bot_user_id: _ignore, ...withoutBotUserId } = makeOAuthResponse({
      bot_user_id: undefined,
    });
    const result = extractSdkInstallationData(withoutBotUserId);
    expect(result.botUserId).toBeUndefined();
  });

  it('omits teamName when team.name is missing', () => {
    const result = extractSdkInstallationData(
      makeOAuthResponse({ team: { id: 'T000', name: '' } })
    );
    expect(result.teamName).toBeUndefined();
  });

  it('throws when team.id is missing', () => {
    expect(() => extractSdkInstallationData(makeOAuthResponse({ team: null }))).toThrow(
      'Missing team.id in Slack OAuth response'
    );
  });

  it('throws when access_token is missing', () => {
    expect(() =>
      extractSdkInstallationData(makeOAuthResponse({ access_token: undefined }))
    ).toThrow('Missing access_token in Slack OAuth response');
  });

  it('syncs OAuth responses through the canonical bot state', async () => {
    await syncOldSlackInstallationToSdk(
      makeOAuthResponse({
        team: { id: 'T456', name: 'Canonical Team' },
        access_token: 'xoxb-canonical',
        bot_user_id: 'B456',
      })
    );

    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockGetAdapter).toHaveBeenCalledWith('slack');
    expect(mockSetInstallation).toHaveBeenCalledWith('T456', {
      botToken: 'xoxb-canonical',
      botUserId: 'B456',
      teamName: 'Canonical Team',
    });
  });

  it('syncs Slack platform integrations through the canonical bot state', async () => {
    const integration = {
      platform_installation_id: 'T789',
      platform_account_login: 'Workspace Name',
      metadata: {
        access_token: 'xoxb-from-db',
        bot_user_id: 'B789',
      },
    } as Parameters<typeof syncSlackPlatformIntegrationToSdk>[0];

    await expect(syncSlackPlatformIntegrationToSdk(integration)).resolves.toBe(true);

    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockSetInstallation).toHaveBeenCalledWith('T789', {
      botToken: 'xoxb-from-db',
      botUserId: 'B789',
      teamName: 'Workspace Name',
    });
  });

  it('does not sync Slack platform integrations missing access tokens', async () => {
    const integration = {
      platform_installation_id: 'T789',
      platform_account_login: 'Workspace Name',
      metadata: {},
    } as Parameters<typeof syncSlackPlatformIntegrationToSdk>[0];

    await expect(syncSlackPlatformIntegrationToSdk(integration)).resolves.toBe(false);

    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockSetInstallation).not.toHaveBeenCalled();
  });

  it('syncs canonical Slack integrations to Chat SDK state by team ID', async () => {
    const integration = {
      id: 'pi_123',
      platform: 'slack',
      platform_installation_id: 'T123',
      platform_account_login: 'Workspace Name',
      metadata: { access_token: 'xoxb-test' },
    } as Parameters<typeof syncSlackPlatformIntegrationToSdk>[0];
    mockLimit.mockResolvedValue([integration]);

    await ensureSlackInstallationSyncedForTeam('T123');

    expect(mockSetInstallation).toHaveBeenCalledWith('T123', {
      botToken: 'xoxb-test',
      botUserId: undefined,
      teamName: 'Workspace Name',
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('does nothing when no canonical Slack integration exists for a team ID', async () => {
    mockLimit.mockResolvedValue([]);

    await ensureSlackInstallationSyncedForTeam('T404');

    expect(mockSetInstallation).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('logs and does not throw when a Slack integration cannot be synced by team ID', async () => {
    const integration = {
      id: 'pi_missing_token',
      platform: 'slack',
      platform_installation_id: 'T123',
      metadata: {},
    } as Parameters<typeof syncSlackPlatformIntegrationToSdk>[0];
    mockLimit.mockResolvedValue([integration]);

    await expect(ensureSlackInstallationSyncedForTeam('T123')).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[SlackBot:Sync] Could not sync Slack integration to Chat SDK installation',
      { integrationId: 'pi_missing_token', teamId: 'T123' }
    );
  });
});
