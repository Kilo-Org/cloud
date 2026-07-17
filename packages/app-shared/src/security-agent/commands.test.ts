import { describe, expect, it } from 'vitest';

import {
  getSecurityCommandInvalidationScopes,
  isActiveSecurityCommand,
  mergeTrackedCommandIds,
  type SecurityCommand,
} from './commands';

function command(overrides: Partial<SecurityCommand> = {}): SecurityCommand {
  return {
    status: 'accepted',
    resultCode: null,
    lastErrorRedacted: null,
    ...overrides,
  };
}

describe('security agent command helpers', () => {
  it('treats accepted and running commands as active', () => {
    expect(isActiveSecurityCommand(command({ status: 'accepted' }))).toBe(true);
    expect(isActiveSecurityCommand(command({ status: 'running' }))).toBe(true);
    expect(isActiveSecurityCommand(command({ status: 'succeeded' }))).toBe(false);
  });

  it('invalidates sync data across the full web scope superset', () => {
    expect(getSecurityCommandInvalidationScopes('sync')).toEqual([
      'findings',
      'findingDetails',
      'analysis',
      'stats',
      'dashboardStats',
      'lastSyncTime',
      'repositories',
      'orphanedRepositories',
      'autoDismissEligible',
      'permissionStatus',
    ]);
  });

  it('deduplicates recovered and locally tracked command ids', () => {
    expect(mergeTrackedCommandIds(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});
