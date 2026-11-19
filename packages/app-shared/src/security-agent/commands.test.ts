import { describe, expect, it } from 'vitest';

import {
  getSecurityCommandFailureMessage,
  getSecurityCommandInvalidationScopes,
  isActiveSecurityCommand,
  mergeTrackedCommandIds,
  SECURITY_COMMAND_TYPES,
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

  it('maps every command type to a non-empty invalidation scope list', () => {
    for (const commandType of SECURITY_COMMAND_TYPES) {
      expect(getSecurityCommandInvalidationScopes(commandType).length).toBeGreaterThan(0);
    }
  });

  it('deduplicates recovered and locally tracked command ids', () => {
    expect(mergeTrackedCommandIds(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('uses actionable GitHub authorization copy when a token is unavailable', () => {
    expect(
      getSecurityCommandFailureMessage(command({ resultCode: 'GITHUB_TOKEN_UNAVAILABLE' }))
    ).toBe('GitHub authorization needs attention. Re-authorize GitHub App, then retry.');
  });

  it('uses authored queue-admission copy instead of the backend detail', () => {
    expect(
      getSecurityCommandFailureMessage(
        command({ resultCode: 'QUEUE_ADMISSION_FAILED', lastErrorRedacted: '…maximum delivery attempts' })
      )
    ).toBe('Queued action could not be admitted. Retry action.');
  });

  it('does not show the backend detail for an unknown result code', () => {
    expect(
      getSecurityCommandFailureMessage(
        command({ resultCode: 'SOME_FUTURE_CODE', lastErrorRedacted: 'raw backend text' })
      )
    ).toBe('Queued action failed. Retry action.');
    expect(getSecurityCommandFailureMessage(command({ resultCode: null, lastErrorRedacted: 'raw backend text' }))).toBe(
      'Queued action failed. Retry action.'
    );
  });
});
