import type { OperationLedgerRow } from '@kilocode/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { E2BProviderError } from '../../byoc/e2b-errors.js';
import type * as E2BCredentialResolver from '../../byoc/e2b-credential-resolver.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { TRPCContext } from '../../types.js';
import { getWorktreeWorkspacePath } from '../../workspace.js';
import { t } from '../auth.js';
import { createSessionWorktreeHandlers } from './session-worktree.js';

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  progress: vi.fn(),
  settle: vi.fn(),
  db: vi.fn(),
  ingest: vi.fn(),
  credential: vi.fn(),
  enrollment: vi.fn(),
  membership: vi.fn(),
  verifyKiloTokenForPolicy: vi.fn(),
}));
vi.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: mocks.admit,
  recordOperationProgress: mocks.progress,
  settleOperation: mocks.settle,
  markReconcilePending: vi.fn(),
}));
vi.mock('../../db/pg.js', () => ({ getPgDb: mocks.db }));
vi.mock('./organization-membership.js', () => ({ assertOrganizationMembership: mocks.membership }));
vi.mock('../../utils/do-retry.js', () => ({
  withDORetry: (getStub: () => unknown, operation: (stub: unknown) => unknown) =>
    operation(getStub()),
}));
vi.mock('../../byoc/e2b-credential-resolver.js', async importOriginal => ({
  ...(await importOriginal<typeof E2BCredentialResolver>()),
  fetchByocE2BCredential: mocks.credential,
  fetchByocE2BEnrollment: mocks.enrollment,
}));
vi.mock('@kilocode/worker-utils/runtime-authorization', () => ({
  createRuntimeAuthorization: vi.fn(),
  sealRuntimeAuthorization: vi.fn(),
}));
vi.mock('@kilocode/worker-utils/kilo-token-policy', () => ({
  verifyKiloTokenForPolicy: mocks.verifyKiloTokenForPolicy,
}));

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const credentialId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationKey = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const sourceSessionId = 'workspace_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const sourceKiloSessionId = 'ses_12345678901234567890123456';
const worktreeId = 'worktree_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const userId = 'oauth/user';
const policy = {
  sandboxProviderBinding: { kind: 'e2b', organizationId, credentialId },
  credentialContainment: { github: false, gitlab: false, bitbucket: false, kilocode: false },
} as const;
const router = t.router(createSessionWorktreeHandlers());

function fixture() {
  const source: SessionMetadata = {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: sourceSessionId,
      userId,
      orgId: organizationId,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: sourceKiloSessionId },
    repository: { type: 'github', repo: 'acme/repo', token: 'old-repository-token' },
    agent: { mode: 'code', model: 'test-model' },
    workspace: {
      sandboxId: 'ses-abcdef',
      sandboxProvider: 'e2b',
      worktreeId,
      workspacePath: getWorktreeWorkspacePath(organizationId, userId, worktreeId),
      branchName: 'feature/e2b',
      ...policy,
    },
    lifecycle: { version: 1, timestamp: 1 },
  };
  const ownership = {
    kiloSessionId: sourceKiloSessionId,
    cloudAgentSessionId: sourceSessionId,
    userId,
    organizationId,
    worktreeId,
    createdOnPlatform: 'cloud-agent-web',
    parentSessionId: null,
    cloudAgentSessionScopeId: sourceSessionId,
    gitUrl: 'https://github.com/acme/repo',
  };
  const row = {
    id: operationKey,
    operation_key: operationKey,
    domain: 'session',
    intent: 'create_worktree_chat',
    kilo_user_id: userId,
    organization_id: organizationId,
    resource_key: worktreeId,
    status: 'admitted',
    canonical_result: null,
  } as OperationLedgerRow;
  const limit = vi.fn().mockResolvedValue([ownership]);
  mocks.db.mockReturnValue({ select: () => ({ from: () => ({ where: () => ({ limit }) }) }) });
  const sourceStub = { getMetadata: vi.fn().mockResolvedValue(source) };
  const destination = {
    getMetadata: vi.fn().mockResolvedValue(null),
    registerSession: vi.fn().mockResolvedValue({ success: true }),
  };
  const ctx = {
    userId,
    authToken: 'local-test-token',
    request: new Request('http://worker.test/trpc', {
      headers: { 'x-internal-api-key': 'test-internal-key' },
    }),
    env: {
      INTERNAL_API_SECRET: 'test-internal-key',
      NEXTAUTH_SECRET: 'runtime-authorization-test-secret',
      CONTROL_PLANE_IDS: '*',
      WORKTREE_CREATION_ENABLED_IDS: '',
      BYOC_E2B_ORG_IDS: '',
      BYOC_VERCEL_ORG_IDS: '*',
      CREDENTIAL_CONTAINMENT_ENABLED: 'true',
      SANDBOX_SESSION: {
        idFromName: (name: string) => name,
        get: (name: string) => (name === `${userId}:${sourceSessionId}` ? sourceStub : destination),
      },
      SESSION_INGEST: { createSessionForCloudAgent: mocks.ingest },
    },
  } as unknown as TRPCContext;
  mocks.admit.mockImplementation(async () => ({
    admission:
      row.status === 'completed'
        ? 'duplicate_settled'
        : row.canonical_result
          ? 'duplicate_reconcile_pending'
          : 'admitted',
    row,
  }));
  mocks.progress.mockImplementation(
    async (_db: unknown, _id: string, progress: Record<string, unknown>) => {
      row.canonical_result = { ...row.canonical_result, ...progress };
      return row;
    }
  );
  mocks.settle.mockImplementation(
    async (_db: unknown, result: { canonicalResult: Record<string, unknown> }) => {
      row.status = 'completed';
      row.canonical_result = { ...row.canonical_result, ...result.canonicalResult };
      return { settled: true };
    }
  );
  mocks.ingest.mockImplementation(async (input: { sessionId: string }) => ({
    status: 'ready',
    clone: { sessionId: input.sessionId, copiedItemCount: 0 },
  }));
  const run = () =>
    router.createCaller(ctx).createWorktreeChat({
      sourceKiloSessionId,
      sourceCloudAgentSessionId: sourceSessionId,
      kilocodeOrganizationId: organizationId,
      operationKey,
      clientProvenance: 'browser',
    });
  return { run, ctx, row, source, sourceStub, destination, ownership, limit };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verifyKiloTokenForPolicy.mockResolvedValue({ claims: {} });
  mocks.credential.mockResolvedValue({
    organizationId,
    credentialId,
    consentVersion: 'e2b-direct-v1',
    consentedAt: '2026-09-03T12:00:00.000Z',
    validatedAt: '2026-09-03T12:00:01.000Z',
    createdAt: '2026-09-03T12:00:02.000Z',
    apiKeyEncrypted: 'not-persisted',
  });
});

describe('E2B sibling registration', () => {
  it('inherits and records the complete source binding and policy before ownership despite changed enrollment', async () => {
    const f = fixture();
    mocks.ingest.mockImplementation(async (input: { sessionId: string }) => {
      expect(f.row.canonical_result).toMatchObject(policy);
      expect(JSON.stringify(f.row.canonical_result)).not.toContain('apiKeyEncrypted');
      return { status: 'ready', clone: { sessionId: input.sessionId, copiedItemCount: 0 } };
    });
    await f.run();
    expect(mocks.credential).toHaveBeenCalledWith(f.ctx.env, { organizationId, credentialId });
    expect(mocks.enrollment).not.toHaveBeenCalled();
    expect(mocks.membership).toHaveBeenCalledWith(expect.anything(), userId, organizationId);
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudAgentWorktreeLocation: { sandboxId: 'ses-abcdef', provider: 'e2b' },
      })
    );
    expect(f.destination.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining(policy),
        repository: { type: 'github', repo: 'acme/repo' },
      })
    );
  });

  it.each(['byoc_e2b_credential_missing', 'byoc_e2b_consent_missing'] as const)(
    'fails closed for %s without creating ownership or falling back',
    async code => {
      mocks.credential.mockRejectedValueOnce(new E2BProviderError(code));
      const f = fixture();
      await expect(f.run()).rejects.toThrow(new E2BProviderError(code).message);
      expect(mocks.ingest).not.toHaveBeenCalled();
      expect(f.destination.registerSession).not.toHaveBeenCalled();
      expect(mocks.enrollment).not.toHaveBeenCalled();
    }
  );

  it('resumes missing sibling metadata with the saved exact credential and unchanged policy', async () => {
    const f = fixture();
    await f.run();
    const saved = { ...f.row.canonical_result };
    f.row.status = 'reconcile_pending';
    f.limit.mockResolvedValueOnce([f.ownership]).mockResolvedValueOnce([]);
    f.ctx.env.CREDENTIAL_CONTAINMENT_ENABLED = 'false';
    await expect(f.run()).resolves.toMatchObject({
      cloudAgentSessionId: saved.cloudAgentSessionId,
      kiloSessionId: saved.kiloSessionId,
      replayed: true,
    });
    expect(mocks.credential).toHaveBeenLastCalledWith(f.ctx.env, { organizationId, credentialId });
    expect(f.destination.registerSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspace: expect.objectContaining(policy) })
    );
    expect(mocks.enrollment).not.toHaveBeenCalled();
  });

  it.each([
    { sandboxProviderBinding: { ...policy.sandboxProviderBinding, credentialId: operationKey } },
    { credentialContainment: undefined },
    { credentialContainment: { ...policy.credentialContainment, kilocode: true } },
  ])('rejects a changed or missing saved sibling policy: %j', async change => {
    const f = fixture();
    await f.run();
    f.row.status = 'reconcile_pending';
    f.row.canonical_result = { ...f.row.canonical_result, ...change };
    await expect(f.run()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(f.destination.registerSession).toHaveBeenCalledTimes(1);
    expect(mocks.credential).toHaveBeenCalledTimes(1);
  });

  it('rejects a source credential switch after the original sibling attempt', async () => {
    const f = fixture();
    await f.run();
    f.row.status = 'reconcile_pending';
    f.sourceStub.getMetadata.mockResolvedValue({
      ...f.source,
      workspace: {
        ...f.source.workspace,
        sandboxProviderBinding: { ...policy.sandboxProviderBinding, credentialId: operationKey },
      },
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'does not revalidate an already registered sibling when settled=%s',
    async settled => {
      const f = fixture();
      const result = await f.run();
      if (!settled) {
        f.row.status = 'reconcile_pending';
        f.destination.getMetadata.mockResolvedValue({
          ...f.source,
          identity: { ...f.source.identity, sessionId: result.cloudAgentSessionId },
          auth: { kiloSessionId: result.kiloSessionId },
        });
        f.limit.mockResolvedValueOnce([f.ownership]).mockResolvedValueOnce([
          {
            ...f.ownership,
            cloudAgentSessionId: result.cloudAgentSessionId,
            cloudAgentSessionScopeId: result.cloudAgentSessionId,
            kiloSessionId: result.kiloSessionId,
          },
        ]);
      }
      mocks.credential.mockRejectedValue(new E2BProviderError('byoc_e2b_credential_missing'));
      await expect(f.run()).resolves.toEqual({ ...result, replayed: true });
      expect(mocks.credential).toHaveBeenCalledTimes(1);
      expect(f.destination.registerSession).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects incompatible destination flags during reconciliation', async () => {
    const f = fixture();
    const result = await f.run();
    f.row.status = 'reconcile_pending';
    f.destination.getMetadata.mockResolvedValue({
      ...f.source,
      identity: { ...f.source.identity, sessionId: result.cloudAgentSessionId },
      auth: { kiloSessionId: result.kiloSessionId },
      workspace: {
        ...f.source.workspace,
        credentialContainment: { ...policy.credentialContainment, github: true },
      },
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.credential).toHaveBeenCalledTimes(1);
    expect(f.destination.registerSession).toHaveBeenCalledTimes(1);
  });
});
