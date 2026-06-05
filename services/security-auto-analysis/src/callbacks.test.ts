import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transitionAnalysisCallbackLifecycle } from './analysis-start-lifecycle.js';
import {
  classifyAnalysisCallback,
  consumeAnalysisCallbackBatch,
  finalizeCompletedAnalysisCallback,
  finalizeFailedAnalysisCallback,
  mapAnalysisCallbackFailure,
  resolveCompletedCallbackMarkdown,
  type SecurityAnalysisCallbackPayload,
} from './callbacks.js';

const failedPayload = {
  sessionId: 'session-123',
  cloudAgentSessionId: 'agent-123',
  executionId: 'exec-123',
  status: 'failed',
  errorMessage: 'upstream 503',
} satisfies SecurityAnalysisCallbackPayload;
const ATTEMPT_TOKEN = 'attempt-token-123';

vi.mock('./analysis-start-lifecycle.js', () => ({
  transitionAnalysisCallbackLifecycle: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(transitionAnalysisCallbackLifecycle).mockReset();
  vi.mocked(transitionAnalysisCallbackLifecycle).mockResolvedValue({ status: 'completed' });
});

describe('classifyAnalysisCallback', () => {
  it('rejects stale session callbacks before terminalization', () => {
    expect(
      classifyAnalysisCallback(
        {
          session_id: 'agent-current',
          cli_session_id: 'ses-current',
          ignored_reason: null,
          analysis_status: 'running',
        },
        failedPayload
      )
    ).toBe('stale-session');
  });

  it('treats duplicate terminal callbacks as idempotent no-ops', () => {
    expect(
      classifyAnalysisCallback(
        {
          session_id: 'agent-123',
          cli_session_id: null,
          ignored_reason: null,
          analysis_status: 'failed',
        },
        failedPayload
      )
    ).toBe('already-terminal');
  });

  it('marks superseded callbacks for queue release', () => {
    expect(
      classifyAnalysisCallback(
        {
          session_id: 'agent-123',
          cli_session_id: null,
          ignored_reason: 'superseded:new-finding',
          analysis_status: 'running',
        },
        failedPayload
      )
    ).toBe('superseded');
  });

  it('rejects callbacks from an older active attempt', () => {
    expect(
      classifyAnalysisCallback(
        {
          session_id: null,
          cli_session_id: null,
          ignored_reason: null,
          analysis_status: 'pending',
        },
        failedPayload,
        { expected: 'old-attempt', active: ATTEMPT_TOKEN }
      )
    ).toBe('stale-attempt');
  });

  it('rejects callbacks when the active attempt has already disappeared', () => {
    expect(
      classifyAnalysisCallback(
        {
          session_id: null,
          cli_session_id: null,
          ignored_reason: null,
          analysis_status: 'running',
        },
        failedPayload,
        { expected: ATTEMPT_TOKEN, active: null }
      )
    ).toBe('stale-attempt');
  });
});

describe('resolveCompletedCallbackMarkdown', () => {
  it('retries session-backed markdown resolution when callback text has not arrived', async () => {
    let attempts = 0;
    await expect(
      resolveCompletedCallbackMarkdown({
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          kiloSessionId: 'ses-123',
          status: 'completed',
        },
        fetchLatestAssistantText: async () => {
          attempts += 1;
          return attempts === 2 ? '# Delayed snapshot text' : null;
        },
        sleep: async () => undefined,
      })
    ).resolves.toBe('# Delayed snapshot text');
    expect(attempts).toBe(2);
  });
});

describe('finalizeCompletedAnalysisCallback', () => {
  it('persists extracted sandbox analysis and terminal queue status for completed callbacks', async () => {
    const updates: unknown[] = [];
    const executes: unknown[] = [];
    const auditRows: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                session_id: 'agent-123',
                cli_session_id: 'ses-123',
                ignored_reason: null,
                analysis_status: 'running',
                claimToken: ATTEMPT_TOKEN,
                owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                owned_by_user_id: null,
                analysis: {
                  analyzedAt: '2026-05-18T08:00:00.000Z',
                  analysisModel: 'analysis/model',
                  triageModel: 'triage/model',
                  triggeredByUserId: 'user-123',
                  correlationId: 'correlation-123',
                },
              },
            ],
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: () => ({
            returning: async () => {
              updates.push(values);
              return [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }];
            },
          }),
        }),
      }),
      execute: async (statement: unknown) => {
        executes.push(statement);
        return { rows: [] };
      },
      insert: () => ({
        values: async (values: unknown) => {
          auditRows.push(values);
        },
      }),
    };
    const autoDismissCalls: unknown[] = [];
    const analyticsCalls: unknown[] = [];

    await expect(
      finalizeCompletedAnalysisCallback({
        db: db as never,
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          kiloSessionId: 'ses-123',
          status: 'completed',
          lastAssistantMessageText: '# Completed analysis',
        },
        extractSandboxAnalysis: async ({ rawMarkdown }) => ({
          isExploitable: false,
          exploitabilityReasoning: 'No reachable usage',
          usageLocations: [],
          suggestedFix: 'Upgrade package',
          suggestedAction: 'dismiss',
          summary: 'Not exploitable.',
          rawMarkdown,
          analysisAt: '2026-05-18T08:05:00.000Z',
        }),
        maybeAutoDismissAnalysis: async params => {
          autoDismissCalls.push(params);
        },
        trackCompletedAnalysis: async params => {
          analyticsCalls.push(params);
        },
      })
    ).resolves.toEqual({ status: 'completed-finalized' });

    expect(updates).toHaveLength(0);
    expect(executes).toHaveLength(0);
    expect(transitionAnalysisCallbackLifecycle).toHaveBeenCalledWith(db, {
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptToken: ATTEMPT_TOKEN,
      outcome: expect.objectContaining({
        type: 'completed',
        analysis: expect.objectContaining({
          rawMarkdown: '# Completed analysis',
        }),
      }),
    });
    expect(auditRows).toHaveLength(1);
    expect(autoDismissCalls).toHaveLength(1);
    expect(analyticsCalls).toHaveLength(1);
  });

  it('delegates already-terminal completed callback retries for queue healing', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                session_id: 'agent-123',
                cli_session_id: 'ses-123',
                ignored_reason: null,
                analysis_status: 'completed',
              },
            ],
          }),
        }),
      }),
    };
    const extractSandboxAnalysis = vi.fn();

    await expect(
      finalizeCompletedAnalysisCallback({
        db: db as never,
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          kiloSessionId: 'ses-123',
          status: 'completed',
          lastAssistantMessageText: '# Duplicate completion',
        },
        extractSandboxAnalysis,
      })
    ).resolves.toEqual({ status: 'already-terminal' });

    expect(extractSandboxAnalysis).not.toHaveBeenCalled();
    expect(transitionAnalysisCallbackLifecycle).toHaveBeenCalledWith(db, {
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptToken: ATTEMPT_TOKEN,
      outcome: {
        type: 'already-terminal',
        findingStatus: 'completed',
        failureCode: null,
        errorMessage: null,
      },
    });
  });

  it('delegates superseded completed callbacks to lifecycle settlement', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                session_id: 'agent-123',
                cli_session_id: 'ses-123',
                ignored_reason: 'superseded:canonical-finding',
                analysis_status: 'running',
                claimToken: ATTEMPT_TOKEN,
              },
            ],
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      execute: async () => ({ rows: [] }),
    };
    const extractSandboxAnalysis = vi.fn();

    await expect(
      finalizeCompletedAnalysisCallback({
        db: db as never,
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          kiloSessionId: 'ses-123',
          status: 'completed',
          lastAssistantMessageText: '# Superseded completion',
        },
        extractSandboxAnalysis,
      })
    ).resolves.toEqual({ status: 'superseded' });

    expect(extractSandboxAnalysis).not.toHaveBeenCalled();
    expect(transitionAnalysisCallbackLifecycle).toHaveBeenCalledWith(db, {
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptToken: ATTEMPT_TOKEN,
      outcome: { type: 'superseded' },
    });
  });

  it('terminalizes completed callbacks when result markdown never becomes available', async () => {
    const findingUpdates: unknown[] = [];
    const queueTransitions: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                session_id: 'agent-123',
                cli_session_id: 'ses-123',
                ignored_reason: null,
                analysis_status: 'running',
                claimToken: ATTEMPT_TOKEN,
              },
            ],
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: () => ({
            returning: async () => {
              findingUpdates.push(values);
              return [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }];
            },
          }),
        }),
      }),
      execute: async (statement: unknown) => {
        queueTransitions.push(statement);
        return { rows: [] };
      },
    };

    await expect(
      finalizeCompletedAnalysisCallback({
        db: db as never,
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          kiloSessionId: 'ses-123',
          status: 'completed',
        },
        fetchLatestAssistantText: async () => null,
        extractSandboxAnalysis: async () => {
          throw new Error('missing callback markdown must skip extraction');
        },
        sleep: async () => undefined,
      })
    ).resolves.toEqual({ status: 'result-missing' });

    expect(findingUpdates).toHaveLength(0);
    expect(queueTransitions).toHaveLength(0);
    expect(transitionAnalysisCallbackLifecycle).toHaveBeenCalledWith(db, {
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptToken: ATTEMPT_TOKEN,
      outcome: {
        type: 'failed',
        errorMessage: 'Analysis completed but callback result text was missing',
        failureCode: 'START_CALL_AMBIGUOUS',
      },
    });
  });

  it('rejects completed callbacks before extraction when no active attempt exists', async () => {
    const extractSandboxAnalysis = vi.fn();
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              limit: async () => [
                {
                  session_id: 'agent-123',
                  cli_session_id: 'ses-123',
                  ignored_reason: null,
                  analysis_status: 'running',
                },
              ],
            }),
          }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        }),
    };

    await expect(
      finalizeCompletedAnalysisCallback({
        db: db as never,
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          kiloSessionId: 'ses-123',
          status: 'completed',
          lastAssistantMessageText: '# Completed analysis',
        },
        extractSandboxAnalysis,
      })
    ).resolves.toEqual({ status: 'stale-attempt' });

    expect(extractSandboxAnalysis).not.toHaveBeenCalled();
    expect(transitionAnalysisCallbackLifecycle).not.toHaveBeenCalled();
  });
});

describe('consumeAnalysisCallbackBatch', () => {
  const callbackBody = {
    findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    attemptToken: ATTEMPT_TOKEN,
    payload: {
      sessionId: 'session-123',
      cloudAgentSessionId: 'agent-123',
      executionId: 'exec-123',
      status: 'completed' as const,
      lastAssistantMessageText: '# Completed',
    },
  };

  it('acknowledges callback messages after durable finalization succeeds', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const finalizeCallback = vi.fn().mockResolvedValue({ status: 'completed-finalized' });

    await consumeAnalysisCallbackBatch(
      { messages: [{ body: callbackBody, ack, retry }] } as never,
      {} as CloudflareEnv,
      finalizeCallback
    );

    expect(finalizeCallback).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('accepts legacy callback messages without an attempt token', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const finalizeCallback = vi.fn().mockResolvedValue({ status: 'completed-finalized' });
    const legacyBody = {
      findingId: callbackBody.findingId,
      payload: callbackBody.payload,
    };

    await consumeAnalysisCallbackBatch(
      { messages: [{ body: legacyBody, ack, retry }] } as never,
      {} as CloudflareEnv,
      finalizeCallback
    );

    expect(finalizeCallback).toHaveBeenCalledWith({
      env: {},
      findingId: callbackBody.findingId,
      attemptToken: undefined,
      payload: callbackBody.payload,
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('retries callback messages when durable finalization throws', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const finalizeCallback = vi.fn().mockRejectedValue(new Error('retry callback'));

    await consumeAnalysisCallbackBatch(
      { messages: [{ body: callbackBody, ack, retry }] } as never,
      {} as CloudflareEnv,
      finalizeCallback
    );

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('finalizeFailedAnalysisCallback', () => {
  it('delegates already-terminal failed callback retries for queue healing', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                session_id: 'agent-123',
                cli_session_id: null,
                ignored_reason: null,
                analysis_status: 'failed',
                analysis_error: 'upstream 503',
              },
            ],
          }),
        }),
      }),
    };

    await expect(
      finalizeFailedAnalysisCallback({
        db: db as never,
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptToken: ATTEMPT_TOKEN,
        payload: failedPayload,
      })
    ).resolves.toEqual({ status: 'already-terminal' });

    expect(transitionAnalysisCallbackLifecycle).toHaveBeenCalledWith(db, {
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptToken: ATTEMPT_TOKEN,
      outcome: {
        type: 'already-terminal',
        findingStatus: 'failed',
        failureCode: 'UPSTREAM_5XX',
        errorMessage: 'upstream 503',
      },
    });
  });

  it('delegates superseded failed callbacks to lifecycle settlement', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                session_id: 'agent-123',
                cli_session_id: null,
                ignored_reason: 'superseded:canonical-finding',
                analysis_status: 'running',
                claimToken: ATTEMPT_TOKEN,
              },
            ],
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      execute: async () => ({ rows: [] }),
    };

    await expect(
      finalizeFailedAnalysisCallback({
        db: db as never,
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptToken: ATTEMPT_TOKEN,
        payload: failedPayload,
      })
    ).resolves.toEqual({ status: 'superseded' });

    expect(transitionAnalysisCallbackLifecycle).toHaveBeenCalledWith(db, {
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptToken: ATTEMPT_TOKEN,
      outcome: { type: 'superseded' },
    });
  });

  it('writes terminal failed finding and queue state for retry-classified callbacks', async () => {
    const findingUpdates: unknown[] = [];
    const queueTransitions: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                session_id: 'agent-123',
                cli_session_id: null,
                ignored_reason: null,
                analysis_status: 'running',
                claimToken: ATTEMPT_TOKEN,
              },
            ],
          }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: () => ({
            returning: async () => {
              findingUpdates.push(values);
              return [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }];
            },
          }),
        }),
      }),
      execute: async (statement: unknown) => {
        queueTransitions.push(statement);
        return { rows: [] };
      },
    };

    await expect(
      finalizeFailedAnalysisCallback({
        db: db as never,
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptToken: ATTEMPT_TOKEN,
        payload: failedPayload,
      })
    ).resolves.toEqual({ status: 'failed-finalized' });
    expect(findingUpdates).toHaveLength(0);
    expect(queueTransitions).toHaveLength(0);
    expect(transitionAnalysisCallbackLifecycle).toHaveBeenCalledWith(db, {
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptToken: ATTEMPT_TOKEN,
      outcome: {
        type: 'failed',
        errorMessage: 'upstream 503',
        failureCode: 'UPSTREAM_5XX',
      },
    });
  });

  it('resolves the active claim token for legacy failed callback messages', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                session_id: 'agent-123',
                cli_session_id: null,
                ignored_reason: null,
                analysis_status: 'running',
                claimToken: ATTEMPT_TOKEN,
              },
            ],
          }),
        }),
      }),
    };

    await expect(
      finalizeFailedAnalysisCallback({
        db: db as never,
        findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        payload: failedPayload,
      })
    ).resolves.toEqual({ status: 'failed-finalized' });

    expect(transitionAnalysisCallbackLifecycle).toHaveBeenCalledWith(db, {
      findingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptToken: ATTEMPT_TOKEN,
      outcome: {
        type: 'failed',
        errorMessage: 'upstream 503',
        failureCode: 'UPSTREAM_5XX',
      },
    });
  });
});

describe('mapAnalysisCallbackFailure', () => {
  it('maps interrupted callbacks to state guard rejection', () => {
    expect(
      mapAnalysisCallbackFailure({ status: 'interrupted', errorMessage: 'cancelled' })
    ).toEqual({
      errorMessage: 'Analysis interrupted: cancelled',
      failureCode: 'STATE_GUARD_REJECTED',
    });
  });

  it('maps transient upstream failures to UPSTREAM_5XX', () => {
    expect(mapAnalysisCallbackFailure(failedPayload)).toEqual({
      errorMessage: 'upstream 503',
      failureCode: 'UPSTREAM_5XX',
    });
  });
});
