import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { type SecurityCommand } from '@/lib/security-agent';

import { getSecurityCommandFailureMessage } from './security-command-failure-copy';

function command(overrides: Partial<SecurityCommand> = {}): SecurityCommand {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    commandType: 'sync',
    origin: 'dashboard_refresh',
    findingId: null,
    repoFullName: null,
    status: 'failed',
    resultCode: null,
    resultMetadata: null,
    lastErrorRedacted: null,
    acceptedAt: '2026-11-19T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

// Mirrors the pins in packages/app-shared/src/security-agent/commands.test.ts:
// the backend's lastErrorRedacted never becomes toast text on either
// platform, and the two implementations must not drift apart.
describe('getSecurityCommandFailureMessage (mobile mirror)', () => {
  it('translates a curated result code from its catalog key', () => {
    expect(
      getSecurityCommandFailureMessage(
        command({ resultCode: 'GITHUB_TOKEN_UNAVAILABLE', lastErrorRedacted: 'raw backend text' })
      )
    ).toBe(i18n.t('securityAgent.commandFailure.githubAuthInvalid'));
  });

  it('uses the queue-admission catalog copy instead of the backend detail', () => {
    expect(
      getSecurityCommandFailureMessage(
        command({ resultCode: 'QUEUE_ADMISSION_FAILED', lastErrorRedacted: 'raw backend text' })
      )
    ).toBe(i18n.t('securityAgent.commandFailure.queueAdmissionFailed'));
  });

  it('maps each worker-emitted code to the closest catalog copy', () => {
    expect(
      getSecurityCommandFailureMessage(
        command({
          resultCode: 'GITHUB_DISMISSAL_PERMISSION_REQUIRED',
          lastErrorRedacted: 'unused worker copy',
        })
      )
    ).toBe(i18n.t('securityAgent.commandFailure.githubAuthInvalid'));
    expect(getSecurityCommandFailureMessage(command({ resultCode: 'INSUFFICIENT_CREDITS' }))).toBe(
      i18n.t('agentChat.session.notEnoughCredits')
    );
  });

  it('uses the generic catalog copy for an unknown result code', () => {
    expect(
      getSecurityCommandFailureMessage(
        command({ resultCode: 'SOME_FUTURE_CODE', lastErrorRedacted: 'raw backend text' })
      )
    ).toBe(i18n.t('securityAgent.commandFailure.generic'));
    expect(
      getSecurityCommandFailureMessage(
        command({ resultCode: null, lastErrorRedacted: 'raw backend text' })
      )
    ).toBe(i18n.t('securityAgent.commandFailure.generic'));
  });
});
