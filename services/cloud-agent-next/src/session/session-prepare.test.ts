/**
 * Ledger-guarded session creation ladder (plan P1-A-08b step 3):
 * `createSessionWithLedger` admission outcomes and the takeover /
 * reconcile-pending reconciliation ladder in `session-registration.ts`.
 *
 * The operation-ledger helpers, session-ingest path, sandbox routing, and the
 * Durable Object RPC transport are mocked so each ladder branch is exercised
 * deterministically; `startNewSession` and the reconcile ladder run real code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDb } from '@kilocode/db/client';
import type { OperationLedgerRow } from '@kilocode/db/schema';

import type { Env } from '../types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { MessageResultRPCResponse } from './message-result.js';
import type { SessionMessageAdmissionResult } from '../execution/types.js';
import type { SessionCreateRequest } from './session-requests.js';
import type * as SandboxIdModule from '../sandbox-id.js';
import type * as SharedSandboxRouteModule from '../shared-sandbox-route.js';
import {
  createSessionWithLedger,
  type SessionRegistrationContext,
} from './session-registration.js';

const {
  admitOperationMock,
  settleOperationMock,
  markReconcilePendingMock,
  recordOperationProgressMock,
  getPgDbMock,
  createCliSessionMock,
  deleteCliSessionMock,
  generateSessionIdMock,
  generateKiloSessionIdMock,
  createSessionReportMock,
  recordSandboxIdentityMock,
  recordSessionFailureMock,
  generateSandboxRoutingTargetMock,
} = vi.hoisted(() => ({
  admitOperationMock: vi.fn(),
  settleOperationMock: vi.fn().mockResolvedValue({ settled: true }),
  markReconcilePendingMock: vi.fn().mockResolvedValue({}),
  recordOperationProgressMock: vi.fn().mockResolvedValue(undefined),
  getPgDbMock: vi.fn(),
  createCliSessionMock: vi.fn().mockResolvedValue(undefined),
  deleteCliSessionMock: vi.fn().mockResolvedValue(undefined),
  generateSessionIdMock: vi.fn(),
  generateKiloSessionIdMock: vi.fn(),
  createSessionReportMock: vi.fn().mockResolvedValue(undefined),
  recordSandboxIdentityMock: vi.fn().mockResolvedValue(undefined),
  recordSessionFailureMock: vi.fn().mockResolvedValue(undefined),
  generateSandboxRoutingTargetMock: vi.fn(),
}));

vi.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: admitOperationMock,
  settleOperation: settleOperationMock,
  markReconcilePending: markReconcilePendingMock,
  recordOperationProgress: recordOperationProgressMock,
}));

vi.mock('../db/pg.js', () => ({
  getPgDb: getPgDbMock,
}));

vi.mock('../utils/do-retry.js', () => ({
  withDORetry: (getStub: () => unknown, operation: (stub: unknown) => unknown): unknown =>
    operation(getStub()),
}));

vi.mock('../session-service.js', () => ({
  generateSessionId: () => generateSessionIdMock(),
  SessionService: class SessionService {
    createCliSessionViaSessionIngest = createCliSessionMock;
    deleteCliSessionViaSessionIngest = deleteCliSessionMock;
  },
}));

vi.mock('../telemetry/session-reports.js', () => ({
  createCloudAgentSessionReport: createSessionReportMock,
  recordCloudAgentSandboxIdentity: recordSandboxIdentityMock,
  recordCloudAgentSessionFailure: recordSessionFailureMock,
}));

vi.mock('../utils/kilo-session-id.js', () => ({
  generateKiloSessionId: () => generateKiloSessionIdMock(),
}));

vi.mock('./message-id.js', () => ({
  createMessageId: () => 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
}));

vi.mock('../sandbox-id.js', async importOriginal => {
  const actual = await importOriginal<typeof SandboxIdModule>();
  return {
    ...actual,
    generateSandboxRoutingTarget: generateSandboxRoutingTargetMock,
  };
});

vi.mock('../shared-sandbox-route.js', async importOriginal => {
  const actual = await importOriginal<typeof SharedSandboxRouteModule>();
  return {
    ...actual,
    resolveSharedSandboxAssignment: vi.fn(),
  };
});

const OPERATION_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USER_ID = 'test-user-123';
const AUTH_TOKEN = 'test-auth-token';
const CLOUD_AGENT_SESSION_ID = 'agent_12345678-1234-1234-1234-123456789abc';
const KILO_SESSION_ID = 'ses_12345678901234567890123456';
const INITIAL_MESSAGE_ID = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
const ROW_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

function makeLedgerRow(overrides: Partial<OperationLedgerRow> = {}): OperationLedgerRow {
  return {
    id: ROW_ID,
    operation_key: OPERATION_KEY,
    domain: 'session',
    intent: 'create_cloud',
    kilo_user_id: USER_ID,
    organization_id: null,
    resource_key: null,
    provider_ref: null,
    taxonomy: 'safe-retry',
    status: 'admitted',
    outcome_code: null,
    canonical_result: null,
    admitted_at: '2026-08-06T00:00:00.000Z',
    settled_at: null,
    lease_expires_at: '2026-08-06T02:00:00.000Z',
    expires_at: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

/** Fake Drizzle db: `.limit(1)` returns the next queued result per query. */
function makeDb(limitResults: unknown[][]): WorkerDb {
  const limit = vi.fn(async () => limitResults.shift() ?? []);
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit })),
    })),
  }));
  return { select } as unknown as WorkerDb;
}

type DoStubOverrides = {
  createSessionWithInitialAdmission?: ReturnType<typeof vi.fn>;
  getMetadata?: ReturnType<typeof vi.fn>;
  getMessageResult?: ReturnType<typeof vi.fn>;
};

function makeDoStub(overrides: DoStubOverrides = {}) {
  return {
    createSessionWithInitialAdmission:
      overrides.createSessionWithInitialAdmission ??
      vi.fn().mockResolvedValue({
        success: true,
        outcome: 'queued',
        messageId: INITIAL_MESSAGE_ID,
        compatibilityDelivery: 'queued',
      } satisfies SessionMessageAdmissionResult),
    getMetadata:
      overrides.getMetadata ??
      vi.fn().mockResolvedValue({
        identity: { sessionId: CLOUD_AGENT_SESSION_ID },
      } as SessionMetadata),
    getMessageResult:
      overrides.getMessageResult ??
      vi.fn().mockResolvedValue({
        type: 'found',
        result: {
          messageId: INITIAL_MESSAGE_ID,
          status: 'queued',
          createdAt: 1,
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
        },
      } satisfies MessageResultRPCResponse),
  };
}

function makeEnv(doStub: ReturnType<typeof makeDoStub>): Env {
  return {
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn((name: string) => ({ toString: () => name })),
      get: vi.fn(() => doStub),
    } as unknown as Env['CLOUD_AGENT_SESSION'],
    HYPERDRIVE: {
      connectionString: 'postgres://session-create-test',
    } as Env['HYPERDRIVE'],
  } as unknown as Env;
}

function makeContext(doStub: ReturnType<typeof makeDoStub>): SessionRegistrationContext {
  return {
    env: makeEnv(doStub),
    userId: USER_ID,
    authToken: AUTH_TOKEN,
  };
}

function makeRequest(overrides: Partial<SessionCreateRequest> = {}): SessionCreateRequest {
  return {
    initialTurn: { type: 'prompt', prompt: 'Build the feature' },
    agent: { mode: 'code', model: 'claude-3' },
    repository: { type: 'github', repo: 'acme/repo' },
    ...overrides,
  };
}

type SettleOptions = { outboxEvent?: { properties?: unknown } };

/** Returns the options argument of the n-th `settleOperation` call, if any. */
function settleOptions(index: number): SettleOptions | undefined {
  const call = settleOperationMock.mock.calls[index];
  if (!call) return undefined;
  return call[1] as SettleOptions | undefined;
}

describe('createSessionWithLedger admission ladder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPgDbMock.mockReturnValue(makeDb([[{ email: 'test@example.com' }]]));
    generateSessionIdMock.mockReturnValue(CLOUD_AGENT_SESSION_ID);
    generateKiloSessionIdMock.mockReturnValue(KILO_SESSION_ID);
    generateSandboxRoutingTargetMock.mockResolvedValue({
      kind: 'isolated',
      sandboxId: 'sb-test-123',
    });
    admitOperationMock.mockResolvedValue({
      admission: 'admitted',
      row: makeLedgerRow({}),
    });
    settleOperationMock.mockResolvedValue({ settled: true });
    markReconcilePendingMock.mockResolvedValue({});
    recordOperationProgressMock.mockResolvedValue(undefined);
  });

  it('admits with the operation identity and settles completed with canonical IDs', async () => {
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await createSessionWithLedger(
      makeRequest({ options: { operationKey: OPERATION_KEY } }),
      ctx,
      { operationKey: OPERATION_KEY, startedAt: 1_700_000_000_000 }
    );

    expect(admitOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        userId: USER_ID,
        domain: 'session',
        intent: 'create_cloud',
        operationKey: OPERATION_KEY,
        taxonomy: 'safe-retry',
        leaseSeconds: 120,
      })
    );
    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledTimes(1);
    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          sessionId: CLOUD_AGENT_SESSION_ID,
          userId: USER_ID,
        }),
        workspace: expect.objectContaining({ sandboxId: 'sb-test-123' }),
        message: expect.objectContaining({
          initialTurn: expect.objectContaining({
            messageId: INITIAL_MESSAGE_ID,
            prompt: 'Build the feature',
          }),
        }),
      })
    );
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'completed',
        outcomeCode: 'ok',
        canonicalResult: {
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
          kiloSessionId: KILO_SESSION_ID,
        },
      })
    );
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      eventName: 'session_create_settled',
      distinctId: 'test@example.com',
      properties: {
        outcome: 'completed',
        admission: 'new',
        in_organization: false,
      },
    });
    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
    });
  });

  it('settles failed with the allocation stage when a pre-DO step fails', async () => {
    createSessionReportMock.mockRejectedValueOnce(new Error('report store unavailable'));
    const ctx = makeContext(makeDoStub());

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toThrow('report store unavailable');

    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'report',
      })
    );
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      properties: { outcome: 'failed', admission: 'new', failure_stage: 'report' },
    });
  });

  it('settles failed with the report stage when the progress write fails', async () => {
    recordOperationProgressMock.mockRejectedValueOnce(new Error('progress write failed'));
    const ctx = makeContext(makeDoStub());

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toThrow('progress write failed');

    expect(createSessionReportMock).not.toHaveBeenCalled();
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'report',
      })
    );
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      properties: { outcome: 'failed', admission: 'new', failure_stage: 'report' },
    });
  });

  it('settles failed with the sandbox stage when sandbox routing fails', async () => {
    generateSandboxRoutingTargetMock.mockRejectedValueOnce(new Error('routing failed'));
    const ctx = makeContext(makeDoStub());

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toThrow('routing failed');

    expect(recordSessionFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: { stage: 'sandbox_identity', code: 'sandbox_id_derivation_failed' },
      }),
      expect.any(Object)
    );
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'sandbox',
      })
    );
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      properties: { outcome: 'failed', admission: 'new', failure_stage: 'sandbox' },
    });
  });

  it('rethrows the primary sandbox error when the telemetry failure record fails', async () => {
    generateSandboxRoutingTargetMock.mockRejectedValueOnce(new Error('routing failed'));
    recordSessionFailureMock.mockRejectedValueOnce(new Error('telemetry down'));
    const ctx = makeContext(makeDoStub());

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toThrow('routing failed');

    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'sandbox',
      })
    );
  });

  it('settles failed with the sandbox stage when the sandbox identity write fails', async () => {
    recordSandboxIdentityMock.mockRejectedValueOnce(new Error('identity write failed'));
    const ctx = makeContext(makeDoStub());

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toThrow('identity write failed');

    expect(createCliSessionMock).not.toHaveBeenCalled();
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'sandbox',
      })
    );
  });

  it('settles failed with the ownership_row stage when the ownership write fails', async () => {
    createCliSessionMock.mockRejectedValueOnce(new Error('session ingest unavailable'));
    const ctx = makeContext(makeDoStub());

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toThrow('session ingest unavailable');

    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'ownership_row',
      })
    );
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      properties: { outcome: 'failed', admission: 'new', failure_stage: 'ownership_row' },
    });
  });

  it('settles failed with the registration stage when the DO explicitly rejects', async () => {
    const doStub = makeDoStub({
      createSessionWithInitialAdmission: vi.fn().mockResolvedValue({
        success: false,
        code: 'BAD_REQUEST',
        error: 'registration rejected',
        failureBoundary: 'registration',
      } satisfies SessionMessageAdmissionResult),
    });
    const ctx = makeContext(doStub);

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'registration rejected' });

    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'do_registration_rejected',
      })
    );
    expect(deleteCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      USER_ID,
      expect.any(Object),
      { onlyIfEmpty: true }
    );
    expect(recordSessionFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: { stage: 'registration', code: 'do_registration_rejected' },
      }),
      expect.any(Object)
    );
  });

  it('settles failed with the initial_admission stage when admission is rejected', async () => {
    const doStub = makeDoStub({
      createSessionWithInitialAdmission: vi.fn().mockResolvedValue({
        success: false,
        code: 'BAD_REQUEST',
        error: 'intent rejected',
        failureBoundary: 'admission',
      } satisfies SessionMessageAdmissionResult),
    });
    const ctx = makeContext(doStub);

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'invalid_initial_intent',
      })
    );
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      properties: { outcome: 'failed', admission: 'new', failure_stage: 'initial_admission' },
    });
  });

  it('marks the row reconcile-pending when the DO transport outcome is unknown', async () => {
    const doStub = makeDoStub({
      createSessionWithInitialAdmission: vi.fn().mockRejectedValue(new Error('rpc timed out')),
    });
    const ctx = makeContext(doStub);

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toThrow('rpc timed out');

    expect(markReconcilePendingMock).toHaveBeenCalledWith(expect.any(Object), {
      rowId: ROW_ID,
    });
    expect(settleOperationMock).not.toHaveBeenCalled();
    expect(recordSessionFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
      }),
      expect.any(Object)
    );
  });

  it('replays the settled create for a duplicate_settled admission', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: makeLedgerRow({
        status: 'completed',
        canonical_result: {
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
          kiloSessionId: KILO_SESSION_ID,
        },
      }),
    });
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await createSessionWithLedger(
      makeRequest({ options: { operationKey: OPERATION_KEY } }),
      ctx,
      { operationKey: OPERATION_KEY, startedAt: 1_700_000_000_000 }
    );

    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  it('rejects a settled row without canonical IDs as a non-retryable failure', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: makeLedgerRow({
        status: 'completed',
      }),
    });
    const ctx = makeContext(makeDoStub());

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'session_creation_failed' });

    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  it('never replays a successful result from a failed terminal row with progress IDs', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: makeLedgerRow({
        status: 'failed',
        outcome_code: 'report',
        canonical_result: {
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
          kiloSessionId: KILO_SESSION_ID,
          initialMessageId: INITIAL_MESSAGE_ID,
        },
      }),
    });
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'session_creation_failed' });

    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  it('returns CONFLICT creation_in_progress for a duplicate_in_flight admission', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_in_flight',
      row: makeLedgerRow({}),
    });
    const ctx = makeContext(makeDoStub());

    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'creation_in_progress' });

    expect(settleOperationMock).not.toHaveBeenCalled();
  });
});

describe('createSessionWithLedger takeover reconciliation ladder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateSessionIdMock.mockReturnValue(CLOUD_AGENT_SESSION_ID);
    generateKiloSessionIdMock.mockReturnValue(KILO_SESSION_ID);
    generateSandboxRoutingTargetMock.mockResolvedValue({
      kind: 'isolated',
      sandboxId: 'sb-test-123',
    });
    settleOperationMock.mockResolvedValue({ settled: true });
    markReconcilePendingMock.mockResolvedValue({});
    recordOperationProgressMock.mockResolvedValue(undefined);
  });

  const takeoverOptions = { operationKey: OPERATION_KEY, startedAt: 1_700_000_000_000 };
  const canonicalIds = {
    cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
    kiloSessionId: KILO_SESSION_ID,
    initialMessageId: INITIAL_MESSAGE_ID,
  };

  it('(a) runs a fresh create under the row when no progress IDs were recorded', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: null }),
    });
    getPgDbMock.mockReturnValue(makeDb([[{ email: 'test@example.com' }]]));
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await createSessionWithLedger(
      makeRequest({ options: { operationKey: OPERATION_KEY } }),
      ctx,
      takeoverOptions
    );

    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledTimes(1);
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      properties: { outcome: 'completed', admission: 'takeover' },
    });
    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
    });
  });

  it('(b) runs a fresh create when the ownership row is absent despite recorded IDs', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    // First query: ownership lookup returns no row. Second: user email.
    getPgDbMock.mockReturnValue(makeDb([[], [{ email: 'test@example.com' }]]));
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await createSessionWithLedger(
      makeRequest({ options: { operationKey: OPERATION_KEY } }),
      ctx,
      takeoverOptions
    );

    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledTimes(1);
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
    expect(settleOptions(0)?.outboxEvent).toMatchObject({ properties: { admission: 'takeover' } });
    expect(result.cloudAgentSessionId).toBe(CLOUD_AGENT_SESSION_ID);
  });

  it('(c) removes a stale ownership row without DO metadata, then creates fresh', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    // First: ownership present. Second (after delete): ownership gone. Third: user email.
    getPgDbMock.mockReturnValue(
      makeDb([[{ sessionId: KILO_SESSION_ID }], [], [{ email: 'test@example.com' }]])
    );
    const doStub = makeDoStub({
      getMetadata: vi.fn().mockResolvedValue(null),
    });
    const ctx = makeContext(doStub);

    const result = await createSessionWithLedger(
      makeRequest({ options: { operationKey: OPERATION_KEY } }),
      ctx,
      takeoverOptions
    );

    expect(deleteCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      USER_ID,
      expect.any(Object),
      { onlyIfEmpty: true }
    );
    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledTimes(1);
    expect(settleOptions(0)?.outboxEvent).toMatchObject({ properties: { admission: 'takeover' } });
    expect(result.cloudAgentSessionId).toBe(CLOUD_AGENT_SESSION_ID);
  });

  it('(c-keep) confirms the live session only after authoritative metadata and admission', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    // First: ownership present. Second (after delete): still present. Third: user email.
    getPgDbMock.mockReturnValue(
      makeDb([
        [{ sessionId: KILO_SESSION_ID }],
        [{ sessionId: KILO_SESSION_ID }],
        [{ email: 'test@example.com' }],
      ])
    );
    const doStub = makeDoStub({
      // First read: the DO has not registered yet. After the empty-only delete
      // refuses, the authoritative re-read proves registration.
      getMetadata: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          identity: { sessionId: CLOUD_AGENT_SESSION_ID },
        } as SessionMetadata),
      getMessageResult: vi.fn().mockResolvedValue({
        type: 'found',
        result: {
          messageId: INITIAL_MESSAGE_ID,
          status: 'queued',
          createdAt: 1,
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
        },
      } satisfies MessageResultRPCResponse),
    });
    const ctx = makeContext(doStub);

    const result = await createSessionWithLedger(
      makeRequest({ options: { operationKey: OPERATION_KEY } }),
      ctx,
      takeoverOptions
    );

    expect(deleteCliSessionMock).toHaveBeenCalledTimes(1);
    expect(doStub.getMetadata).toHaveBeenCalledTimes(2);
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'completed',
        outcomeCode: 'ok',
      })
    );
    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
  });

  it('(c-keep) stays reconcile-pending when the DO never registers metadata', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    // First: ownership present. Second (after delete): still present.
    getPgDbMock.mockReturnValue(
      makeDb([[{ sessionId: KILO_SESSION_ID }], [{ sessionId: KILO_SESSION_ID }]])
    );
    const doStub = makeDoStub({
      getMetadata: vi.fn().mockResolvedValue(null),
      // Contract check: without metadata the DO cannot report admission.
      getMessageResult: vi.fn().mockResolvedValue({
        type: 'session-not-found',
      } satisfies MessageResultRPCResponse),
    });
    const ctx = makeContext(doStub);

    await expect(
      createSessionWithLedger(
        makeRequest({ options: { operationKey: OPERATION_KEY } }),
        ctx,
        takeoverOptions
      )
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'creation_in_progress' });

    expect(deleteCliSessionMock).toHaveBeenCalledTimes(1);
    expect(doStub.getMessageResult).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  it('(d) settles and replays when metadata exists and the initial message is admitted', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    getPgDbMock.mockReturnValue(
      makeDb([[{ sessionId: KILO_SESSION_ID }], [{ email: 'test@example.com' }]])
    );
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await createSessionWithLedger(
      makeRequest({ options: { operationKey: OPERATION_KEY } }),
      ctx,
      takeoverOptions
    );

    expect(doStub.getMetadata).toHaveBeenCalledTimes(1);
    expect(doStub.getMessageResult).toHaveBeenCalledWith(INITIAL_MESSAGE_ID);
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ rowId: ROW_ID, status: 'completed', outcomeCode: 'ok' })
    );
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      properties: { outcome: 'completed', admission: 'takeover', in_organization: false },
    });
    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
  });

  it('returns CONFLICT when the recorded initial message is not admitted', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    getPgDbMock.mockReturnValue(makeDb([[{ sessionId: KILO_SESSION_ID }]]));
    const doStub = makeDoStub({
      getMessageResult: vi.fn().mockResolvedValue({
        type: 'message-not-found',
      } satisfies MessageResultRPCResponse),
    });
    const ctx = makeContext(doStub);

    await expect(
      createSessionWithLedger(
        makeRequest({ options: { operationKey: OPERATION_KEY } }),
        ctx,
        takeoverOptions
      )
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'creation_in_progress' });

    expect(settleOperationMock).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
  });

  it('returns CONFLICT when a recorded initialMessageId is missing from the canonical result', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({
        canonical_result: {
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
          kiloSessionId: KILO_SESSION_ID,
        },
      }),
    });
    getPgDbMock.mockReturnValue(makeDb([[{ sessionId: KILO_SESSION_ID }]]));
    const ctx = makeContext(makeDoStub());

    await expect(
      createSessionWithLedger(
        makeRequest({ options: { operationKey: OPERATION_KEY } }),
        ctx,
        takeoverOptions
      )
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'creation_in_progress' });

    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  it('reconciles a duplicate_reconcile_pending row through the same ladder', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    getPgDbMock.mockReturnValue(
      makeDb([[{ sessionId: KILO_SESSION_ID }], [{ email: 'test@example.com' }]])
    );
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await createSessionWithLedger(
      makeRequest({ options: { operationKey: OPERATION_KEY } }),
      ctx,
      takeoverOptions
    );

    expect(doStub.getMessageResult).toHaveBeenCalledWith(INITIAL_MESSAGE_ID);
    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
  });

  it('regression: fresh allocation under reconcile_pending persists IDs so the next retry reconciles instead of allocating a third session', async () => {
    // The row is already reconcile-pending from an earlier unknown-transport
    // outcome whose recorded IDs are stale (the ownership row is gone). The
    // ladder must allocate fresh IDs and record them even though the row is
    // `reconcile_pending`, not `admitted`.
    admitOperationMock
      .mockResolvedValueOnce({
        admission: 'duplicate_reconcile_pending',
        row: makeLedgerRow({
          status: 'reconcile_pending',
          canonical_result: {
            cloudAgentSessionId: 'agent_stale_a',
            kiloSessionId: 'ses_stale_a',
            initialMessageId: 'msg_stale_a',
          },
        }),
      })
      .mockResolvedValueOnce({
        admission: 'duplicate_reconcile_pending',
        row: makeLedgerRow({
          status: 'reconcile_pending',
          canonical_result: canonicalIds,
        }),
      });

    // Attempt 1: stale-A ownership lookup is absent (fresh create), then the
    // distinct-id lookup for the fresh create. Attempt 2: fresh-B ownership
    // lookup is present, then the distinct-id lookup for the settle.
    getPgDbMock.mockReturnValue(
      makeDb([
        [],
        [{ email: 'test@example.com' }],
        [{ sessionId: KILO_SESSION_ID }],
        [{ email: 'test@example.com' }],
      ])
    );

    // Unknown transport on the fresh allocation's DO call; any hypothetical
    // third allocation would hit the default stub and fail the call-count
    // assertions below.
    const doStub = makeDoStub({
      createSessionWithInitialAdmission: vi.fn().mockRejectedValueOnce(new Error('rpc timed out')),
    });
    const ctx = makeContext(doStub);

    // First retry: fresh allocation, then unknown transport.
    await expect(
      createSessionWithLedger(makeRequest({ options: { operationKey: OPERATION_KEY } }), ctx, {
        operationKey: OPERATION_KEY,
        startedAt: 1_700_000_000_000,
      })
    ).rejects.toThrow('rpc timed out');

    // The fresh allocation recorded its new IDs on the reconcile_pending row
    // and the unknown transport kept the row reconcile-pending.
    expect(recordOperationProgressMock).toHaveBeenCalledWith(expect.any(Object), ROW_ID, {
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      initialMessageId: INITIAL_MESSAGE_ID,
    });
    expect(markReconcilePendingMock).toHaveBeenCalledWith(expect.any(Object), {
      rowId: ROW_ID,
    });

    // Second retry: reconciles the freshly recorded IDs; no third allocation.
    const result = await createSessionWithLedger(
      makeRequest({ options: { operationKey: OPERATION_KEY } }),
      ctx,
      { operationKey: OPERATION_KEY, startedAt: 1_700_000_000_000 }
    );

    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledTimes(1);
    expect(doStub.getMessageResult).toHaveBeenCalledWith(INITIAL_MESSAGE_ID);
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'completed',
        outcomeCode: 'ok',
        canonicalResult: {
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
          kiloSessionId: KILO_SESSION_ID,
        },
      })
    );
    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
  });
});
