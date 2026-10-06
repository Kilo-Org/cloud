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
});

describe('getSecurityCommandFailureMessage', () => {
  it('shows the preserved underlying error for exhausted retries', () => {
    expect(
      getSecurityCommandFailureMessage(
        command({
          status: 'failed',
          resultCode: 'QUEUE_RETRIES_EXHAUSTED',
          lastErrorRedacted: 'GitHub integration unavailable for finding',
        })
      )
    ).toBe('GitHub integration unavailable for finding');
  });

  it('falls back to friendly copy for exhausted retries without a preserved error', () => {
    const fallback = 'Action could not be completed after several attempts. Retry action.';
    expect(
      getSecurityCommandFailureMessage(
        command({ status: 'failed', resultCode: 'QUEUE_RETRIES_EXHAUSTED' })
      )
    ).toBe(fallback);
    expect(
      getSecurityCommandFailureMessage(
        command({
          status: 'failed',
          resultCode: 'QUEUE_RETRIES_EXHAUSTED',
          lastErrorRedacted: 'Queue command failed after maximum delivery attempts',
        })
      )
    ).toBe(fallback);
  });

  it('prefers fixed copy for known result codes over lastErrorRedacted', () => {
    expect(
      getSecurityCommandFailureMessage(
        command({
          status: 'failed',
          resultCode: 'GITHUB_AUTH_INVALID',
          lastErrorRedacted: 'raw backend detail',
        })
      )
    ).toBe('GitHub authorization needs attention. Re-authorize GitHub App, then retry.');
  });

  it('keeps lastErrorRedacted for admission failures and unknown codes', () => {
    expect(
      getSecurityCommandFailureMessage(
        command({
          status: 'failed',
          resultCode: 'QUEUE_ADMISSION_FAILED',
          lastErrorRedacted: 'queue unavailable',
        })
      )
    ).toBe('queue unavailable');
    expect(
      getSecurityCommandFailureMessage(
        command({ status: 'failed', resultCode: null, lastErrorRedacted: 'raw backend detail' })
      )
    ).toBe('raw backend detail');
  });
});
