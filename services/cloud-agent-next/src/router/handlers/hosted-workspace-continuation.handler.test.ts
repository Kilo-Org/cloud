import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appRouter } from '../../router.js';
import type { TRPCContext } from '../../types.js';
import type * as BalanceValidationModule from '../../balance-validation.js';
import type * as SandboxStubModule from '../../sandbox-session/session-stub.js';
import {
  isEligibleFirstWorktreeSession,
  type SessionRegistrationContext,
  type SessionRegistrationInput,
} from '../../session/session-registration.js';
import type * as SessionRegistrationModule from '../../session/session-registration.js';
import type * as ValidateRepositoryAccessModule from '../../session/validate-repository-access.js';
import type * as HostedWorkspaceMutationsModule from './hosted-workspace-mutations.js';
import type * as OrganizationMembershipModule from './organization-membership.js';
import type * as PreflightModule from './session-creation-preflight.js';
import { resolveContinuationMode } from './session-creation-preflight.js';
import type * as SessionWorktreeModule from './session-worktree.js';
import {
  ContinueHostedWorkspaceInput,
  continuationRequestDigest,
  deriveContinuationKey,
} from './hosted-workspace-continuation.js';

const mocks = vi.hoisted(() => ({
  getOperation: vi.fn(),
  admitOperation: vi.fn(),
  markReconcilePending: vi.fn(),
  recordOperationProgress: vi.fn(),
  settleOperation: vi.fn(),
  getPgDb: vi.fn(),
  assertOrganizationMembership: vi.fn(),
  assertRepositoryAccessBeforeSessionCreation: vi.fn(),
  preflightSessionCreation: vi.fn(),
  validateBalanceOnly: vi.fn(),
  createSessionWithLedger: vi.fn(),
  createContinuedWorkspaceSibling: vi.fn(),
  verifyWorkspaceIdentity: vi.fn(),
  getSandboxSessionStub: vi.fn(),
}));

vi.mock('@kilocode/db/operation-ledger', () => ({
  getOperation: mocks.getOperation,
  admitOperation: mocks.admitOperation,
  markReconcilePending: mocks.markReconcilePending,
  recordOperationProgress: mocks.recordOperationProgress,
  settleOperation: mocks.settleOperation,
}));

vi.mock('../../db/pg.js', () => ({ getPgDb: mocks.getPgDb }));

vi.mock('./organization-membership.js', async importOriginal => ({
  ...(await importOriginal<typeof OrganizationMembershipModule>()),
  assertOrganizationMembership: mocks.assertOrganizationMembership,
}));

vi.mock('../../session/validate-repository-access.js', async importOriginal => ({
  ...(await importOriginal<typeof ValidateRepositoryAccessModule>()),
  assertRepositoryAccessBeforeSessionCreation: mocks.assertRepositoryAccessBeforeSessionCreation,
}));

vi.mock('./session-creation-preflight.js', async importOriginal => ({
  ...(await importOriginal<typeof PreflightModule>()),
  preflightSessionCreation: mocks.preflightSessionCreation,
}));

vi.mock('../../balance-validation.js', async importOriginal => ({
  ...(await importOriginal<typeof BalanceValidationModule>()),
  validateBalanceOnly: mocks.validateBalanceOnly,
}));

vi.mock('../../session/session-registration.js', async importOriginal => ({
  ...(await importOriginal<typeof SessionRegistrationModule>()),
  createSessionWithLedger: mocks.createSessionWithLedger,
}));

vi.mock('./session-worktree.js', async importOriginal => ({
  ...(await importOriginal<typeof SessionWorktreeModule>()),
  createContinuedWorkspaceSibling: mocks.createContinuedWorkspaceSibling,
}));

vi.mock('./hosted-workspace-mutations.js', async importOriginal => ({
  ...(await importOriginal<typeof HostedWorkspaceMutationsModule>()),
  verifyWorkspaceIdentity: mocks.verifyWorkspaceIdentity,
}));

vi.mock('../../sandbox-session/session-stub.js', async importOriginal => ({
  ...(await importOriginal<typeof SandboxStubModule>()),
  getSandboxSessionStub: mocks.getSandboxSessionStub,
}));

const SOURCE_A = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOURCE_B = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const OP_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WORKSPACE_A = 'workspace_11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = 'workspace_22222222-2222-4222-8222-222222222222';

const REPOSITORY = { type: 'github' as const, repo: 'Kilo-Org/cloud', branch: 'main' };
const SESSIONS = [
  { sourceKiloSessionId: SOURCE_A, agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' } },
  { sourceKiloSessionId: SOURCE_B, agent: { mode: 'architect', model: 'anthropic/claude-opus-4' } },
];

const INPUT = {
  operationKey: OP_KEY,
  clientProvenance: 'agent-manager' as const,
  repository: REPOSITORY,
  activeSourceKiloSessionId: SOURCE_B,
  sessions: SESSIONS,
};

const DESTINATIONS = [
  {
    sourceKiloSessionId: SOURCE_A,
    kiloSessionId: SOURCE_A,
    cloudAgentSessionId: WORKSPACE_A,
    status: 'registered',
    modeFallback: false,
  },
  {
    sourceKiloSessionId: SOURCE_B,
    kiloSessionId: SOURCE_B,
    cloudAgentSessionId: WORKSPACE_B,
    status: 'registered',
    modeFallback: false,
  },
];

const EXPECTED_SESSIONS = [
  {
    sourceKiloSessionId: SOURCE_A,
    kiloSessionId: SOURCE_A,
    cloudAgentSessionId: WORKSPACE_A,
    agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
    modeFallback: false,
  },
  {
    sourceKiloSessionId: SOURCE_B,
    kiloSessionId: SOURCE_B,
    cloudAgentSessionId: WORKSPACE_B,
    agent: { mode: 'architect', model: 'anthropic/claude-opus-4' },
    modeFallback: false,
  },
];

const LEDGER_ROW = {
  id: 'ledger-1',
  kilo_user_id: 'usr_test',
  domain: 'session',
  operation_key: OP_KEY,
  intent: 'continue_hosted_workspace',
  organization_id: ORG_ID,
  resource_key: null,
  taxonomy: 'safe-retry',
  status: 'admitted',
  outcome_code: null,
  canonical_result: null,
  provider_ref: null,
  created_at: '2026-10-28T00:00:00.000Z',
  updated_at: '2026-10-28T00:00:00.000Z',
  lease_expires_at: '2026-10-28T00:10:00.000Z',
  expires_at: '2026-11-27T00:00:00.000Z',
};

function sourceRow(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    parentSessionId: null,
    gitUrl: null,
    organizationId: ORG_ID,
    title: sessionId,
    ...overrides,
  };
}

/** The db double only serves the source-rows read; ledger calls are mocked. */
function makeDb(sources: unknown[] = [sourceRow(SOURCE_A), sourceRow(SOURCE_B)]): WorkerDb {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => [...sources]) })),
    })),
  } as unknown as WorkerDb;
}

function context(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    userId: 'usr_test',
    authToken: 'test-token',
    request: { headers: new Headers() } as unknown as Request,
    env: {} as TRPCContext['env'],
    ...overrides,
  } as unknown as TRPCContext;
}

function caller(ctx: TRPCContext = context()) {
  return appRouter.createCaller(ctx);
}

async function completedRow() {
  return {
    ...LEDGER_ROW,
    status: 'completed',
    canonical_result: {
      continuationDigest: await continuationRequestDigest(
        ContinueHostedWorkspaceInput.parse(INPUT),
        ORG_ID
      ),
      workspaceId: 'worktree_11111111-1111-4111-8111-111111111111',
      destinations: DESTINATIONS,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOperation.mockResolvedValue(null);
  mocks.assertOrganizationMembership.mockResolvedValue(undefined);
  mocks.assertRepositoryAccessBeforeSessionCreation.mockResolvedValue(undefined);
  mocks.verifyWorkspaceIdentity.mockResolvedValue(undefined);
  mocks.preflightSessionCreation.mockImplementation(async (request: Record<string, unknown>) => ({
    ...request,
    profile: { resolved: {} },
  }));
  mocks.validateBalanceOnly.mockResolvedValue({ success: true });
  mocks.markReconcilePending.mockResolvedValue(null);
  mocks.recordOperationProgress.mockResolvedValue({ canonical_result: {} });
  mocks.settleOperation.mockResolvedValue({
    settled: true,
    row: { ...LEDGER_ROW, status: 'completed' },
  });
  mocks.createSessionWithLedger.mockResolvedValue({
    cloudAgentSessionId: WORKSPACE_A,
    kiloSessionId: SOURCE_A,
    replayed: false,
  });
  mocks.createContinuedWorkspaceSibling.mockResolvedValue({
    cloudAgentSessionId: WORKSPACE_B,
    kiloSessionId: SOURCE_B,
    worktreeId: WORKSPACE_A,
  });
  mocks.admitOperation.mockResolvedValue({ admission: 'admitted', row: LEDGER_ROW });
  mocks.getPgDb.mockReturnValue(makeDb());
});

describe('continueHostedWorkspace authorization before effects', () => {
  it('rejects a source the caller does not own before any admission', async () => {
    mocks.getPgDb.mockReturnValue(makeDb([sourceRow(SOURCE_A)]));
    await expect(caller().continueHostedWorkspace(INPUT)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'source_session_unavailable',
    });
    expect(mocks.admitOperation).not.toHaveBeenCalled();
  });

  it('rejects a non-root source before any admission', async () => {
    mocks.getPgDb.mockReturnValue(
      makeDb([sourceRow(SOURCE_A, { parentSessionId: 'ses_parent' }), sourceRow(SOURCE_B)])
    );
    await expect(caller().continueHostedWorkspace(INPUT)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'source_session_not_root',
    });
    expect(mocks.admitOperation).not.toHaveBeenCalled();
  });

  it('rejects a mixed-organization source set', async () => {
    mocks.getPgDb.mockReturnValue(
      makeDb([
        sourceRow(SOURCE_A),
        sourceRow(SOURCE_B, { organizationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }),
      ])
    );
    await expect(caller().continueHostedWorkspace(INPUT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'organization_mismatch',
    });
    expect(mocks.admitOperation).not.toHaveBeenCalled();
  });

  it('rejects a runtime worker or bot caller', async () => {
    await expect(
      caller(context({ botId: 'bot_1' } as Partial<TRPCContext>)).continueHostedWorkspace(INPUT)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.getPgDb).not.toHaveBeenCalled();
  });
});

describe('continueHostedWorkspace balance before admission', () => {
  it('maps an organization balance rejection to insufficient_balance with no parent row', async () => {
    mocks.validateBalanceOnly.mockResolvedValue({
      success: false,
      status: 402,
      message: 'insufficient_balance',
    });
    await expect(caller().continueHostedWorkspace(INPUT)).rejects.toMatchObject({
      code: 'PAYMENT_REQUIRED',
      message: 'insufficient_balance',
    });
    expect(mocks.validateBalanceOnly).toHaveBeenCalledWith('test-token', ORG_ID, expect.anything());
    expect(mocks.admitOperation).not.toHaveBeenCalled();
  });
});

describe('continueHostedWorkspace fresh success', () => {
  it('normalizes empty variants before preflight, creation, and completed replay', async () => {
    const input = {
      ...INPUT,
      sessions: SESSIONS.map(source => ({ ...source, agent: { ...source.agent, variant: '' } })),
    };
    const result = await caller().continueHostedWorkspace(input);
    expect(mocks.preflightSessionCreation.mock.calls[0]?.[0].agent.variant).toBeUndefined();
    expect(mocks.createSessionWithLedger.mock.calls[0]?.[0].agent).not.toHaveProperty('variant');
    expect(mocks.createContinuedWorkspaceSibling.mock.calls[0]?.[0].agent).not.toHaveProperty(
      'variant'
    );
    expect(result.sessions).toEqual(EXPECTED_SESSIONS);

    mocks.getOperation.mockResolvedValue({
      ...(await completedRow()),
      canonical_result: {
        continuationDigest: await continuationRequestDigest(
          ContinueHostedWorkspaceInput.parse(input),
          ORG_ID
        ),
        workspaceId: result.workspaceId,
        destinations: DESTINATIONS,
      },
    });
    const replay = await caller().continueHostedWorkspace(input);
    expect(replay.sessions).toEqual(result.sessions);
    expect(replay.replayed).toBe(true);
  });

  it('preserves a nonempty variant in root and sibling creation', async () => {
    const input = {
      ...INPUT,
      sessions: SESSIONS.map(source => ({
        ...source,
        agent: { ...source.agent, variant: 'high' },
      })),
    };
    const result = await caller().continueHostedWorkspace(input);
    expect(mocks.createSessionWithLedger.mock.calls[0]?.[0].agent.variant).toBe('high');
    expect(mocks.createContinuedWorkspaceSibling.mock.calls[0]?.[0].agent.variant).toBe('high');
    expect(result.sessions.map(source => source.agent.variant)).toEqual(['high', 'high']);
  });

  it('passes the preflight environment allocation to root creation', async () => {
    mocks.preflightSessionCreation.mockImplementation(async request => ({
      ...request,
      environmentSandboxAllocation: 'cloudflare-containers-standard-4',
    }));
    await caller().continueHostedWorkspace(INPUT);
    expect(mocks.createSessionWithLedger.mock.calls[0]?.[0].environmentSandboxAllocation).toBe(
      'cloudflare-containers-standard-4'
    );
  });

  it.each([1, 10])('budgets the parent lease for %i sequential creates', async count => {
    const sessions = Array.from({ length: count }, (_, index) => ({
      sourceKiloSessionId: `ses_${String(index).padStart(26, 'a')}`,
      agent: { mode: 'code', model: 'a/b' },
    }));
    mocks.getPgDb.mockReturnValue(
      makeDb(sessions.map(source => sourceRow(source.sourceKiloSessionId)))
    );
    await caller().continueHostedWorkspace({
      ...INPUT,
      sessions,
      activeSourceKiloSessionId: sessions[0]!.sourceKiloSessionId,
    });
    expect(mocks.admitOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leaseSeconds: 120 * count })
    );
  });

  it('creates the clone-only root and siblings and reports no replay', async () => {
    const result = await caller().continueHostedWorkspace(INPUT);
    expect(result).toMatchObject({
      workspaceId: 'worktree_11111111-1111-4111-8111-111111111111',
      activeKiloSessionId: SOURCE_B,
    });
    expect(result.replayed).toBeUndefined();
    expect(result.sessions).toEqual(EXPECTED_SESSIONS);

    expect(mocks.createSessionWithLedger).toHaveBeenCalledTimes(1);
    const firstKey = await deriveContinuationKey(OP_KEY, 0, SOURCE_A);
    const rootRequest = mocks.createSessionWithLedger.mock
      .calls[0]?.[0] as SessionRegistrationInput;
    expect(rootRequest).toMatchObject({
      clone: { cloneFromKiloSessionId: SOURCE_A },
      options: expect.objectContaining({
        createdOnPlatform: 'cloud-agent-web',
        clientProvenance: 'agent-manager',
        workspaceContinuation: true,
        operationKey: firstKey,
      }),
    });
    // The request must satisfy the real eligibility helper, not just the mock.
    expect(
      isEligibleFirstWorktreeSession(
        rootRequest,
        context() as unknown as SessionRegistrationContext
      )
    ).toBe(true);
    expect(mocks.createSessionWithLedger).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        includeInitialMessage: false,
        resolveSavedAllocationBeforeAdmission: true,
      })
    );
    expect(mocks.createContinuedWorkspaceSibling).toHaveBeenCalledTimes(1);
    expect(mocks.createContinuedWorkspaceSibling).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: await deriveContinuationKey(OP_KEY, 1, SOURCE_B),
        sourceKiloSessionId: SOURCE_B,
        agent: { mode: 'architect', model: 'anthropic/claude-opus-4' },
      })
    );
    expect(mocks.recordOperationProgress).toHaveBeenCalled();
    expect(mocks.settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'completed' })
    );
  });

  it('falls back an unavailable local mode to code and reports modeFallback', async () => {
    const result = await caller().continueHostedWorkspace({
      ...INPUT,
      sessions: [
        SESSIONS[0],
        { sourceKiloSessionId: SOURCE_B, agent: { mode: 'local-python', model: 'a/b' } },
      ],
    });

    expect(mocks.createContinuedWorkspaceSibling).toHaveBeenCalledWith(
      expect.objectContaining({ agent: { mode: 'code', model: 'a/b' } })
    );
    expect(result.sessions[1]).toMatchObject({
      agent: { mode: 'code', model: 'a/b' },
      modeFallback: true,
    });
  });

  it('applies the first-source mode fallback without mutating the caller request', async () => {
    // Faithful to a preflight that applies the continuation fallback to the
    // agent object it receives. The handler must not share the caller's object.
    mocks.preflightSessionCreation.mockImplementation(
      async (request: { agent: { mode: string } }) => {
        request.agent.mode = resolveContinuationMode(request.agent.mode, {}).mode;
        return { ...request, profile: { resolved: {} } };
      }
    );
    const input = {
      ...INPUT,
      sessions: [
        { sourceKiloSessionId: SOURCE_A, agent: { mode: 'local-unknown', model: 'a/b' } },
        SESSIONS[1],
      ],
    };

    const result = await caller().continueHostedWorkspace(input);

    expect(mocks.createSessionWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ agent: { mode: 'code', model: 'a/b' } }),
      expect.anything(),
      expect.anything()
    );
    expect(result.sessions[0]).toMatchObject({
      agent: { mode: 'code', model: 'a/b' },
      modeFallback: true,
    });
    // The fresh request is not rewritten by preflight.
    expect(input.sessions[0]!.agent.mode).toBe('local-unknown');
  });
});

describe('continueHostedWorkspace retry and replay', () => {
  async function retryRow() {
    return {
      ...LEDGER_ROW,
      canonical_result: {
        continuationDigest: await continuationRequestDigest(
          ContinueHostedWorkspaceInput.parse(INPUT),
          ORG_ID
        ),
      },
    };
  }

  it('takes over an admitted parent under the same B and replays the per-step creates', async () => {
    mocks.getOperation.mockImplementation(async (_db, args: { operationKey: string }) =>
      args.operationKey === OP_KEY ? await retryRow() : null
    );
    mocks.admitOperation.mockResolvedValue({ admission: 'takeover', row: await retryRow() });

    const result = await caller().continueHostedWorkspace(INPUT);
    expect(result.replayed).toBe(true);
    // A retry re-resolves settings; the per-step create owners replay their own
    // immutable intent, so a changed setting surfaces as a child conflict.
    expect(mocks.preflightSessionCreation).toHaveBeenCalled();
    expect(mocks.createSessionWithLedger).toHaveBeenCalledTimes(1);
  });

  it('rejects a retry whose incoming B differs before any admission', async () => {
    mocks.getOperation.mockImplementation(async (_db, args: { operationKey: string }) =>
      args.operationKey === OP_KEY ? await retryRow() : null
    );
    await expect(
      caller().continueHostedWorkspace({ ...INPUT, activeSourceKiloSessionId: SOURCE_A })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'operation_key_reuse_mismatch' });
    expect(mocks.admitOperation).not.toHaveBeenCalled();
  });

  it('replays a completed parent from its recorded destinations without sources or metadata', async () => {
    mocks.getOperation.mockImplementation(async (_db, args: { operationKey: string }) =>
      args.operationKey === OP_KEY ? await completedRow() : null
    );
    // No source rows and no destination metadata are needed for the replay.
    mocks.getPgDb.mockReturnValue(makeDb([]));

    const result = await caller().continueHostedWorkspace(INPUT);
    expect(result.replayed).toBe(true);
    expect(result.sessions).toEqual(EXPECTED_SESSIONS);
    expect(mocks.createSessionWithLedger).not.toHaveBeenCalled();
    expect(mocks.createContinuedWorkspaceSibling).not.toHaveBeenCalled();
    expect(mocks.getSandboxSessionStub).not.toHaveBeenCalled();
    expect(mocks.assertRepositoryAccessBeforeSessionCreation).toHaveBeenCalled();
  });

  it('reconstructs a recorded modeFallback without reading destination metadata', async () => {
    const row = await completedRow();
    row.canonical_result.destinations = [
      DESTINATIONS[0]!,
      { ...DESTINATIONS[1]!, modeFallback: true },
    ];
    mocks.getOperation.mockImplementation(async (_db, args: { operationKey: string }) =>
      args.operationKey === OP_KEY ? row : null
    );
    mocks.getPgDb.mockReturnValue(makeDb([]));

    const result = await caller().continueHostedWorkspace(INPUT);
    expect(result.sessions[1]).toMatchObject({
      agent: { mode: 'code', model: 'anthropic/claude-opus-4' },
      modeFallback: true,
    });
    expect(mocks.getSandboxSessionStub).not.toHaveBeenCalled();
  });

  it('replays a first-source fallback stably from the recorded digest and flag', async () => {
    const input = {
      ...INPUT,
      sessions: [
        { sourceKiloSessionId: SOURCE_A, agent: { mode: 'local-unknown', model: 'a/b' } },
        SESSIONS[1],
      ],
    };
    mocks.getOperation.mockImplementation(async (_db, args: { operationKey: string }) =>
      args.operationKey === OP_KEY
        ? {
            ...LEDGER_ROW,
            status: 'completed',
            canonical_result: {
              continuationDigest: await continuationRequestDigest(
                ContinueHostedWorkspaceInput.parse(input),
                ORG_ID
              ),
              workspaceId: 'worktree_11111111-1111-4111-8111-111111111111',
              destinations: [{ ...DESTINATIONS[0]!, modeFallback: true }, DESTINATIONS[1]!],
            },
          }
        : null
    );
    mocks.getPgDb.mockReturnValue(makeDb([]));

    const result = await caller().continueHostedWorkspace(input);
    expect(result.replayed).toBe(true);
    expect(result.sessions[0]).toMatchObject({
      agent: { mode: 'code', model: 'a/b' },
      modeFallback: true,
    });
    expect(mocks.createSessionWithLedger).not.toHaveBeenCalled();
  });
});

describe('continueHostedWorkspace concurrent loser', () => {
  it('rejects an organization mismatch at admission without creating sessions', async () => {
    mocks.admitOperation.mockResolvedValue({ admission: 'organization_mismatch' });
    await expect(caller().continueHostedWorkspace(INPUT)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'operation_key_reuse_mismatch',
    });
    expect(mocks.createSessionWithLedger).not.toHaveBeenCalled();
    expect(mocks.createContinuedWorkspaceSibling).not.toHaveBeenCalled();
  });

  it('returns creation_in_progress when the winner B matches', async () => {
    const digest = await continuationRequestDigest(
      ContinueHostedWorkspaceInput.parse(INPUT),
      ORG_ID
    );
    mocks.admitOperation.mockResolvedValue({
      admission: 'duplicate_in_flight',
      row: { ...LEDGER_ROW, canonical_result: { continuationDigest: digest } },
    });
    await expect(caller().continueHostedWorkspace(INPUT)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'creation_in_progress',
    });
  });

  it('fails the loser immediately when the winner B differs', async () => {
    mocks.admitOperation.mockResolvedValue({
      admission: 'duplicate_in_flight',
      row: { ...LEDGER_ROW, canonical_result: { continuationDigest: 'other' } },
    });
    await expect(caller().continueHostedWorkspace(INPUT)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'operation_key_reuse_mismatch',
    });
  });
});

describe('continueHostedWorkspace child classification', () => {
  it('settles the parent terminal after a durably failed child create', async () => {
    const firstKey = await deriveContinuationKey(OP_KEY, 0, SOURCE_A);
    mocks.getOperation.mockImplementation(async (_db, args: { operationKey: string }) => {
      if (args.operationKey === firstKey) return { ...LEDGER_ROW, status: 'failed' };
      return null;
    });
    mocks.createSessionWithLedger.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'session_creation_failed' })
    );

    await expect(caller().continueHostedWorkspace(INPUT)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'session_creation_failed',
    });
    expect(mocks.settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed' })
    );
    // A terminal parent is not released for retry.
    expect(mocks.markReconcilePending).not.toHaveBeenCalled();
  });

  it('keeps a transport child failure retryable and releases the parent lease', async () => {
    mocks.createSessionWithLedger.mockRejectedValue(new Error('socket closed'));
    await expect(caller().continueHostedWorkspace(INPUT)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'continuation_incomplete',
    });
    expect(mocks.settleOperation).not.toHaveBeenCalled();
    expect(mocks.markReconcilePending).toHaveBeenCalledWith(expect.anything(), {
      rowId: LEDGER_ROW.id,
    });
  });

  it('surfaces a forbidden allocation rejection as a terminal response', async () => {
    mocks.createSessionWithLedger.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'sandbox_allocation_forbidden' })
    );
    const error = (await caller()
      .continueHostedWorkspace(INPUT)
      .catch((caught: unknown) => caught)) as TRPCError;
    expect(error).toMatchObject({ code: 'FORBIDDEN', message: 'sandbox_allocation_forbidden' });
    expect((error.cause as unknown as { retryable: boolean }).retryable).toBe(false);
    expect(mocks.markReconcilePending).toHaveBeenCalled();
  });

  it('surfaces a BYOC bad-request rejection as a terminal response', async () => {
    mocks.createContinuedWorkspaceSibling.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'vercel_byoc_required' })
    );
    await expect(caller().continueHostedWorkspace(INPUT)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'vercel_byoc_required',
    });
  });

  it('maps a changed immutable child intent to non-retryable operation_key_reuse_mismatch', async () => {
    mocks.createSessionWithLedger.mockRejectedValue(
      new TRPCError({ code: 'CONFLICT', message: 'session_create_intent_conflict' })
    );
    const error = (await caller()
      .continueHostedWorkspace(INPUT)
      .catch((caught: unknown) => caught)) as TRPCError;
    expect(error).toMatchObject({
      code: 'CONFLICT',
      message: 'operation_key_reuse_mismatch',
    });
    expect((error.cause as unknown as { retryable: boolean }).retryable).toBe(false);
  });

  it('maps a changed sibling intent to non-retryable operation_key_reuse_mismatch', async () => {
    mocks.createContinuedWorkspaceSibling.mockRejectedValue(
      new TRPCError({ code: 'CONFLICT', message: 'operation_key_reuse_mismatch' })
    );
    await expect(caller().continueHostedWorkspace(INPUT)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'operation_key_reuse_mismatch',
    });
  });
});
