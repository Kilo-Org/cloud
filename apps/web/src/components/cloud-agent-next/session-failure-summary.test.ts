import { summarizeSessionFailureHistory } from './session-failure-summary';
import type { SessionFailureHistory } from './session-failure-summary';

function history(overrides?: Partial<SessionFailureHistory>): SessionFailureHistory {
  return {
    session: {
      cloudAgentSessionId: 'agent_failures',
      kiloSessionId: 'ses_failures',
      createdAt: '2035-01-10T00:00:00.000Z',
      organizationId: null,
      sandboxId: null,
      title: null,
      gitUrl: null,
    },
    setupFailure: null,
    runs: [],
    retention: { runWindowDays: 90, diagnosticDays: 30 },
    ...overrides,
  };
}

function run(status: string, messageId = `msg_${status}`): SessionFailureHistory['runs'][number] {
  return {
    messageId,
    status,
    queuedAt: null,
    dispatchAcceptedAt: null,
    agentActivityObservedAt: null,
    terminalAt: null,
    failureStage: null,
    failureCode: null,
    failureResponsibility: null,
    failureReason: null,
    userVisibleError: null,
    diagnostic: null,
    diagnosticExpiresAt: null,
  };
}

describe('summarizeSessionFailureHistory', () => {
  it('reports no failures for a clean session', () => {
    const summary = summarizeSessionFailureHistory(
      history({ runs: [run('completed'), run('interrupted')] })
    );

    expect(summary).toEqual({ hasFailures: false, failedRuns: [], completedCount: 1 });
  });

  it('counts failed runs and completed runs', () => {
    const failed = run('failed', 'msg_failed_one');
    const summary = summarizeSessionFailureHistory(
      history({ runs: [run('completed'), failed, run('failed', 'msg_failed_2')] })
    );

    expect(summary.hasFailures).toBe(true);
    expect(summary.completedCount).toBe(1);
    expect(summary.failedRuns.map(item => item.messageId)).toEqual([
      'msg_failed',
      'msg_failed_2',
    ]);
  });

  it('treats a setup failure as a failure even with no failed runs', () => {
    const summary = summarizeSessionFailureHistory(
      history({
        setupFailure: {
          occurredAt: '2035-01-10T00:06:00.000Z',
          stage: 'initial_admission',
          code: 'initial_admission_rejected',
          responsibility: 'unknown',
          reason: null,
          userVisibleError: 'Environment preparation failed (admission rejected)',
          diagnostic: null,
          diagnosticExpiresAt: null,
        },
      })
    );

    expect(summary.hasFailures).toBe(true);
    expect(summary.failedRuns).toEqual([]);
  });
});
