import { describe, expect, it, jest } from '@jest/globals';

const mockCaptureException = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException }));

import { getSlackTeamId, runSlackMaintenanceBestEffort } from './slack-webhook';

describe('getSlackTeamId', () => {
  it('uses the enterprise ID for an org-wide uninstall event', () => {
    expect(getSlackTeamId({ team_id: null, enterprise_id: 'E_GRID' })).toBe('E_GRID');
  });

  it('uses the enterprise installation ID when both enterprise and team IDs are present', () => {
    expect(
      getSlackTeamId({
        team_id: 'T_WORKSPACE',
        enterprise_id: 'E_GRID',
        authorizations: [{ enterprise_id: 'E_GRID', is_enterprise_install: true }],
      })
    ).toBe('E_GRID');
  });

  it('uses the workspace ID for a workspace uninstall event', () => {
    expect(getSlackTeamId({ team_id: 'T_WORKSPACE', enterprise_id: null })).toBe('T_WORKSPACE');
  });

  it('reads Chat SDK inner message and interactive team shapes', () => {
    expect(getSlackTeamId({ team: 'T_MESSAGE' })).toBe('T_MESSAGE');
    expect(getSlackTeamId({ team: { id: 'T_INTERACTIVE' } })).toBe('T_INTERACTIVE');
  });
});

describe('runSlackMaintenanceBestEffort', () => {
  it('continues to activation recovery when deletion maintenance fails', async () => {
    const recover = jest.fn(async () => undefined);
    await expect(
      runSlackMaintenanceBestEffort(
        'T_TEAM',
        async () => {
          throw new Error('database unavailable token=xoxb-secret');
        },
        recover
      )
    ).resolves.toBeUndefined();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain('xoxb-secret');
  });
});
