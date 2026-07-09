import { describe, expect, it } from 'vitest';

import {
  getSecurityCommandInvalidationScopes,
  isActiveSecurityCommand,
  mergeTrackedCommandIds,
} from '@/lib/security-agent-commands';
import { type SecurityCommand } from '@/lib/security-agent';

function command(overrides: Partial<SecurityCommand> = {}): SecurityCommand {
  return {
    id: 'command-1',
    commandType: 'sync',
    origin: 'manual',
    findingId: null,
    repoFullName: null,
    status: 'accepted',
    resultCode: null,
    resultMetadata: null,
    lastErrorRedacted: null,
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe('security agent command helpers', () => {
  it('treats accepted and running commands as active', () => {
    expect(isActiveSecurityCommand(command({ status: 'accepted' }))).toBe(true);
    expect(isActiveSecurityCommand(command({ status: 'running' }))).toBe(true);
    expect(isActiveSecurityCommand(command({ status: 'succeeded' }))).toBe(false);
  });

  it('invalidates sync data without config', () => {
    expect(getSecurityCommandInvalidationScopes('sync')).toEqual([
      'findings',
      'findingDetails',
      'analysis',
      'stats',
      'dashboardStats',
      'lastSyncTime',
      'repositories',
      'permissionStatus',
    ]);
  });

  it('deduplicates recovered and locally tracked command ids', () => {
    expect(mergeTrackedCommandIds(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});
