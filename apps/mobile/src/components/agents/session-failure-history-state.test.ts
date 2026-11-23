import { describe, expect, it } from 'vitest';

import {
  failureHistoryCounts,
  hasReportedFailures,
  isAddressableSessionId,
  isTerminalAccessError,
  retainedDiagnostic,
  type SessionFailureHistory,
  shouldRetryFailureHistory,
} from './session-failure-history-state';

function trpcError(data: Record<string, unknown>): Error {
  return Object.assign(new Error('failed'), { data });
}

describe('isAddressableSessionId', () => {
  it('accepts the control-plane prefixes and nothing else', () => {
    expect(isAddressableSessionId('agent_failures_history_fixture')).toBe(true);
    expect(isAddressableSessionId('workspace_1b0e6a52-0000-4000-8000-000000000000')).toBe(true);
    expect(isAddressableSessionId('ses_failuresHistoryFixture0001')).toBe(false);
    expect(isAddressableSessionId('cag_designGateAgentChat')).toBe(false);
    expect(isAddressableSessionId(null)).toBe(false);
  });
});

describe('isTerminalAccessError', () => {
  it.each([{ code: 'FORBIDDEN' }, { code: 'UNAUTHORIZED' }, { code: 'NOT_FOUND' }])(
    'treats %j as a permanent denial',
    data => {
      expect(isTerminalAccessError(trpcError(data))).toBe(true);
    }
  );

  it.each([{ httpStatus: 403 }, { httpStatus: 404 }])(
    'treats a bare %j as the same permanent denial',
    data => {
      expect(isTerminalAccessError(trpcError(data))).toBe(true);
    }
  );

  it('does not treat a transport failure or a 5xx as a permanent denial', () => {
    for (const error of [
      null,
      undefined,
      'boom',
      new Error('network'),
      trpcError({ httpStatus: 500 }),
    ]) {
      expect(isTerminalAccessError(error)).toBe(false);
    }
  });
});

describe('shouldRetryFailureHistory', () => {
  it('never retries an access refusal', () => {
    expect(shouldRetryFailureHistory(0, trpcError({ code: 'FORBIDDEN' }))).toBe(false);
    expect(shouldRetryFailureHistory(0, trpcError({ httpStatus: 404 }))).toBe(false);
  });

  it('does not retry another 4xx, which repeats the same verdict', () => {
    expect(shouldRetryFailureHistory(0, trpcError({ code: 'BAD_REQUEST', httpStatus: 400 }))).toBe(
      false
    );
  });

  it('retries a transport failure or a 5xx within the bound of two attempts', () => {
    expect(shouldRetryFailureHistory(0, new Error('network'))).toBe(true);
    expect(shouldRetryFailureHistory(1, trpcError({ httpStatus: 503 }))).toBe(true);
    expect(shouldRetryFailureHistory(2, trpcError({ httpStatus: 503 }))).toBe(false);
    expect(shouldRetryFailureHistory(2, new Error('network'))).toBe(false);
  });
});

describe('failure history summarising', () => {
  const run = (status: string, messageId = `msg_${status}`) => ({ status, messageId });

  function history(overrides: {
    setupFailure?: unknown;
    runs?: ReturnType<typeof run>[];
  }): SessionFailureHistory {
    return {
      session: {
        cloudAgentSessionId: 'agent_failures',
        kiloSessionId: 'ses_failures',
        createdAt: null,
        organizationId: null,
        sandboxId: null,
        title: null,
        gitUrl: null,
      },
      setupFailure: (overrides.setupFailure ?? null) as never,
      runs: (overrides.runs ?? []) as never,
      retention: { runWindowDays: 90, diagnosticDays: 30, historyRunLimit: 50 },
    };
  }

  it('reports no failure for a session whose runs all settled well', () => {
    const data = history({ runs: [run('completed'), run('interrupted')] });
    expect(hasReportedFailures(data)).toBe(false);
    expect(failureHistoryCounts(data)).toEqual({ failed: 0, completed: 1 });
  });

  it('reports a failure for each failed run and counts the completed ones', () => {
    const data = history({
      runs: [run('completed'), run('failed', 'msg_a'), run('failed', 'msg_b')],
    });
    expect(hasReportedFailures(data)).toBe(true);
    expect(failureHistoryCounts(data)).toEqual({ failed: 2, completed: 1 });
  });

  it('treats a setup failure as a failure even with no failed run', () => {
    const data = history({
      setupFailure: { occurredAt: '2035-01-10T00:06:00.000Z' },
      runs: [run('completed')],
    });
    expect(hasReportedFailures(data)).toBe(true);
  });
});

describe('retainedDiagnostic', () => {
  it('shows the text only while the router reports it present', () => {
    expect(retainedDiagnostic({ diagnostic: 'wrapper stopped', diagnosticStatus: 'present' })).toBe(
      'wrapper stopped'
    );
    expect(
      retainedDiagnostic({ diagnostic: 'wrapper stopped', diagnosticStatus: 'expired' })
    ).toBeUndefined();
    expect(retainedDiagnostic({ diagnostic: null, diagnosticStatus: 'missing' })).toBeUndefined();
  });
});
