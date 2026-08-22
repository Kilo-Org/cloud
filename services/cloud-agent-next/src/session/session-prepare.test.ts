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
import type * as MessageIdModule from './message-id.js';
import {
  createSessionWithLedger,
  sessionCreateIntentFingerprint,
  SESSION_CREATE_ABANDON_AFTER_SECONDS,
  SESSION_CREATE_ABANDONED_OUTCOME_CODE,
  SESSION_CREATE_INTENT_FINGERPRINT_KEY,
  SESSION_CREATE_TOMBSTONED_IDS_KEY,
  type SessionRegistrationContext,
} from './session-registration.js';
import { prepareInputToSessionCreateRequest } from '../router/handlers/session-prepare.js';

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

vi.mock('./message-id.js', async importOriginal => {
  const actual = await importOriginal<typeof MessageIdModule>();
  return {
    ...actual,
    createMessageId: () => 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
  };
});

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
    // Freshly admitted by default: the reconcile ladder abandons a row only
    // once it is older than `SESSION_CREATE_ABANDON_AFTER_SECONDS`, and every
    // test except the abandonment one exercises the in-flight-age behavior.
    admitted_at: new Date().toISOString(),
    settled_at: null,
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
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
  registerSession?: ReturnType<typeof vi.fn>;
  createSessionWithInitialAdmission?: ReturnType<typeof vi.fn>;
  getMetadata?: ReturnType<typeof vi.fn>;
  getMessageResult?: ReturnType<typeof vi.fn>;
};

function makeDoStub(overrides: DoStubOverrides = {}) {
  return {
    registerSession: overrides.registerSession ?? vi.fn().mockResolvedValue({ success: true }),
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

const CREATE_OPTIONS = { operationKey: OPERATION_KEY, startedAt: 1_700_000_000_000 };

/** Runs the ledger-guarded create with the standard operation options. */
function runCreate(
  ctx: SessionRegistrationContext,
  request: SessionCreateRequest = makeRequest({ options: { operationKey: OPERATION_KEY } })
) {
  return createSessionWithLedger(request, ctx, CREATE_OPTIONS);
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

    const result = await runCreate(ctx);

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

  it('passes a normalized GitHub repository URL to the session-ingest create call', async () => {
    const ctx = makeContext(makeDoStub());

    await runCreate(
      ctx,
      makeRequest({
        options: { operationKey: OPERATION_KEY },
        repository: { type: 'github', repo: 'acme/widgets.git' },
      })
    );

    expect(createCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      CLOUD_AGENT_SESSION_ID,
      USER_ID,
      expect.any(Object),
      undefined,
      'cloud-agent',
      expect.any(String),
      'https://github.com/acme/widgets',
      undefined
    );
  });

  it('passes a normalized GitLab repository URL to the session-ingest create call', async () => {
    const ctx = makeContext(makeDoStub());

    await runCreate(
      ctx,
      makeRequest({
        options: { operationKey: OPERATION_KEY },
        repository: { type: 'gitlab', url: 'https://gitlab.com/acme/widgets.git' },
      })
    );

    expect(createCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      CLOUD_AGENT_SESSION_ID,
      USER_ID,
      expect.any(Object),
      undefined,
      'cloud-agent',
      expect.any(String),
      'https://gitlab.com/acme/widgets',
      undefined
    );
  });

  it('passes a normalized Bitbucket repository URL to the session-ingest create call', async () => {
    const ctx = makeContext(makeDoStub());

    await runCreate(
      ctx,
      makeRequest({
        options: { operationKey: OPERATION_KEY },
        repository: {
          type: 'bitbucket',
          url: 'https://bitbucket.org/acme/widgets.git',
          workspaceUuid: 'workspace-1',
          repositoryUuid: 'repo-1',
        },
      })
    );

    expect(createCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      CLOUD_AGENT_SESSION_ID,
      USER_ID,
      expect.any(Object),
      undefined,
      'cloud-agent',
      expect.any(String),
      'https://bitbucket.org/acme/widgets',
      undefined
    );
  });

  it('settles failed with the allocation stage when a pre-DO step fails', async () => {
    createSessionReportMock.mockRejectedValueOnce(new Error('report store unavailable'));
    const ctx = makeContext(makeDoStub());

    await expect(runCreate(ctx)).rejects.toThrow('report store unavailable');

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

    await expect(runCreate(ctx)).rejects.toThrow('progress write failed');

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

    await expect(runCreate(ctx)).rejects.toThrow('routing failed');

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

    await expect(runCreate(ctx)).rejects.toThrow('routing failed');

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

    await expect(runCreate(ctx)).rejects.toThrow('identity write failed');

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

    await expect(runCreate(ctx)).rejects.toThrow('session ingest unavailable');

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

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'registration rejected',
    });

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

    await expect(runCreate(ctx)).rejects.toMatchObject({ code: 'BAD_REQUEST' });

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

    await expect(runCreate(ctx)).rejects.toThrow('rpc timed out');

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

  it('surfaces a typed retryable internal error when the completed settle fails after a successful DO registration', async () => {
    // The DO registered the session and admitted the initial turn, but the
    // terminal ledger settle failed. The create must NOT return success while
    // the row stays non-terminal: it surfaces a typed retryable internal error
    // and the recorded canonical IDs let the next same-key retry reconcile.
    settleOperationMock.mockRejectedValueOnce(new Error('ledger db unavailable'));
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'session_creation_settle_failed',
      cause: expect.objectContaining({
        error: 'SESSION_CREATE_SETTLE_FAILED',
        retryable: true,
      }),
    });

    // The create effect ran; the failure is the terminal settle, not the DO.
    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledTimes(1);
    // Canonical IDs were recorded before the DO call, so the next same-key
    // retry reconciles them instead of allocating a second session. The create
    // intent fingerprint travels with the same write so a changed same-key
    // intent is rejected before any replay or reconciliation.
    expect(recordOperationProgressMock).toHaveBeenCalledWith(expect.any(Object), ROW_ID, {
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      initialMessageId: INITIAL_MESSAGE_ID,
      createIntentFingerprint: expect.any(String),
    });
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

    const result = await runCreate(ctx);

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

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'session_creation_failed',
    });

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

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'session_creation_failed',
    });

    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  it('returns CONFLICT creation_in_progress for a duplicate_in_flight admission', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_in_flight',
      row: makeLedgerRow({}),
    });
    const ctx = makeContext(makeDoStub());

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'creation_in_progress',
    });

    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  it('returns CONFLICT creation_in_progress when another retry holds the reconciliation lease', async () => {
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_in_progress',
      row: makeLedgerRow({ status: 'reconcile_pending' }),
    });
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'creation_in_progress',
    });

    // The in-progress retry must not run the effect, reconcile, or settle.
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(doStub.getMetadata).not.toHaveBeenCalled();
    expect(doStub.getMessageResult).not.toHaveBeenCalled();
    expect(settleOperationMock).not.toHaveBeenCalled();
    expect(markReconcilePendingMock).not.toHaveBeenCalled();
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

    const result = await runCreate(ctx);

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

    const result = await runCreate(ctx);

    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledTimes(1);
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
    expect(settleOptions(0)?.outboxEvent).toMatchObject({ properties: { admission: 'takeover' } });
    expect(result.cloudAgentSessionId).toBe(CLOUD_AGENT_SESSION_ID);
  });

  it('(c) regression: two absent metadata reads never delete the ownership row or allocate fresh IDs', async () => {
    // Two absent metadata reads do NOT fence a later DO registration: the
    // original create RPC may still be in flight and commit registration plus
    // the initial admission after these reads. Deleting the ownership row and
    // allocating fresh IDs would then double-admit the initial turn, so the
    // ladder must preserve the row and surface `creation_in_progress` instead.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    // Only the ownership lookup runs; the conservative path writes nothing.
    getPgDbMock.mockReturnValue(makeDb([[{ sessionId: KILO_SESSION_ID }]]));
    const doStub = makeDoStub({
      getMetadata: vi.fn().mockResolvedValue(null),
    });
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'creation_in_progress',
    });

    // Both reads ran, then the ladder stopped: no delete, no fresh create, no settle.
    expect(doStub.getMetadata).toHaveBeenCalledTimes(2);
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  it('(c) reconciles and replays when the authoritative second read proves registration, without deleting the ownership row', async () => {
    // The first metadata read was absent, but the authoritative second read
    // (performed BEFORE any stale-row cleanup) proves the DO DID register. The
    // ladder must reconcile initial admission and settle/replay WITHOUT
    // deleting the ownership row: deleting a registered row would orphan a
    // live session and a fresh create would double-admit the initial turn.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    // First: ownership present. Second: user email for the settle.
    getPgDbMock.mockReturnValue(
      makeDb([[{ sessionId: KILO_SESSION_ID }], [{ email: 'test@example.com' }]])
    );
    const doStub = makeDoStub({
      getMetadata: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          identity: { sessionId: CLOUD_AGENT_SESSION_ID },
        } as SessionMetadata),
    });
    const ctx = makeContext(doStub);

    const result = await runCreate(ctx);

    expect(deleteCliSessionMock).not.toHaveBeenCalled();
    expect(doStub.getMetadata).toHaveBeenCalledTimes(2);
    expect(doStub.getMessageResult).toHaveBeenCalledWith(INITIAL_MESSAGE_ID);
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'completed',
        outcomeCode: 'ok',
      })
    );
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      properties: { outcome: 'completed', admission: 'takeover' },
    });
    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
  });

  it('(c) stays in-progress without deleting when the second read proves registration but the recorded message is not admitted', async () => {
    // The second read proves the DO registered, so the ownership row is NOT
    // deleted; reconcile initial admission conservatively and stay in-progress
    // when the recorded initial message is not admitted yet.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    getPgDbMock.mockReturnValue(makeDb([[{ sessionId: KILO_SESSION_ID }]]));
    const doStub = makeDoStub({
      getMetadata: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          identity: { sessionId: CLOUD_AGENT_SESSION_ID },
        } as SessionMetadata),
      getMessageResult: vi.fn().mockResolvedValue({
        type: 'message-not-found',
      } satisfies MessageResultRPCResponse),
    });
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'creation_in_progress',
    });

    expect(deleteCliSessionMock).not.toHaveBeenCalled();
    expect(doStub.getMetadata).toHaveBeenCalledTimes(2);
    expect(doStub.getMessageResult).toHaveBeenCalledWith(INITIAL_MESSAGE_ID);
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  it('(c-keep) stays in-progress and preserves the ownership row when both metadata reads are absent', async () => {
    // Both metadata reads are absent, so admission cannot prove a live session
    // and a later DO registration is still possible. The ladder must NOT even
    // attempt the empty-only ownership delete: it stays in-progress and leaves
    // the ownership row and the ledger row untouched.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    // Only the ownership lookup runs; the conservative path writes nothing.
    getPgDbMock.mockReturnValue(makeDb([[{ sessionId: KILO_SESSION_ID }]]));
    const doStub = makeDoStub({
      getMetadata: vi.fn().mockResolvedValue(null),
      // Contract check: without metadata the DO cannot report admission.
      getMessageResult: vi.fn().mockResolvedValue({
        type: 'session-not-found',
      } satisfies MessageResultRPCResponse),
    });
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'creation_in_progress',
    });

    expect(doStub.getMetadata).toHaveBeenCalledTimes(2);
    // The empty-only delete is no longer attempted from absent reads alone.
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
    expect(doStub.getMessageResult).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  it('(c-keep) keeps conflicting while the row is younger than the abandonment age', async () => {
    // Just under the threshold: the create RPC can still be in flight, so the
    // row stays non-terminal and the client keeps its operation key.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({
        canonical_result: canonicalIds,
        admitted_at: new Date(
          Date.now() - (SESSION_CREATE_ABANDON_AFTER_SECONDS - 60) * 1000
        ).toISOString(),
      }),
    });
    getPgDbMock.mockReturnValue(makeDb([[{ sessionId: KILO_SESSION_ID }]]));
    const doStub = makeDoStub({ getMetadata: vi.fn().mockResolvedValue(null) });
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'creation_in_progress',
    });

    expect(doStub.getMetadata).toHaveBeenCalledTimes(2);
    expect(settleOperationMock).not.toHaveBeenCalled();
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
  });

  it('(c-abandon) settles failed and returns the terminal error once the row outlives the abandonment age', async () => {
    // Past the threshold the original create RPC cannot still be in flight, so
    // the row is definitively lost. It settles `failed` with the abandonment
    // outcome code and the client receives the typed non-retryable failure, so
    // it rotates its operation key instead of conflicting forever.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({
        canonical_result: canonicalIds,
        admitted_at: new Date(
          Date.now() - (SESSION_CREATE_ABANDON_AFTER_SECONDS + 60) * 1000
        ).toISOString(),
      }),
    });
    // First: ownership present. Second: user email for the settle.
    getPgDbMock.mockReturnValue(
      makeDb([[{ sessionId: KILO_SESSION_ID }], [{ email: 'test@example.com' }]])
    );
    const doStub = makeDoStub({ getMetadata: vi.fn().mockResolvedValue(null) });
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'session_creation_failed',
    });

    expect(doStub.getMetadata).toHaveBeenCalledTimes(2);
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: SESSION_CREATE_ABANDONED_OUTCOME_CODE,
      })
    );
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      properties: { outcome: 'failed', admission: 'takeover', failure_stage: 'registration' },
    });
    // Double-execution protection stays intact: no ownership delete, no fresh create.
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
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

    const result = await runCreate(ctx);

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

  it('(d) settles failed and surfaces session_creation_failed when the found initial message status is failed', async () => {
    // The initial message was admitted but ended in a terminal failure. The
    // ladder must settle the row as a terminal failure and surface the typed
    // non-retryable error; a completed replay would report success against a
    // dead session and a later fresh create would double-admit the turn.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    // First: ownership present. Second: user email for the failure settle.
    getPgDbMock.mockReturnValue(
      makeDb([[{ sessionId: KILO_SESSION_ID }], [{ email: 'test@example.com' }]])
    );
    const doStub = makeDoStub({
      getMessageResult: vi.fn().mockResolvedValue({
        type: 'found',
        result: {
          messageId: INITIAL_MESSAGE_ID,
          status: 'failed',
          createdAt: 1,
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
        },
      } satisfies MessageResultRPCResponse),
    });
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'session_creation_failed',
    });

    expect(doStub.getMessageResult).toHaveBeenCalledWith(INITIAL_MESSAGE_ID);
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'initial_admission_rejected',
      })
    );
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      eventName: 'session_create_settled',
      distinctId: 'test@example.com',
      properties: {
        outcome: 'failed',
        admission: 'takeover',
        failure_stage: 'initial_admission',
      },
    });
  });

  it('(d) settles failed and surfaces session_creation_failed when the found initial message status is interrupted', async () => {
    // An interrupted initial message is the same terminal-failure contract:
    // never settle the create as completed and never replay success.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    // First: ownership present. Second: user email for the failure settle.
    getPgDbMock.mockReturnValue(
      makeDb([[{ sessionId: KILO_SESSION_ID }], [{ email: 'test@example.com' }]])
    );
    const doStub = makeDoStub({
      getMessageResult: vi.fn().mockResolvedValue({
        type: 'found',
        result: {
          messageId: INITIAL_MESSAGE_ID,
          status: 'interrupted',
          createdAt: 1,
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
        },
      } satisfies MessageResultRPCResponse),
    });
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'session_creation_failed',
    });

    expect(doStub.getMessageResult).toHaveBeenCalledWith(INITIAL_MESSAGE_ID);
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'initial_admission_rejected',
      })
    );
    expect(settleOptions(0)?.outboxEvent).toMatchObject({
      eventName: 'session_create_settled',
      distinctId: 'test@example.com',
      properties: {
        outcome: 'failed',
        admission: 'takeover',
        failure_stage: 'initial_admission',
      },
    });
  });

  it('(d) surfaces a typed retryable internal error instead of session_creation_failed when the terminal failure settle fails', async () => {
    // The initial message ended in a terminal failure, but the ledger DB is
    // down so the failed settle cannot be made durable. The ladder must NOT
    // swallow the failed settle and report the non-retryable
    // `session_creation_failed`: the row would stay non-terminal while the
    // client clears the key. It surfaces the typed retryable internal error
    // and the same-key retry reconciles the same failed message again.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    // First: ownership present. Second: user email for the failure settle.
    getPgDbMock.mockReturnValue(
      makeDb([[{ sessionId: KILO_SESSION_ID }], [{ email: 'test@example.com' }]])
    );
    const doStub = makeDoStub({
      getMessageResult: vi.fn().mockResolvedValue({
        type: 'found',
        result: {
          messageId: INITIAL_MESSAGE_ID,
          status: 'failed',
          createdAt: 1,
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
        },
      } satisfies MessageResultRPCResponse),
    });
    const ctx = makeContext(doStub);
    settleOperationMock.mockRejectedValueOnce(new Error('ledger db unavailable'));

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'session_creation_settle_failed',
      cause: expect.objectContaining({
        error: 'SESSION_CREATE_SETTLE_FAILED',
        retryable: true,
      }),
    });

    // The failed terminal settle was attempted and its rejection surfaced as
    // the retryable error: the operation row is never falsely terminalized and
    // no fresh create or completed replay ran.
    expect(doStub.getMessageResult).toHaveBeenCalledWith(INITIAL_MESSAGE_ID);
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'initial_admission_rejected',
      })
    );
  });

  it('surfaces a typed retryable internal error instead of replaying when the reconcile settle fails', async () => {
    // The authoritative reconcile proved the session live and the initial
    // message admitted, but the terminal ledger settle failed. The retry must
    // NOT replay success while the row stays non-terminal: it surfaces the
    // typed retryable internal error, and the row keeps its canonical IDs for
    // the next reconcile.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: makeLedgerRow({ canonical_result: canonicalIds }),
    });
    getPgDbMock.mockReturnValue(
      makeDb([[{ sessionId: KILO_SESSION_ID }], [{ email: 'test@example.com' }]])
    );
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);
    settleOperationMock.mockRejectedValueOnce(new Error('ledger db unavailable'));

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'session_creation_settle_failed',
      cause: expect.objectContaining({
        error: 'SESSION_CREATE_SETTLE_FAILED',
        retryable: true,
      }),
    });

    // The reconcile read the DO state and attempted the completed settle, but
    // the create effect was never re-run.
    expect(doStub.getMetadata).toHaveBeenCalledTimes(1);
    expect(doStub.getMessageResult).toHaveBeenCalledWith(INITIAL_MESSAGE_ID);
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ rowId: ROW_ID, status: 'completed', outcomeCode: 'ok' })
    );
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

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'creation_in_progress',
    });

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

    await expect(runCreate(ctx)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'creation_in_progress',
    });

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

    const result = await runCreate(ctx);

    expect(doStub.getMessageResult).toHaveBeenCalledWith(INITIAL_MESSAGE_ID);
    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
  });

  it('regression: concurrent reconcile retries run the effect once and report creation_in_progress to the rest', async () => {
    // The first retry atomically claimed the reconciliation lease and may
    // reconcile; every concurrent retry sees the live lease and must not.
    admitOperationMock
      .mockResolvedValueOnce({
        admission: 'duplicate_reconcile_pending',
        row: makeLedgerRow({ canonical_result: canonicalIds }),
      })
      .mockResolvedValue({
        admission: 'duplicate_reconcile_in_progress',
        row: makeLedgerRow({ status: 'reconcile_pending' }),
      });
    // Claim winner: ownership lookup, then the distinct-id lookup for the settle.
    getPgDbMock.mockReturnValue(
      makeDb([[{ sessionId: KILO_SESSION_ID }], [{ email: 'test@example.com' }]])
    );
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const [winner, loser] = await Promise.all([
      runCreate(ctx),
      runCreate(ctx).then(
        () => null,
        (error: unknown) => error
      ),
    ]);

    expect(winner).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
    expect(loser).toMatchObject({ code: 'CONFLICT', message: 'creation_in_progress' });
    // Exactly one retry reconciled: the ladder read the DO state once.
    expect(doStub.getMessageResult).toHaveBeenCalledTimes(1);
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).toHaveBeenCalledTimes(1);
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
    await expect(runCreate(ctx)).rejects.toThrow('rpc timed out');

    // The fresh allocation recorded its new IDs on the reconcile_pending row
    // and the unknown transport kept the row reconcile-pending.
    expect(recordOperationProgressMock).toHaveBeenCalledWith(expect.any(Object), ROW_ID, {
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      initialMessageId: INITIAL_MESSAGE_ID,
      createIntentFingerprint: expect.any(String),
    });
    expect(markReconcilePendingMock).toHaveBeenCalledWith(expect.any(Object), {
      rowId: ROW_ID,
    });

    // Second retry: reconciles the freshly recorded IDs; no third allocation.
    const result = await runCreate(ctx);

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

describe('createSessionWithLedger changed-intent rejection', () => {
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

  const ORIGINAL_OPTIONS = {
    operationKey: OPERATION_KEY,
    kilocodeOrganizationId: 'org-abc',
  };

  function originalRequest(): SessionCreateRequest {
    return makeRequest({
      initialTurn: { type: 'prompt', prompt: 'Build the feature' },
      options: ORIGINAL_OPTIONS,
    });
  }

  /** Completed ledger row whose canonical result holds the request's intent fingerprint. */
  async function completedRowFor(request: SessionCreateRequest): Promise<OperationLedgerRow> {
    return makeLedgerRow({
      status: 'completed',
      canonical_result: {
        cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
        kiloSessionId: KILO_SESSION_ID,
        initialMessageId: INITIAL_MESSAGE_ID,
        [SESSION_CREATE_INTENT_FINGERPRINT_KEY]: await sessionCreateIntentFingerprint(request),
      },
    });
  }

  /** Asserts the request is rejected with the typed error and no effect runs. */
  async function expectRejectedWithoutEffects(request: SessionCreateRequest) {
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx, request)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'session_creation_failed',
    });

    // Rejected before replay, reconciliation, or any external effect.
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(doStub.getMetadata).not.toHaveBeenCalled();
    expect(doStub.getMessageResult).not.toHaveBeenCalled();
    expect(settleOperationMock).not.toHaveBeenCalled();
    expect(recordOperationProgressMock).not.toHaveBeenCalled();
  }

  it('records the create intent fingerprint with the first admitted create progress', async () => {
    const request = originalRequest();
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await runCreate(ctx, request);

    expect(recordOperationProgressMock).toHaveBeenCalledWith(expect.any(Object), ROW_ID, {
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      initialMessageId: INITIAL_MESSAGE_ID,
      createIntentFingerprint: await sessionCreateIntentFingerprint(request),
    });
    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
    });
  });

  it('replays a settled row when the retry intent matches the stored fingerprint', async () => {
    const request = originalRequest();
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: await completedRowFor(request),
    });
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await runCreate(ctx, request);

    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  /**
   * One case per create input covered by the intent fingerprint. Each case
   * changes exactly one input on the retry; every one must reject before any
   * replay, reconciliation, or external effect.
   */
  const changedIntentCases: Array<{
    name: string;
    admission?: 'duplicate_settled' | 'takeover' | 'duplicate_reconcile_pending';
    original?: SessionCreateRequest;
    retry: SessionCreateRequest;
  }> = [
    {
      name: 'the prompt',
      retry: makeRequest({
        initialTurn: { type: 'prompt', prompt: 'Build something else entirely' },
        options: ORIGINAL_OPTIONS,
      }),
    },
    {
      name: 'the repository',
      retry: makeRequest({
        repository: { type: 'github', repo: 'acme/other-repo' },
        options: ORIGINAL_OPTIONS,
      }),
    },
    {
      name: 'the model',
      retry: makeRequest({ agent: { mode: 'code', model: 'gpt-4' }, options: ORIGINAL_OPTIONS }),
    },
    {
      name: 'the organization',
      retry: makeRequest({
        options: { operationKey: OPERATION_KEY, kilocodeOrganizationId: 'org-xyz' },
      }),
    },
    {
      name: 'the agent mode',
      retry: makeRequest({
        agent: { mode: 'architect', model: 'claude-3' },
        options: ORIGINAL_OPTIONS,
      }),
    },
    {
      name: 'the finalization policy',
      retry: makeRequest({ finalization: { autoCommit: true }, options: ORIGINAL_OPTIONS }),
    },
    {
      name: 'the appended system prompt',
      retry: makeRequest({
        profile: { overrides: { appendSystemPrompt: 'Follow these extra rules' } },
        options: ORIGINAL_OPTIONS,
      }),
    },
    {
      name: 'resolved profile setup commands',
      retry: makeRequest({
        profile: { resolved: { setupCommands: ['pnpm install'] } },
        options: ORIGINAL_OPTIONS,
      }),
    },
    {
      name: 'a resolved runtime agent',
      retry: makeRequest({
        profile: {
          resolved: {
            runtimeAgents: [
              {
                slug: 'reviewer',
                name: 'Reviewer',
                config: { prompt: 'Review the diff', mode: 'subagent' },
              },
            ],
          },
        },
        options: ORIGINAL_OPTIONS,
      }),
    },
    {
      // MCP `environment`/`headers` are credential-only and excluded, but the
      // server selection itself is create behavior.
      name: 'an MCP server url',
      original: makeRequest({
        profile: {
          resolved: {
            mcpServers: {
              github: { type: 'remote', url: 'https://mcp.example.com/github', enabled: true },
            },
          },
        },
        options: ORIGINAL_OPTIONS,
      }),
      retry: makeRequest({
        profile: {
          resolved: {
            mcpServers: {
              github: { type: 'remote', url: 'https://mcp.example.com/github-v2', enabled: true },
            },
          },
        },
        options: ORIGINAL_OPTIONS,
      }),
    },
    {
      // The remote MCP `timeout` is materialized into KILO_CONFIG_CONTENT.mcp,
      // so a timeout-only change is a changed create intent.
      name: 'an MCP server timeout',
      original: makeRequest({
        profile: {
          resolved: {
            mcpServers: {
              github: { type: 'remote', url: 'https://mcp.example.com/github', timeout: 30_000 },
            },
          },
        },
        options: ORIGINAL_OPTIONS,
      }),
      retry: makeRequest({
        profile: {
          resolved: {
            mcpServers: {
              github: { type: 'remote', url: 'https://mcp.example.com/github', timeout: 60_000 },
            },
          },
        },
        options: ORIGINAL_OPTIONS,
      }),
    },
    {
      name: 'finalization on a takeover reconcile',
      admission: 'takeover',
      retry: makeRequest({
        finalization: { condenseOnComplete: true },
        options: ORIGINAL_OPTIONS,
      }),
    },
    {
      name: 'the prompt on a takeover reconcile',
      admission: 'takeover',
      retry: makeRequest({
        initialTurn: { type: 'prompt', prompt: 'A different prompt' },
        options: ORIGINAL_OPTIONS,
      }),
    },
    {
      name: 'the repository on a reconcile-pending retry',
      admission: 'duplicate_reconcile_pending',
      retry: makeRequest({
        repository: { type: 'github', repo: 'acme/changed-repo' },
        options: ORIGINAL_OPTIONS,
      }),
    },
    {
      // The clone source is immutable create input: a same-key retry that
      // points at a different source must never inherit the prior clone.
      name: 'the clone source',
      original: makeRequest({
        clone: { cloneFromKiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
        options: ORIGINAL_OPTIONS,
      }),
      retry: makeRequest({
        clone: { cloneFromKiloSessionId: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb' },
        options: ORIGINAL_OPTIONS,
      }),
    },
  ];

  it.each(changedIntentCases)(
    'rejects a same-key retry that changes $name',
    async ({ admission = 'duplicate_settled', original, retry }) => {
      const status =
        admission === 'duplicate_settled'
          ? 'completed'
          : admission === 'duplicate_reconcile_pending'
            ? 'reconcile_pending'
            : 'admitted';
      admitOperationMock.mockResolvedValueOnce({
        admission,
        row: makeLedgerRow({
          status,
          canonical_result: {
            cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
            kiloSessionId: KILO_SESSION_ID,
            initialMessageId: INITIAL_MESSAGE_ID,
            [SESSION_CREATE_INTENT_FINGERPRINT_KEY]: await sessionCreateIntentFingerprint(
              original ?? originalRequest()
            ),
          },
        }),
      });
      await expectRejectedWithoutEffects(retry);
    }
  );

  it('replays when only credential-only profile material changed between retries', async () => {
    // Rotated envVars, encrypted secrets, and MCP environment/header secrets
    // are credential-only fields excluded from the intent fingerprint: the
    // same-key retry must replay the prior session instead of rejecting.
    const original = makeRequest({
      profile: {
        id: 'prof-1',
        resolved: {
          envVars: { ORIGINAL_TOKEN: 'old-value' },
          encryptedSecrets: {
            API_KEY: {
              encryptedData: 'abc',
              encryptedDEK: 'def',
              algorithm: 'rsa-aes-256-gcm',
              version: 1,
            },
          },
          mcpServers: {
            github: {
              type: 'remote',
              url: 'https://mcp.example.com/github',
              headers: { Authorization: 'Bearer old-secret' },
            },
          },
        },
      },
      options: ORIGINAL_OPTIONS,
    });
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: await completedRowFor(original),
    });
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await runCreate(
      ctx,
      makeRequest({
        profile: {
          id: 'prof-1',
          resolved: {
            envVars: { ROTATED_TOKEN: 'new-value' },
            encryptedSecrets: {
              API_KEY: {
                encryptedData: 'zzz',
                encryptedDEK: 'yyy',
                algorithm: 'rsa-aes-256-gcm',
                version: 1,
              },
            },
            mcpServers: {
              github: {
                type: 'remote',
                url: 'https://mcp.example.com/github',
                headers: { Authorization: 'Bearer new-secret' },
              },
            },
          },
        },
        options: ORIGINAL_OPTIONS,
      })
    );

    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(settleOperationMock).not.toHaveBeenCalled();
  });

  it('keeps the legacy replay behavior for rows recorded without an intent fingerprint', async () => {
    // Rows admitted before the fingerprint contract carry no comparison data:
    // the same-key retry keeps the current replay behavior.
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

    const result = await runCreate(ctx, makeRequest({ options: ORIGINAL_OPTIONS }));

    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
  });
});

describe('createSessionWithLedger clone allocation outcomes', () => {
  const SOURCE_KILO_SESSION_ID = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';

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
    createCliSessionMock.mockResolvedValue(undefined);
  });

  function cloneRequest(): SessionCreateRequest {
    return makeRequest({
      initialTurn: undefined,
      clone: { cloneFromKiloSessionId: SOURCE_KILO_SESSION_ID },
      options: { operationKey: OPERATION_KEY },
    });
  }

  it('forwards the clone source into the ingest call and continues on ready', async () => {
    createCliSessionMock.mockResolvedValue({
      status: 'ready',
      clone: { sessionId: KILO_SESSION_ID, copiedItemCount: 3 },
    });
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await runCreate(ctx, cloneRequest());

    expect(createCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      CLOUD_AGENT_SESSION_ID,
      USER_ID,
      expect.any(Object),
      undefined,
      'cloud-agent',
      expect.any(String),
      'https://github.com/acme/repo',
      SOURCE_KILO_SESSION_ID
    );
    expect(doStub.registerSession).toHaveBeenCalledTimes(1);
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ rowId: ROW_ID, status: 'completed', outcomeCode: 'ok' })
    );
    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
    });
  });

  it('surfaces BAD_REQUEST session_clone_failed when the clone is rejected', async () => {
    createCliSessionMock.mockResolvedValue({ status: 'rejected', code: 'source_access_denied' });
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx, cloneRequest())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'source_access_denied',
    });

    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'failed',
        outcomeCode: 'session_clone_failed',
      })
    );
    expect(markReconcilePendingMock).not.toHaveBeenCalled();
    expect(doStub.registerSession).not.toHaveBeenCalled();
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
  });

  it('surfaces SERVICE_UNAVAILABLE session_clone_unavailable when the ingest sends no acknowledgement', async () => {
    createCliSessionMock.mockResolvedValue(undefined);
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx, cloneRequest())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'session_clone_unavailable',
    });

    expect(markReconcilePendingMock).toHaveBeenCalledWith(expect.any(Object), { rowId: ROW_ID });
    expect(settleOperationMock).not.toHaveBeenCalled();
    expect(doStub.registerSession).not.toHaveBeenCalled();
    expect(deleteCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      USER_ID,
      expect.any(Object),
      { onlyIfEmpty: true }
    );
  });

  it('surfaces CONFLICT creation_in_progress when the clone is in progress', async () => {
    createCliSessionMock.mockResolvedValue({ status: 'in_progress' });
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx, cloneRequest())).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'creation_in_progress',
    });

    expect(markReconcilePendingMock).toHaveBeenCalledWith(expect.any(Object), { rowId: ROW_ID });
    expect(settleOperationMock).not.toHaveBeenCalled();
    expect(doStub.registerSession).not.toHaveBeenCalled();
  });

  it('routes a thrown clone ingest outcome through reconcile-pending and rethrows the raw error', async () => {
    createCliSessionMock.mockRejectedValue(new Error('session ingest unavailable'));
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx, cloneRequest())).rejects.toThrow('session ingest unavailable');

    expect(markReconcilePendingMock).toHaveBeenCalledWith(expect.any(Object), { rowId: ROW_ID });
    expect(settleOperationMock).not.toHaveBeenCalled();
    expect(recordSessionFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
      }),
      expect.any(Object)
    );
    expect(doStub.registerSession).not.toHaveBeenCalled();
  });

  it('keeps onlyIfEmpty rollback and no clone forwarding for a non-clone create', async () => {
    const doStub = makeDoStub({
      createSessionWithInitialAdmission: vi.fn().mockResolvedValue({
        success: false,
        code: 'BAD_REQUEST',
        error: 'registration rejected',
        failureBoundary: 'registration',
      } satisfies SessionMessageAdmissionResult),
    });
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx)).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(createCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      CLOUD_AGENT_SESSION_ID,
      USER_ID,
      expect.any(Object),
      undefined,
      'cloud-agent',
      expect.any(String),
      'https://github.com/acme/repo',
      undefined
    );
    expect(deleteCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      USER_ID,
      expect.any(Object),
      { onlyIfEmpty: true }
    );
  });

  it('rolls back a clone with a matching-source delete when the DO rejects registration', async () => {
    createCliSessionMock.mockResolvedValue({
      status: 'ready',
      clone: { sessionId: KILO_SESSION_ID, copiedItemCount: 1 },
    });
    const doStub = makeDoStub({
      registerSession: vi.fn().mockResolvedValue({
        success: false,
        error: 'registration rejected',
      }),
    });
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx, cloneRequest())).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'registration rejected',
    });

    expect(deleteCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      USER_ID,
      expect.any(Object),
      { cloneSourceSessionId: SOURCE_KILO_SESSION_ID }
    );
  });

  it('records sandbox allocation fields in ledger progress before the ingest call', async () => {
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    await runCreate(ctx);

    expect(recordOperationProgressMock).toHaveBeenCalledTimes(2);
    expect(recordOperationProgressMock).toHaveBeenNthCalledWith(2, expect.any(Object), ROW_ID, {
      sandboxId: 'sb-test-123',
      sandboxProvider: 'cloudflare',
    });
  });

  it('records a none initial-turn fingerprint and no initialMessageId for a clone-only create', async () => {
    createCliSessionMock.mockResolvedValue({
      status: 'ready',
      clone: { sessionId: KILO_SESSION_ID, copiedItemCount: 1 },
    });
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    await runCreate(ctx, cloneRequest());

    expect(recordOperationProgressMock).toHaveBeenNthCalledWith(1, expect.any(Object), ROW_ID, {
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      createIntentFingerprint: await sessionCreateIntentFingerprint(cloneRequest()),
    });
    // A clone-only create has no synthetic initial turn, so no initialMessageId
    // is recorded and the fingerprint differs from a prompt create.
    expect(recordOperationProgressMock.mock.calls[0]?.[2]).not.toHaveProperty('initialMessageId');
    expect(await sessionCreateIntentFingerprint(cloneRequest())).not.toBe(
      await sessionCreateIntentFingerprint(
        makeRequest({ options: { operationKey: OPERATION_KEY } })
      )
    );
  });
});

describe('createSessionWithLedger clone reconciliation', () => {
  const SOURCE_KILO_SESSION_ID = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
  const STORED_MESSAGE_ID = 'msg_stored_original_0123456789ab';

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
    createCliSessionMock.mockResolvedValue(undefined);
  });

  function cloneRequest(overrides: Partial<SessionCreateRequest> = {}): SessionCreateRequest {
    return makeRequest({
      initialTurn: undefined,
      clone: { cloneFromKiloSessionId: SOURCE_KILO_SESSION_ID },
      options: { operationKey: OPERATION_KEY },
      ...overrides,
    });
  }

  /** Reconcile-pending clone row whose progress holds the stored destination IDs. */
  async function cloneRow(
    overrides: Record<string, unknown> = {},
    request: SessionCreateRequest = cloneRequest()
  ): Promise<OperationLedgerRow> {
    return makeLedgerRow({
      canonical_result: {
        cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
        kiloSessionId: KILO_SESSION_ID,
        sandboxId: 'sb-test-123',
        sandboxProvider: 'cloudflare',
        [SESSION_CREATE_INTENT_FINGERPRINT_KEY]: await sessionCreateIntentFingerprint(request),
        ...overrides,
      },
    });
  }

  it('resumes a clone with the stored IDs when the ownership row is absent', async () => {
    const request = cloneRequest();
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: await cloneRow(),
    });
    createCliSessionMock.mockResolvedValue({
      status: 'ready',
      clone: { sessionId: KILO_SESSION_ID, copiedItemCount: 3 },
    });
    // First query: ownership absent. Second: distinct-id email.
    getPgDbMock.mockReturnValue(makeDb([[], [{ email: 'test@example.com' }]]));
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await runCreate(ctx, request);

    expect(createCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      CLOUD_AGENT_SESSION_ID,
      USER_ID,
      expect.any(Object),
      undefined,
      'cloud-agent',
      expect.any(String),
      'https://github.com/acme/repo',
      SOURCE_KILO_SESSION_ID
    );
    expect(doStub.registerSession).toHaveBeenCalledTimes(1);
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

  it('keeps a clone unknown outcome reconcile-pending and resumes the stored IDs on a same-key retry', async () => {
    const request = cloneRequest();
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    // Attempt 1: fresh clone create whose ingest transport outcome is unknown.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'admitted',
      row: makeLedgerRow({}),
    });
    createCliSessionMock.mockRejectedValueOnce(new Error('session ingest unavailable'));
    getPgDbMock.mockReturnValue(makeDb([[{ email: 'test@example.com' }]]));

    await expect(runCreate(ctx, request)).rejects.toThrow('session ingest unavailable');
    expect(markReconcilePendingMock).toHaveBeenCalledWith(expect.any(Object), { rowId: ROW_ID });
    expect(settleOperationMock).not.toHaveBeenCalled();

    // Attempt 2: same-key retry reconciles the stored IDs via the clone resume.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: await cloneRow(),
    });
    createCliSessionMock.mockResolvedValue({
      status: 'ready',
      clone: { sessionId: KILO_SESSION_ID, copiedItemCount: 3 },
    });
    getPgDbMock.mockReturnValue(makeDb([[], [{ email: 'test@example.com' }]]));

    const result = await runCreate(ctx, request);

    expect(createCliSessionMock).toHaveBeenLastCalledWith(
      KILO_SESSION_ID,
      CLOUD_AGENT_SESSION_ID,
      USER_ID,
      expect.any(Object),
      undefined,
      'cloud-agent',
      expect.any(String),
      'https://github.com/acme/repo',
      SOURCE_KILO_SESSION_ID
    );
    expect(doStub.registerSession).toHaveBeenCalledTimes(1);
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

  it('surfaces SERVICE_UNAVAILABLE session_clone_unavailable when the resume ingest sends no acknowledgement', async () => {
    const request = cloneRequest();
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: await cloneRow(),
    });
    createCliSessionMock.mockResolvedValue(undefined);
    getPgDbMock.mockReturnValue(makeDb([[], [{ email: 'test@example.com' }]]));
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    await expect(runCreate(ctx, request)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'session_clone_unavailable',
    });

    expect(deleteCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      USER_ID,
      expect.any(Object),
      { onlyIfEmpty: true }
    );
    expect(markReconcilePendingMock).toHaveBeenCalledWith(expect.any(Object), { rowId: ROW_ID });
    expect(doStub.registerSession).not.toHaveBeenCalled();
  });

  it('tombstones a rejected clone so the next same-key retry allocates fresh IDs', async () => {
    const request = cloneRequest();
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    // Attempt 1: explicit clone rejection. The best-effort settle fails, so the
    // row stays non-terminal and the tombstone is what protects the retry.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'admitted',
      row: makeLedgerRow({}),
    });
    createCliSessionMock.mockResolvedValueOnce({
      status: 'rejected',
      code: 'source_access_denied',
    });
    settleOperationMock.mockRejectedValueOnce(new Error('ledger db unavailable'));
    getPgDbMock.mockReturnValue(makeDb([[{ email: 'test@example.com' }]]));

    await expect(runCreate(ctx, request)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'source_access_denied',
    });

    expect(recordOperationProgressMock).toHaveBeenCalledWith(expect.any(Object), ROW_ID, {
      [SESSION_CREATE_TOMBSTONED_IDS_KEY]: {
        cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
        kiloSessionId: KILO_SESSION_ID,
      },
    });

    // Attempt 2: same-key retry sees the tombstone and allocates fresh IDs.
    const FRESH_CLOUD_ID = 'agent_fresh_11111111-1111-1111-1111-111111111111';
    const FRESH_KILO_ID = 'ses_fresh_222222222222222222222222';
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: await cloneRow({
        [SESSION_CREATE_TOMBSTONED_IDS_KEY]: {
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
          kiloSessionId: KILO_SESSION_ID,
        },
      }),
    });
    generateSessionIdMock.mockReturnValueOnce(FRESH_CLOUD_ID);
    generateKiloSessionIdMock.mockReturnValueOnce(FRESH_KILO_ID);
    createCliSessionMock.mockResolvedValue({
      status: 'ready',
      clone: { sessionId: FRESH_KILO_ID, copiedItemCount: 1 },
    });
    getPgDbMock.mockReturnValue(makeDb([[], [{ email: 'test@example.com' }]]));

    const result = await runCreate(ctx, request);

    expect(createCliSessionMock).toHaveBeenLastCalledWith(
      FRESH_KILO_ID,
      FRESH_CLOUD_ID,
      USER_ID,
      expect.any(Object),
      undefined,
      'cloud-agent',
      expect.any(String),
      'https://github.com/acme/repo',
      SOURCE_KILO_SESSION_ID
    );
    expect(doStub.registerSession).toHaveBeenCalledTimes(1);
    expect(settleOperationMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        rowId: ROW_ID,
        status: 'completed',
        outcomeCode: 'ok',
        canonicalResult: {
          cloudAgentSessionId: FRESH_CLOUD_ID,
          kiloSessionId: FRESH_KILO_ID,
        },
      })
    );
    expect(result).toEqual({
      cloudAgentSessionId: FRESH_CLOUD_ID,
      kiloSessionId: FRESH_KILO_ID,
    });
  });

  it('tombstones a rejected clone resume so the next same-key retry allocates fresh IDs', async () => {
    const request = cloneRequest();
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    // Attempt 1: same-key retry reconciles the stored IDs via the clone resume,
    // and the resume ingest rejects the clone. The tombstone is what protects
    // the retry even though the settle is best-effort.
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: await cloneRow(),
    });
    createCliSessionMock.mockResolvedValueOnce({
      status: 'rejected',
      code: 'source_access_denied',
    });
    getPgDbMock.mockReturnValue(makeDb([[], [{ email: 'test@example.com' }]]));

    await expect(runCreate(ctx, request)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'source_access_denied',
    });

    expect(createCliSessionMock).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      CLOUD_AGENT_SESSION_ID,
      USER_ID,
      expect.any(Object),
      undefined,
      'cloud-agent',
      expect.any(String),
      'https://github.com/acme/repo',
      SOURCE_KILO_SESSION_ID
    );
    expect(recordOperationProgressMock).toHaveBeenCalledWith(expect.any(Object), ROW_ID, {
      [SESSION_CREATE_TOMBSTONED_IDS_KEY]: {
        cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
        kiloSessionId: KILO_SESSION_ID,
      },
    });
    expect(doStub.registerSession).not.toHaveBeenCalled();

    // Attempt 2: same-key retry sees the tombstone and allocates fresh IDs.
    const FRESH_CLOUD_ID = 'agent_fresh_11111111-1111-1111-1111-111111111111';
    const FRESH_KILO_ID = 'ses_fresh_222222222222222222222222';
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: await cloneRow({
        [SESSION_CREATE_TOMBSTONED_IDS_KEY]: {
          cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
          kiloSessionId: KILO_SESSION_ID,
        },
      }),
    });
    generateSessionIdMock.mockReturnValueOnce(FRESH_CLOUD_ID);
    generateKiloSessionIdMock.mockReturnValueOnce(FRESH_KILO_ID);
    createCliSessionMock.mockResolvedValue({
      status: 'ready',
      clone: { sessionId: FRESH_KILO_ID, copiedItemCount: 1 },
    });
    getPgDbMock.mockReturnValue(makeDb([[], [{ email: 'test@example.com' }]]));

    const result = await runCreate(ctx, request);

    expect(createCliSessionMock).toHaveBeenLastCalledWith(
      FRESH_KILO_ID,
      FRESH_CLOUD_ID,
      USER_ID,
      expect.any(Object),
      undefined,
      'cloud-agent',
      expect.any(String),
      'https://github.com/acme/repo',
      SOURCE_KILO_SESSION_ID
    );
    expect(doStub.registerSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      cloudAgentSessionId: FRESH_CLOUD_ID,
      kiloSessionId: FRESH_KILO_ID,
    });
  });

  it('rebuilds the allocation with the stored initialMessageId, not the retry new id', async () => {
    const request = cloneRequest({
      initialTurn: { type: 'prompt', prompt: 'Build the feature', id: 'msg_retry_new' },
    });
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: await cloneRow({ initialMessageId: STORED_MESSAGE_ID }, request),
    });
    createCliSessionMock.mockResolvedValue({
      status: 'ready',
      clone: { sessionId: KILO_SESSION_ID, copiedItemCount: 1 },
    });
    getPgDbMock.mockReturnValue(makeDb([[], [{ email: 'test@example.com' }]]));
    const doStub = makeDoStub();
    const ctx = makeContext(doStub);

    const result = await runCreate(ctx, request);

    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          initialTurn: expect.objectContaining({
            messageId: STORED_MESSAGE_ID,
            prompt: 'Build the feature',
          }),
        }),
      })
    );
    expect(result).toEqual({
      cloudAgentSessionId: CLOUD_AGENT_SESSION_ID,
      kiloSessionId: KILO_SESSION_ID,
      replayed: true,
    });
  });
});

describe('prepareInputToSessionCreateRequest clone mapping', () => {
  const SOURCE_SESSION_ID = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('maps cloneFromKiloSessionId into the grouped clone object and omits the initial turn', () => {
    const request = prepareInputToSessionCreateRequest({
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      shallow: false,
      devcontainer: false,
      autoInitiate: true,
      operationKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      cloneFromKiloSessionId: SOURCE_SESSION_ID,
    });

    expect(request.clone).toEqual({ cloneFromKiloSessionId: SOURCE_SESSION_ID });
    expect(request.initialTurn).toBeUndefined();
  });

  it('omits clone when cloneFromKiloSessionId is absent', () => {
    const request = prepareInputToSessionCreateRequest({
      prompt: 'Continue',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      shallow: false,
      devcontainer: false,
    });

    expect(request.clone).toBeUndefined();
  });
});
