import type { WorkerDb } from '@kilocode/db/client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { appRouter } from '../../router.js';
import type { TRPCContext } from '../../types.js';
import {
  CreateHostedWorkspaceInput,
  DeleteHostedWorkspaceSessionInput,
  hostedWorkspaceCreateRequest,
} from './hosted-workspace-mutations.js';
import { CreateHostedWorkspaceSessionInput } from './session-worktree.js';

const mocks = vi.hoisted(() => ({
  admitOperation: vi.fn(),
  getOperation: vi.fn(),
  markReconcilePending: vi.fn(),
  recordOperationProgress: vi.fn(),
  settleOperation: vi.fn(),
  getPgDb: vi.fn(),
}));

vi.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: mocks.admitOperation,
  getOperation: mocks.getOperation,
  markReconcilePending: mocks.markReconcilePending,
  recordOperationProgress: mocks.recordOperationProgress,
  settleOperation: mocks.settleOperation,
}));

vi.mock('../../db/pg.js', () => ({ getPgDb: mocks.getPgDb }));

const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111';
const cloudAgentSessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const kiloSessionId = 'ses_12345678901234567890123456';

const validCreate = {
  operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  clientProvenance: 'agent-manager',
  repository: { type: 'github', repo: 'Kilo-Org/cloud', branch: 'main' },
  profile: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  message: { prompt: 'Start the workspace' },
  agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
};

describe('hosted workspace mutation inputs', () => {
  it('registers the new mutations on the app router', () => {
    expect(appRouter.createHostedWorkspace).toBeDefined();
    expect(appRouter.createHostedWorkspaceSession).toBeDefined();
    expect(appRouter.deleteHostedWorkspaceSession).toBeDefined();
  });

  it('requires an explicit profile for a new workspace', () => {
    expect(CreateHostedWorkspaceInput.safeParse(validCreate).success).toBe(true);
    expect(CreateHostedWorkspaceInput.safeParse({ ...validCreate, profile: {} }).success).toBe(
      false
    );
    expect(
      CreateHostedWorkspaceInput.safeParse({ ...validCreate, profile: undefined }).success
    ).toBe(false);
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

    expect(result).toEqual({ success: true, workspaceId, sessionId: cloudAgentSessionId });
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
});
