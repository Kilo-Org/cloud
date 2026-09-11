import { describe, expect, it } from '@jest/globals';
import { getSlackTeamId } from './slack-webhook';

describe('getSlackTeamId', () => {
  it('uses the enterprise ID for an org-wide uninstall event', () => {
    expect(getSlackTeamId({ team_id: null, enterprise_id: 'E_GRID' })).toBe('E_GRID');
  });

  it('uses the workspace ID for a workspace uninstall event', () => {
    expect(getSlackTeamId({ team_id: 'T_WORKSPACE', enterprise_id: null })).toBe('T_WORKSPACE');
  });
});
