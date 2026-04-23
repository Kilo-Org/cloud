const mockLimit = jest.fn();
const mockSyncSlackPlatformIntegrationToSdk = jest.fn();

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

jest.mock('@/lib/bot/slack-installation-sync', () => ({
  syncSlackPlatformIntegrationToSdk: mockSyncSlackPlatformIntegrationToSdk,
}));

import {
  ensureSlackIntegrationSyncedForNewBotInfra,
  getSlackTeamIdFromEventsApiBody,
  getSlackTeamIdFromInteractivityRawBody,
} from './slack-rollout';

const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

describe('Slack bot rollout helpers', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockSyncSlackPlatformIntegrationToSdk.mockReset();
    consoleErrorSpy.mockClear();
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  it('extracts team IDs from Events API envelopes', () => {
    expect(getSlackTeamIdFromEventsApiBody({ team_id: 'T123' })).toBe('T123');
    expect(() => getSlackTeamIdFromEventsApiBody({ event: { team: 'T456' } })).toThrow(
      'Expected Slack Events API body.team_id'
    );
    expect(() => getSlackTeamIdFromEventsApiBody({ event: {} })).toThrow(
      'Expected Slack Events API body.team_id'
    );
  });

  it('extracts team IDs from interactivity payload team objects', () => {
    const rawBody = new URLSearchParams({
      payload: JSON.stringify({ team: { id: 'T789' } }),
    }).toString();

    expect(getSlackTeamIdFromInteractivityRawBody(rawBody)).toBe('T789');
  });

  it('extracts team IDs from interactivity payload team_id fields', () => {
    const rawBody = new URLSearchParams({
      payload: JSON.stringify({ team_id: 'T999' }),
    }).toString();

    expect(getSlackTeamIdFromInteractivityRawBody(rawBody)).toBe('T999');
  });

  it('throws when interactivity payloads are invalid', () => {
    expect(() => getSlackTeamIdFromInteractivityRawBody('payload=not-json')).toThrow();
    expect(() =>
      getSlackTeamIdFromInteractivityRawBody(
        new URLSearchParams({ payload: JSON.stringify({ team: {} }) }).toString()
      )
    ).toThrow('Expected Slack interactivity payload.team.id');
    expect(() =>
      getSlackTeamIdFromInteractivityRawBody(
        new URLSearchParams({ payload: JSON.stringify({}) }).toString()
      )
    ).toThrow('Expected Slack interactivity payload.team.id or payload.team_id');
  });

  it('syncs canonical Slack integrations to Chat SDK state', async () => {
    const integration = {
      id: 'pi_123',
      platform: 'slack',
      platform_installation_id: 'T123',
      metadata: { access_token: 'xoxb-test' },
    };
    mockLimit.mockResolvedValue([integration]);
    mockSyncSlackPlatformIntegrationToSdk.mockResolvedValue(true);

    await ensureSlackIntegrationSyncedForNewBotInfra('T123');

    expect(mockSyncSlackPlatformIntegrationToSdk).toHaveBeenCalledWith(integration);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('does nothing when no canonical Slack integration exists', async () => {
    mockLimit.mockResolvedValue([]);

    await ensureSlackIntegrationSyncedForNewBotInfra('T404');

    expect(mockSyncSlackPlatformIntegrationToSdk).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('logs and does not throw when a Slack integration cannot be synced', async () => {
    const integration = {
      id: 'pi_missing_token',
      platform: 'slack',
      platform_installation_id: 'T123',
      metadata: {},
    };
    mockLimit.mockResolvedValue([integration]);
    mockSyncSlackPlatformIntegrationToSdk.mockResolvedValue(false);

    await expect(ensureSlackIntegrationSyncedForNewBotInfra('T123')).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[SlackBot:Sync] Could not sync Slack integration to Chat SDK installation',
      { integrationId: 'pi_missing_token', teamId: 'T123' }
    );
  });
});
