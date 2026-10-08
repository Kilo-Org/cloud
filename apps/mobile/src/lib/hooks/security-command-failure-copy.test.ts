import { describe, expect, it, vi } from 'vitest';

import { type SecurityCommand } from '@/lib/security-agent';
import { getSecurityCommandFailureMessage } from './security-command-failure-copy';

vi.mock('@/i18n', () => ({ i18n: { language: 'en', t: (key: string) => key } }));

function makeCommand(overrides: Partial<SecurityCommand> = {}): SecurityCommand {
  return {
    id: 'cmd-1',
    commandType: 'dismiss_finding',
    origin: 'manual',
    findingId: null,
    repoFullName: null,
    status: 'failed',
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

describe('getSecurityCommandFailureMessage', () => {
  it('shows the preserved underlying error for exhausted retries', () => {
    expect(
      getSecurityCommandFailureMessage(
        makeCommand({
          resultCode: 'QUEUE_RETRIES_EXHAUSTED',
          lastErrorRedacted: 'GitHub integration unavailable for finding',
        })
      )
    ).toBe('GitHub integration unavailable for finding');
  });

  it('falls back to translated copy for exhausted retries without a preserved error', () => {
    expect(
      getSecurityCommandFailureMessage(makeCommand({ resultCode: 'QUEUE_RETRIES_EXHAUSTED' }))
    ).toBe('securityAgent.commandFailure.queueRetriesExhausted');
    expect(
      getSecurityCommandFailureMessage(
        makeCommand({
          resultCode: 'QUEUE_RETRIES_EXHAUSTED',
          lastErrorRedacted: 'Queue command failed after maximum delivery attempts',
        })
      )
    ).toBe('securityAgent.commandFailure.queueRetriesExhausted');
  });

  it('keeps translated copy for known result codes', () => {
    expect(
      getSecurityCommandFailureMessage(
        makeCommand({ resultCode: 'GITHUB_AUTH_INVALID', lastErrorRedacted: 'raw backend detail' })
      )
    ).toBe('securityAgent.commandFailure.githubAuthInvalid');
  });
});
