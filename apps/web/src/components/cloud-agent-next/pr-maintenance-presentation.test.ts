import {
  getMaintenancePublicationLabel,
  getMaintenanceRecoveryMessage,
  getMaintenanceRepositoryUrl,
  getMaintenanceStatusLabel,
  getMaintenanceControlsState,
  getMaintenanceExecutionHelp,
  getMaintenanceRefetchInterval,
  getMaintenanceEvidenceUrl,
} from './pr-maintenance-presentation';
import { maintenanceRecoveryActions } from '@/lib/cloud-agent/watch-pr-maintenance-reasons';

describe('maintenance presentation', () => {
  it('never enables automatic writes or resume from a legacy observation watch', () => {
    expect(
      getMaintenanceControlsState({
        status: 'paused',
        policy: { version: 1 },
        lifecycle_reason: null,
        rateLimitRetryAt: null,
      })
    ).toMatchObject({ enabled: false, legacyWatchActive: true, canResume: false });
  });

  it('offers resume only for a recoverable automatic watch, without resetting limits', () => {
    const watch = {
      status: 'paused' as const,
      policy: { version: 2 as const },
      lifecycle_reason: 'user_pause',
      rateLimitRetryAt: null,
    };
    expect(getMaintenanceControlsState(watch)).toMatchObject({ enabled: true, canResume: true });
    for (const lifecycle_reason of ['total_attempt_limit', 'problem_attempt_limit']) {
      expect(getMaintenanceControlsState({ ...watch, lifecycle_reason }).canResume).toBe(false);
    }
    expect(getMaintenanceControlsState({ ...watch, status: 'finished' })).toMatchObject({
      enabled: false,
      canResume: false,
    });
  });

  it('keeps a rate-limited watch enabled and permits recheck after the reset time', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const watch = {
      status: 'watching' as const,
      policy: { version: 2 as const },
      lifecycle_reason: 'rate_limited',
      rateLimitRetryAt: new Date(now + 60_000).toISOString(),
    };
    expect(getMaintenanceControlsState(watch, now)).toMatchObject({
      enabled: true,
      waitingForBudget: true,
    });
    expect(getMaintenanceControlsState(watch, now + 60_000).waitingForBudget).toBe(false);
  });
  it('keeps the watch lifecycle separate from execution', () => {
    expect(
      getMaintenanceStatusLabel({ status: 'watching', execution_status: 'waiting_for_session' })
    ).toBe('Waiting for your session to finish');
    expect(getMaintenanceStatusLabel({ status: 'paused', execution_status: 'fixing' })).toBe(
      'Paused'
    );
    expect(getMaintenanceStatusLabel({ status: 'finished', execution_status: 'needs_input' })).toBe(
      'Finished'
    );
  });

  it('never reports a failed or missing push as publication success', () => {
    expect(getMaintenancePublicationLabel(null)).toBe('No verified publication result');
    expect(getMaintenancePublicationLabel({ status: 'unknown', reason: 'Transport failed' })).toBe(
      'Push outcome unknown'
    );
    expect(getMaintenancePublicationLabel({ status: 'failed', reason: 'Lease rejected' })).toBe(
      'Push failed'
    );
    expect(getMaintenancePublicationLabel({ status: 'not_attempted', reason: 'Question' })).toBe(
      'No push attempted'
    );
  });

  it('names only the verified published commit without claiming merge readiness', () => {
    const label = getMaintenancePublicationLabel({
      status: 'published',
      source: 'git',
      repoUrl: 'https://github.com/example/repository',
      headRef: 'feature',
      observedHeadSha: 'a'.repeat(40),
      pushedHeadSha: 'b'.repeat(40),
      remoteHeadSha: 'b'.repeat(40),
      baseSha: 'c'.repeat(40),
      exactLease: `refs/heads/feature:${'a'.repeat(40)}`,
      pushExitCode: 0,
      verifiedAt: '2026-11-12T12:00:00.000Z',
    });
    expect(label).toBe('Published bbbbbbb; remote commit verified');
    expect(label).not.toMatch(/ready|approved|checks passed/i);
  });

  it('explains specific recoveries and preserves unfamiliar reasons', () => {
    expect(getMaintenanceRecoveryMessage('maintenance_question')).toContain('same chat');
    expect(getMaintenanceRecoveryMessage('maintenance_access_unavailable')).toContain(
      'Restore repository access'
    );
    expect(getMaintenanceRecoveryMessage('new_blocker')).toContain('Inspect the maintenance chat');
    expect(getMaintenanceRecoveryMessage(null)).toBeNull();
  });

  it.each([
    'maintenance_result_unavailable_after_answer',
    'maintenance_result_unavailable_after_publication',
  ])('keeps %s recovery manual without offering Resume', reason => {
    expect(getMaintenanceRecoveryMessage(reason)).toContain(
      'then Stop and enable maintenance with new consent'
    );
    expect(getMaintenanceRecoveryMessage(reason)).not.toMatch(/resume|recheck/i);
    expect(
      getMaintenanceControlsState({
        status: 'paused',
        policy: { version: 2 },
        lifecycle_reason: reason,
        rateLimitRetryAt: null,
      }).canResume
    ).toBe(false);
  });

  it('does not show live execution help on paused, finished, or observation-only watches', () => {
    const watch = {
      status: 'watching' as const,
      execution_status: 'waiting_for_session' as const,
      policy: { version: 2 as const },
      activeChat: { chatAvailable: true },
    };
    expect(getMaintenanceExecutionHelp(watch)).not.toBeNull();
    expect(getMaintenanceExecutionHelp({ ...watch, status: 'paused' })).toBeNull();
    expect(getMaintenanceExecutionHelp({ ...watch, status: 'finished' })).toBeNull();
    expect(getMaintenanceExecutionHelp({ ...watch, policy: { version: 1 } })).toBeNull();
  });

  it('leaves the answerable needs-input action to the recovery message', () => {
    const answered = {
      status: 'watching' as const,
      execution_status: 'needs_input' as const,
      policy: { version: 2 as const },
      activeChat: { chatAvailable: true },
    };
    expect(getMaintenanceExecutionHelp(answered)).toBeNull();
    expect(
      getMaintenanceExecutionHelp({
        ...answered,
        activeChat: { chatAvailable: false },
      })
    ).toContain('No maintenance chat needs an answer');
  });

  it('does not poll absent or finished watches', () => {
    expect(getMaintenanceRefetchInterval(undefined)).toBe(false);
    expect(getMaintenanceRefetchInterval(null)).toBe(false);
    expect(getMaintenanceRefetchInterval({ status: 'finished' })).toBe(false);
    expect(getMaintenanceRefetchInterval({ status: 'watching' })).toBe(5_000);
    expect(getMaintenanceRefetchInterval({ status: 'paused' })).toBe(5_000);
  });

  it('offers Resume only for the backend recovery vocabulary that permits it', () => {
    for (const [reason, action] of Object.entries(maintenanceRecoveryActions)) {
      const result = getMaintenanceControlsState({
        status: 'paused',
        policy: { version: 2 },
        lifecycle_reason: reason,
        rateLimitRetryAt: null,
      });
      expect(result.canResume).toBe(action === 'resume');
      expect(getMaintenanceRecoveryMessage(reason)).toBeTruthy();
      expect(getMaintenanceRecoveryMessage(reason)).not.toBe(reason.replaceAll('_', ' '));
    }
    expect(
      getMaintenanceControlsState({
        status: 'paused',
        policy: { version: 2 },
        lifecycle_reason: 'unknown_pause',
        rateLimitRetryAt: null,
      }).canResume
    ).toBe(false);
  });

  it('permits only absolute HTTP(S) verification evidence without embedded credentials', () => {
    expect(getMaintenanceEvidenceUrl('https://ci.example.com/job/123')).toBe(
      'https://ci.example.com/job/123'
    );
    expect(getMaintenanceEvidenceUrl('http://localhost:3000/evidence')).toBe(
      'http://localhost:3000/evidence'
    );
    const credentialUrl = new URL('https://ci.example.com/proof');
    credentialUrl.username = 'synthetic-user';
    credentialUrl.password = 'synthetic-password';
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,proof',
      'file:///tmp/proof',
      'ftp://ci.example.com/proof',
      '//ci.example.com/proof',
      '/proof',
      'not a URL',
      credentialUrl.href,
    ]) {
      expect(getMaintenanceEvidenceUrl(url)).toBeNull();
    }
  });

  it('limits enablement identity to canonical GitHub repository URLs', () => {
    expect(getMaintenanceRepositoryUrl('https://github.com/Example/Repository/pull/123')).toBe(
      'https://github.com/example/repository'
    );
    for (const url of [
      'https://gitlab.com/example/repository/pull/123',
      'https://github.com/example/repository/pull/123/files',
      'https://github.com/example/repository/pull/0',
      'https://github.com/other@example/repository/pull/123',
    ]) {
      expect(getMaintenanceRepositoryUrl(url)).toBeNull();
    }
  });
});
