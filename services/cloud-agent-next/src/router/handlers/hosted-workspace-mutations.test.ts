import type * as CloudAgentProfile from '@kilocode/cloud-agent-profile';
import type { WorkerDb } from '@kilocode/db/client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { appRouter } from '../../router.js';
import type * as SessionRegistration from '../../session/session-registration.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import type { TRPCContext } from '../../types.js';
import {
  CreateHostedWorkspaceInput,
  DeleteHostedWorkspaceSessionInput,
  DeleteHostedWorkspaceSessionOutput,
  hostedWorkspaceCreateRequest,
} from './hosted-workspace-mutations.js';
import { CreateHostedWorkspaceSessionInput } from './session-worktree.js';
import { profileResolutionPolicyForSessionCreateOrigin } from './session-creation-preflight.js';

const mocks = vi.hoisted(() => ({
  admitOperation: vi.fn(),
  getOperation: vi.fn(),
  markReconcilePending: vi.fn(),
  recordOperationProgress: vi.fn(),
  settleOperation: vi.fn(),
  getPgDb: vi.fn(),
  requireCurrentSessionAccess: vi.fn(),
  mergeProfileConfiguration: vi.fn(),
  loadEnvironmentForSession: vi.fn(),
  getBuiltinAgentSettings: vi.fn(),
  assertRepositoryAccessBeforeSessionCreation: vi.fn(),
  assertEnvironmentRepositoriesAccess: vi.fn(),
  assertKiloModelAvailable: vi.fn(),
  createSessionWithLedger: vi.fn(),
  diagnostic: vi.fn(),
}));

vi.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: mocks.admitOperation,
  getOperation: mocks.getOperation,
  markReconcilePending: mocks.markReconcilePending,
  recordOperationProgress: mocks.recordOperationProgress,
  settleOperation: mocks.settleOperation,
}));

vi.mock('../../db/pg.js', () => ({ getPgDb: mocks.getPgDb }));

vi.mock('../../session-access.js', () => ({
  requireCurrentSessionAccess: mocks.requireCurrentSessionAccess,
}));

vi.mock('@kilocode/cloud-agent-profile', async importActual => ({
  ...(await importActual<typeof CloudAgentProfile>()),
  mergeProfileConfiguration: mocks.mergeProfileConfiguration,
  loadEnvironmentForSession: mocks.loadEnvironmentForSession,
  getBuiltinAgentSettings: mocks.getBuiltinAgentSettings,
}));

vi.mock('../../session/validate-repository-access.js', () => ({
  assertRepositoryAccessBeforeSessionCreation: mocks.assertRepositoryAccessBeforeSessionCreation,
  assertEnvironmentRepositoriesAccess: mocks.assertEnvironmentRepositoriesAccess,
}));

vi.mock('../../model-validation.js', () => ({
  assertKiloModelAvailable: mocks.assertKiloModelAvailable,
}));

vi.mock('../../session/session-registration.js', async importActual => ({
  ...(await importActual<typeof SessionRegistration>()),
  createSessionWithLedger: mocks.createSessionWithLedger,
}));

vi.mock('../../sandbox-control/diagnostics.js', () => ({
  logControlDiagnostic: mocks.diagnostic,
}));

const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111';
const cloudAgentSessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const kiloSessionId = 'ses_12345678901234567890123456';
const validProfile = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };

const validCreate = {
  operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  clientProvenance: 'agent-manager',
  repository: { type: 'github', repo: 'Kilo-Org/cloud', branch: 'main' },
  message: { prompt: 'Start the workspace' },
  agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
};

describe('hosted workspace mutation inputs', () => {
  it('registers the new mutations on the app router', () => {
    expect(appRouter.createHostedWorkspace).toBeDefined();
    expect(appRouter.createHostedWorkspaceSession).toBeDefined();
    expect(appRouter.deleteHostedWorkspaceSession).toBeDefined();
  });

  it('accepts a new workspace without a profile and forwards no profile', () => {
    const input = CreateHostedWorkspaceInput.parse(validCreate);

    expect(input.profile).toBeUndefined();
    expect(hostedWorkspaceCreateRequest(input).profile).toBeUndefined();
  });

  it('accepts a create without a message and omits the initial turn', () => {
    const { message, ...withoutMessage } = validCreate;
    const input = CreateHostedWorkspaceInput.parse(withoutMessage);

    expect(message).toBeDefined();
    expect(input.message).toBeUndefined();
    expect(hostedWorkspaceCreateRequest(input).initialTurn).toBeUndefined();
  });

  it('accepts and forwards a valid explicit profile unchanged', () => {
    const input = CreateHostedWorkspaceInput.parse({ ...validCreate, profile: validProfile });

    expect(input.profile).toEqual(validProfile);
    expect(hostedWorkspaceCreateRequest(input).profile).toEqual(validProfile);
  });

  it.each([{}, null, '', { id: '' }, { id: 'not-a-uuid' }, { ...validProfile, unknown: true }])(
    'rejects a malformed supplied profile: %j',
    profile => {
      expect(CreateHostedWorkspaceInput.safeParse({ ...validCreate, profile }).success).toBe(false);
    }
  );

  it('accepts a repository without a branch', () => {
    const input = CreateHostedWorkspaceInput.parse({
      ...validCreate,
      repository: { type: 'github', repo: 'Kilo-Org/cloud' },
    });

    expect(hostedWorkspaceCreateRequest(input).repository.branch).toBeUndefined();
  });

  it('rejects a non-agent-manager provenance for new-workspace creation', () => {
    expect(
      CreateHostedWorkspaceInput.safeParse({ ...validCreate, clientProvenance: 'browser' }).success
    ).toBe(false);
  });

  it('requires an operation key for new-workspace creation', () => {
    expect(
      CreateHostedWorkspaceInput.safeParse({ ...validCreate, operationKey: undefined }).success
    ).toBe(false);
  });

  it('forwards a client-proposed Kilo session id into registration', () => {
    const input = CreateHostedWorkspaceInput.parse({ ...validCreate, kiloSessionId });

    expect(hostedWorkspaceCreateRequest(input).options?.kiloSessionId).toBe(kiloSessionId);
  });

  it('does not accept workspace-wide overrides when adding a sibling', () => {
    const valid = {
      workspaceId,
      operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      clientProvenance: 'agent-manager',
      message: { prompt: 'Second chat' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
    };
    expect(CreateHostedWorkspaceSessionInput.safeParse(valid).success).toBe(true);
    expect(
      CreateHostedWorkspaceSessionInput.safeParse({
        ...valid,
        repository: { type: 'github', repo: 'Kilo-Org/other' },
      }).success
    ).toBe(false);
    expect(CreateHostedWorkspaceSessionInput.safeParse({ ...valid, branch: 'other' }).success).toBe(
      false
    );
    expect(
      CreateHostedWorkspaceSessionInput.safeParse({ ...valid, profile: { id: workspaceId } })
        .success
    ).toBe(false);
  });

  it('requires a workspace-scoped cloud session id for deletion', () => {
    expect(
      DeleteHostedWorkspaceSessionInput.safeParse({
        workspaceId,
        sessionId: cloudAgentSessionId,
        operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }).success
    ).toBe(true);
    expect(
      DeleteHostedWorkspaceSessionInput.safeParse({
        workspaceId,
        sessionId: kiloSessionId,
        operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }).success
    ).toBe(false);
  });

  it('defaults cleanup to complete for deletion responses without the field', () => {
    expect(
      DeleteHostedWorkspaceSessionOutput.parse({
        success: true,
        workspaceId,
        sessionId: cloudAgentSessionId,
      })
    ).toEqual({
      success: true,
      workspaceId,
      sessionId: cloudAgentSessionId,
      cleanup: 'complete',
    });
  });
});

describe('createHostedWorkspace profile preflight', () => {
  const context = {
    userId: 'usr_test',
    authToken: 'test-token',
    request: new Request('https://fixture.invalid/trpc/createHostedWorkspace'),
    env: {},
  } as TRPCContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPgDb.mockReturnValue(sequenceDb([{ worktreeId: workspaceId }]));
    mocks.mergeProfileConfiguration.mockResolvedValue({
      resolvedProfileId: validProfile.id,
      setupCommands: ['pnpm install'],
    });
    mocks.loadEnvironmentForSession.mockResolvedValue({ status: 'none' });
    mocks.getBuiltinAgentSettings.mockResolvedValue({});
    mocks.createSessionWithLedger.mockResolvedValue({
      cloudAgentSessionId,
      kiloSessionId,
      messageId: 'msg_123456789abc12345678901234',
    });
  });

  it('creates without resolving an implicit profile or applying setup commands', async () => {
    const input = CreateHostedWorkspaceInput.parse(validCreate);
    const caller = appRouter.createCaller(context);

    expect(profileResolutionPolicyForSessionCreateOrigin('agent-manager')).toEqual({
      defaultProfileResolution: 'explicit-profile-only',
    });
    await expect(caller.createHostedWorkspace(input)).resolves.toMatchObject({
      workspaceId,
      cloudAgentSessionId,
      kiloSessionId,
    });
    expect(mocks.mergeProfileConfiguration).not.toHaveBeenCalled();
    expect(mocks.loadEnvironmentForSession).not.toHaveBeenCalled();
    expect(mocks.createSessionWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          resolved: expect.objectContaining({ setupCommands: undefined }),
        }),
        options: expect.objectContaining({
          createdOnPlatform: 'agent-manager',
          clientProvenance: 'agent-manager',
        }),
      }),
      expect.anything(),
      expect.objectContaining({ includeInitialMessage: true })
    );
    const request: SessionCreateRequest = mocks.createSessionWithLedger.mock.calls[0][0];
    expect(request.profile?.id).toBeUndefined();
    expect(request.profile?.resolvedProfileId).toBeUndefined();
  });

  it('creates an empty workspace without requiring a message id', async () => {
    mocks.createSessionWithLedger.mockResolvedValue({
      cloudAgentSessionId,
      kiloSessionId,
    });
    const { message, ...withoutMessage } = validCreate;
    const caller = appRouter.createCaller(context);

    expect(message).toBeDefined();
    await expect(
      caller.createHostedWorkspace(CreateHostedWorkspaceInput.parse(withoutMessage))
    ).resolves.toEqual({
      workspaceId,
      cloudAgentSessionId,
      kiloSessionId,
    });
    expect(mocks.createSessionWithLedger).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ includeInitialMessage: false })
    );
  });

  it('resolves an explicit profile for the caller before registration', async () => {
    const input = CreateHostedWorkspaceInput.parse({ ...validCreate, profile: validProfile });
    const caller = appRouter.createCaller(context);

    await caller.createHostedWorkspace(input);

    expect(mocks.mergeProfileConfiguration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profileId: validProfile.id,
        owner: { type: 'user', id: context.userId },
      })
    );
    expect(mocks.createSessionWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          id: validProfile.id,
          resolvedProfileId: validProfile.id,
          resolved: expect.objectContaining({ setupCommands: ['pnpm install'] }),
        }),
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it('rejects an explicit profile that is not accessible to the caller before registration', async () => {
    const { mergeProfileConfiguration } = await vi.importActual<typeof CloudAgentProfile>(
      '@kilocode/cloud-agent-profile'
    );
    mocks.mergeProfileConfiguration.mockImplementationOnce(mergeProfileConfiguration);
    mocks.getPgDb.mockReturnValue(sequenceDb([]));
    const input = CreateHostedWorkspaceInput.parse({ ...validCreate, profile: validProfile });
    const caller = appRouter.createCaller(context);

    await expect(caller.createHostedWorkspace(input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: `Profile '${validProfile.id}' not found`,
    });
    expect(mocks.mergeProfileConfiguration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profileId: validProfile.id,
        owner: { type: 'user', id: context.userId },
      })
    );
    expect(mocks.createSessionWithLedger).not.toHaveBeenCalled();
    expect(mocks.admitOperation).not.toHaveBeenCalled();
  });
});

const RECONCILE_READY_ROW = {
  id: 'ledger-row-1',
  kilo_user_id: 'usr_test',
  domain: 'session',
  operation_key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  intent: 'delete_workspace_session',
  organization_id: null,
  resource_key: workspaceId,
  taxonomy: 'safe-retry',
  status: 'reconcile_pending',
  outcome_code: null,
  canonical_result: { cloudAgentSessionId, kiloSessionId, workspaceId },
  provider_ref: null,
  created_at: '2026-10-27T10:00:00.000Z',
  updated_at: '2026-10-27T10:00:00.000Z',
  lease_expires_at: '2026-10-27T10:00:00.000Z',
  expires_at: '2026-10-28T10:00:00.000Z',
};

function reconcileRetryContext(deleteHostedWorkspaceSession: Mock, deleteSession: Mock) {
  return {
    userId: 'usr_test',
    authToken: 'test-token',
    request: { headers: new Headers() } as unknown as Request,
    env: {
      SESSION_INGEST: { deleteHostedWorkspaceSession },
      SANDBOX_SESSION: { idFromName: (name: string) => name, get: () => ({ deleteSession }) },
    },
  } as unknown as TRPCContext;
}

describe('deleteHostedWorkspaceSession retry after the ownership row is gone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const results = [[{ organizationId: null, deletionStartedAt: null }], []];
    mocks.getPgDb.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => results.shift() ?? []) })),
        })),
      })),
    } as unknown as WorkerDb);
  });

  it('claims the reconcile lease and settles instead of reporting a permanent conflict', async () => {
    mocks.getOperation.mockResolvedValue(RECONCILE_READY_ROW);
    mocks.admitOperation.mockResolvedValue({
      admission: 'duplicate_reconcile_pending',
      row: RECONCILE_READY_ROW,
    });
    mocks.settleOperation.mockResolvedValue({ settled: true, row: RECONCILE_READY_ROW });
    const deleteHostedWorkspaceSession = vi.fn().mockResolvedValue({ deleted: true });
    const deleteSession = vi.fn().mockResolvedValue({ success: true });

    const caller = appRouter.createCaller(
      reconcileRetryContext(deleteHostedWorkspaceSession, deleteSession)
    );
    const result = await caller.deleteHostedWorkspaceSession({
      workspaceId: workspaceId as `worktree_${string}`,
      sessionId: cloudAgentSessionId as `workspace_${string}`,
      operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    expect(result).toEqual({
      success: true,
      workspaceId,
      sessionId: cloudAgentSessionId,
      cleanup: 'complete',
    });
    expect(mocks.admitOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    );
    expect(deleteHostedWorkspaceSession).toHaveBeenCalledWith({
      kiloUserId: 'usr_test',
      workspaceId,
      sessionId: kiloSessionId,
      cloudAgentSessionId,
    });
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(mocks.settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rowId: 'ledger-row-1', status: 'completed' })
    );
    expect(mocks.markReconcilePending).not.toHaveBeenCalled();
  });

  it('returns pending and keeps the reconcile ledger claimable when teardown still fails', async () => {
    mocks.getOperation.mockResolvedValue(RECONCILE_READY_ROW);
    mocks.admitOperation.mockResolvedValue({
      admission: 'duplicate_reconcile_pending',
      row: RECONCILE_READY_ROW,
    });
    mocks.markReconcilePending.mockResolvedValue({ settled: false });
    const deleteHostedWorkspaceSession = vi.fn().mockResolvedValue({ deleted: true });
    const deleteSession = vi.fn().mockRejectedValue(new Error('session DO unavailable'));

    const caller = appRouter.createCaller(
      reconcileRetryContext(deleteHostedWorkspaceSession, deleteSession)
    );
    await expect(
      caller.deleteHostedWorkspaceSession({
        workspaceId: workspaceId as `worktree_${string}`,
        sessionId: cloudAgentSessionId as `workspace_${string}`,
        operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      })
    ).resolves.toEqual({
      success: true,
      workspaceId,
      sessionId: cloudAgentSessionId,
      cleanup: 'pending',
    });
    expect(mocks.markReconcilePending).toHaveBeenCalledWith(expect.anything(), {
      rowId: 'ledger-row-1',
    });
    expect(mocks.settleOperation).not.toHaveBeenCalled();
  });
});

const LIVE_SESSION_ROW = {
  sessionId: kiloSessionId,
  cloudAgentSessionId,
  organizationId: null,
  worktreeId: workspaceId,
  parentSessionId: null,
};

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DELETE_KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const LIVE_LEDGER_ROW = {
  id: 'ledger-live',
  kilo_user_id: 'usr_test',
  domain: 'session',
  operation_key: DELETE_KEY,
  intent: 'delete_workspace_session',
  organization_id: null,
  resource_key: workspaceId,
  taxonomy: 'safe-retry',
  status: 'admitted',
  outcome_code: null,
  canonical_result: null,
  provider_ref: null,
  created_at: '2026-10-27T10:00:00.000Z',
  updated_at: '2026-10-27T10:00:00.000Z',
  lease_expires_at: '2026-10-27T10:00:00.000Z',
  expires_at: '2026-10-28T10:00:00.000Z',
};

/** One DB double whose `limit()` calls resolve the supplied result rows in order. */
function sequenceDb(...results: unknown[][]): WorkerDb {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => results.shift() ?? []),
        })),
      })),
    })),
  } as unknown as WorkerDb;
}

function liveDeleteContext(ingest: Mock, deleteSession: Mock): TRPCContext {
  return {
    userId: 'usr_test',
    authToken: 'test-token',
    request: { headers: new Headers() } as unknown as Request,
    env: {
      SESSION_INGEST: { deleteHostedWorkspaceSession: ingest },
      SANDBOX_SESSION: {
        idFromName: (name: string) => name,
        get: () => ({ deleteSession }),
      },
    },
  } as unknown as TRPCContext;
}

const liveDeleteInput = {
  workspaceId: workspaceId as `worktree_${string}`,
  sessionId: cloudAgentSessionId as `workspace_${string}`,
  operationKey: DELETE_KEY,
};

describe('deleteHostedWorkspaceSession partial-failure recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCurrentSessionAccess.mockResolvedValue({
      kiloSessionId,
      organizationId: null,
    });
    mocks.markReconcilePending.mockResolvedValue({ settled: false });
    mocks.recordOperationProgress.mockResolvedValue({ recorded: true });
    mocks.admitOperation.mockResolvedValue({
      admission: 'admitted',
      row: LIVE_LEDGER_ROW,
    });
  });

  it('keeps an ingest failure retryable and marks the ledger for reconciliation', async () => {
    mocks.getPgDb.mockReturnValue(
      sequenceDb([{ organizationId: null, deletionStartedAt: null }], [LIVE_SESSION_ROW])
    );
    const ingest = vi.fn().mockRejectedValue(new Error('session ingest unavailable'));
    const deleteSession = vi.fn();
    const caller = appRouter.createCaller(liveDeleteContext(ingest, deleteSession));

    await expect(caller.deleteHostedWorkspaceSession(liveDeleteInput)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'session_deletion_unavailable',
    });
    expect(mocks.markReconcilePending).toHaveBeenCalledWith(expect.anything(), {
      rowId: 'ledger-live',
    });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(mocks.settleOperation).not.toHaveBeenCalled();
  });

  it('reports logical deletion success with pending cleanup after the ingest row is gone', async () => {
    mocks.getPgDb.mockReturnValue(
      sequenceDb([{ organizationId: null, deletionStartedAt: null }], [LIVE_SESSION_ROW])
    );
    const ingest = vi.fn().mockResolvedValue({ deleted: true });
    const deleteSession = vi
      .fn()
      .mockRejectedValue(new Error('session DO unavailable token=do-not-log'));
    const caller = appRouter.createCaller(liveDeleteContext(ingest, deleteSession));

    await expect(caller.deleteHostedWorkspaceSession(liveDeleteInput)).resolves.toEqual({
      success: true,
      workspaceId,
      sessionId: cloudAgentSessionId,
      cleanup: 'pending',
    });
    expect(ingest).toHaveBeenCalledWith({
      kiloUserId: 'usr_test',
      workspaceId,
      sessionId: kiloSessionId,
      cloudAgentSessionId,
    });
    expect(mocks.markReconcilePending).toHaveBeenCalledWith(expect.anything(), {
      rowId: 'ledger-live',
    });
    expect(mocks.settleOperation).not.toHaveBeenCalled();
    const diagnostic = mocks.diagnostic.mock.calls.find(
      ([event, fields]) =>
        event === 'hosted_session_deletion' && fields.phase === 'teardown_pending'
    );
    expect(diagnostic?.[1]).toMatchObject({ errorClass: 'Error' });
    expect(JSON.stringify(diagnostic?.[1])).not.toContain('do-not-log');
  });

  it('settles a fully completed live deletion with complete cleanup', async () => {
    mocks.getPgDb.mockReturnValue(
      sequenceDb([{ organizationId: null, deletionStartedAt: null }], [LIVE_SESSION_ROW])
    );
    mocks.settleOperation.mockResolvedValue({ settled: true, row: LIVE_LEDGER_ROW });
    const ingest = vi.fn().mockResolvedValue({ deleted: true });
    const deleteSession = vi.fn().mockResolvedValue({ success: true });
    const caller = appRouter.createCaller(liveDeleteContext(ingest, deleteSession));

    await expect(caller.deleteHostedWorkspaceSession(liveDeleteInput)).resolves.toEqual({
      success: true,
      workspaceId,
      sessionId: cloudAgentSessionId,
      cleanup: 'complete',
    });
    expect(mocks.recordOperationProgress).toHaveBeenCalledWith(expect.anything(), 'ledger-live', {
      cloudAgentSessionId,
      kiloSessionId,
    });
    expect(mocks.markReconcilePending).not.toHaveBeenCalled();
    expect(mocks.settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rowId: 'ledger-live', status: 'completed' })
    );
  });

  it('does not turn a forbidden teardown failure into pending cleanup', async () => {
    mocks.getPgDb.mockReturnValue(
      sequenceDb([{ organizationId: null, deletionStartedAt: null }], [LIVE_SESSION_ROW])
    );
    const ingest = vi.fn().mockResolvedValue({ deleted: true });
    const deleteSession = vi
      .fn()
      .mockRejectedValue(new Error('worktree_access_denied token=do-not-log'));
    const caller = appRouter.createCaller(liveDeleteContext(ingest, deleteSession));

    await expect(caller.deleteHostedWorkspaceSession(liveDeleteInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Session access denied',
    });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(mocks.markReconcilePending).toHaveBeenCalledWith(expect.anything(), {
      rowId: 'ledger-live',
    });
    expect(mocks.settleOperation).not.toHaveBeenCalled();
    const diagnostic = mocks.diagnostic.mock.calls.find(
      ([event, fields]) => event === 'hosted_session_deletion' && fields.phase === 'teardown_failed'
    );
    expect(diagnostic?.[1]).toMatchObject({
      errorClass: 'Error',
      errorCode: 'worktree_access_denied',
    });
    expect(JSON.stringify(diagnostic?.[1])).not.toContain('do-not-log');
  });

  it('rejects a root delete once the caller left the owning organization', async () => {
    mocks.getPgDb.mockReturnValue(
      sequenceDb([{ organizationId: ORG_ID, deletionStartedAt: null }], [])
    );
    const caller = appRouter.createCaller(liveDeleteContext(vi.fn(), vi.fn()));

    await expect(caller.deleteHostedWorkspaceSession(liveDeleteInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have access to this organization',
    });
    expect(mocks.admitOperation).not.toHaveBeenCalled();
  });

  it('refuses an admission stored in another organization scope without any effect', async () => {
    mocks.getPgDb.mockReturnValue(
      sequenceDb([{ organizationId: null, deletionStartedAt: null }], [LIVE_SESSION_ROW])
    );
    mocks.admitOperation.mockResolvedValue({ admission: 'organization_mismatch' });
    const ingest = vi.fn();
    const deleteSession = vi.fn();
    const caller = appRouter.createCaller(liveDeleteContext(ingest, deleteSession));

    await expect(caller.deleteHostedWorkspaceSession(liveDeleteInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'operation_key_reuse_mismatch',
    });

    expect(ingest).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(mocks.recordOperationProgress).not.toHaveBeenCalled();
    expect(mocks.settleOperation).not.toHaveBeenCalled();
  });
});

describe('createHostedWorkspaceSession organization authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a sibling create once the caller left the owning organization', async () => {
    mocks.getPgDb.mockReturnValue(sequenceDb([]));
    const caller = appRouter.createCaller({
      userId: 'usr_test',
      authToken: 'test-token',
      request: { headers: new Headers() } as unknown as Request,
      env: {},
    } as unknown as TRPCContext);

    await expect(
      caller.createHostedWorkspaceSession({
        workspaceId: workspaceId as `worktree_${string}`,
        operationKey: DELETE_KEY,
        clientProvenance: 'agent-manager',
        message: { prompt: 'Second chat' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
        kilocodeOrganizationId: ORG_ID,
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have access to this organization',
    });
    expect(mocks.admitOperation).not.toHaveBeenCalled();
  });
});
