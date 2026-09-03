import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import type { OperationLedgerRow } from '@kilocode/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../auth.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type * as SessionPlane from '../../session-plane.js';
import type { TRPCContext } from '../../types.js';
import { sha256Hex } from '../../utils/sha256.js';
import { getWorktreeWorkspacePath } from '../../workspace.js';
import { CreateWorktreeChatInput, createSessionWorktreeHandlers } from './session-worktree.js';

const {
  admitOperationMock,
  markReconcilePendingMock,
  recordOperationProgressMock,
  settleOperationMock,
  getPgDbMock,
  assertOrganizationMembershipMock,
  generateSessionIdMock,
  generateKiloSessionIdMock,
  withDORetryMock,
  createSessionForCloudAgentMock,
  deleteSessionForCloudAgentMock,
  createRuntimeAuthorizationMock,
  sealRuntimeAuthorizationMock,
  verifyKiloTokenForPolicyMock,
} = vi.hoisted(() => ({
  admitOperationMock: vi.fn(),
  markReconcilePendingMock: vi.fn(),
  recordOperationProgressMock: vi.fn(),
  settleOperationMock: vi.fn(),
  getPgDbMock: vi.fn(),
  assertOrganizationMembershipMock: vi.fn(),
  generateSessionIdMock: vi.fn(),
  generateKiloSessionIdMock: vi.fn(),
  withDORetryMock: vi.fn(),
  createSessionForCloudAgentMock: vi.fn(),
  deleteSessionForCloudAgentMock: vi.fn(),
  createRuntimeAuthorizationMock: vi.fn(),
  sealRuntimeAuthorizationMock: vi.fn(),
  verifyKiloTokenForPolicyMock: vi.fn(),
}));

vi.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: admitOperationMock,
  markReconcilePending: markReconcilePendingMock,
  recordOperationProgress: recordOperationProgressMock,
  settleOperation: settleOperationMock,
}));

vi.mock('../../db/pg.js', () => ({ getPgDb: getPgDbMock }));

vi.mock('./organization-membership.js', () => ({
  assertOrganizationMembership: assertOrganizationMembershipMock,
}));

vi.mock('../../session-plane.js', async importOriginal => {
  const original = await importOriginal<typeof SessionPlane>();
  return {
    ...original,
    generateSessionId: (plane: string) => generateSessionIdMock(plane),
  };
});

vi.mock('../../utils/kilo-session-id.js', () => ({
  generateKiloSessionId: () => generateKiloSessionIdMock(),
}));

vi.mock('../../utils/do-retry.js', () => ({
  withDORetry: (
    getStub: () => unknown,
    operation: (stub: unknown) => Promise<unknown>,
    operationName: string
  ) => withDORetryMock(getStub, operation, operationName),
}));

vi.mock('@kilocode/worker-utils/runtime-authorization', () => ({
  createRuntimeAuthorization: createRuntimeAuthorizationMock,
  sealRuntimeAuthorization: sealRuntimeAuthorizationMock,
}));

vi.mock('@kilocode/worker-utils/kilo-token-policy', () => ({
  verifyKiloTokenForPolicy: verifyKiloTokenForPolicyMock,
}));

const USER_ID = 'oauth/google:1234';
const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_WORKSPACE_ID = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DESTINATION_WORKSPACE_ID = 'workspace_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALTERNATE_SOURCE_WORKSPACE_ID = 'workspace_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SOURCE_KILO_SESSION_ID = 'ses_12345678901234567890123456';
const DESTINATION_KILO_SESSION_ID = 'ses_abcdefghijklmnopqrstuvwxyz';
const ALTERNATE_SOURCE_KILO_SESSION_ID = 'ses_ZYXWVUTSRQPONMLKJIHGFEDCBA';
const WORKTREE_ID = 'worktree_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WORKTREE_ID = 'worktree_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OPERATION_KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LEDGER_ROW_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SHARED_SANDBOX_ID = 'usr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const INTERNAL_SECRET = 'test-internal-secret';
const CURRENT_AUTH_TOKEN = 'current-customer-token';

const router = t.router(createSessionWorktreeHandlers());

type OwnershipFixture = {
  kiloSessionId: string;
  cloudAgentSessionId: string;
  userId: string;
  organizationId: string | null;
  worktreeId: string | null;
  createdOnPlatform: string;
  parentSessionId: string | null;
  cloudAgentSessionScopeId: string | null;
  gitUrl: string | null;
};

function sourceMetadata(options?: {
  organizationId?: string;
  userId?: string;
  cloudAgentSessionId?: string;
  kiloSessionId?: string;
}): SessionMetadata {
  const userId = options?.userId ?? USER_ID;
  const organizationId = options?.organizationId;
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: options?.cloudAgentSessionId ?? SOURCE_WORKSPACE_ID,
      userId,
      ...(organizationId ? { orgId: organizationId } : {}),
      createdOnPlatform: 'cloud-agent-web',
      billingOrigin: 'cloud-agent-web',
    },
    auth: {
      kiloSessionId: options?.kiloSessionId ?? SOURCE_KILO_SESSION_ID,
      kilocodeToken: 'previous-customer-token',
    },
    repository: {
      type: 'github',
      repo: 'Acme/Repo',
      upstreamBranch: 'feature/shared',
      token: 'previous-repository-token',
      githubInstallationId: '12345',
    },
    agent: { mode: 'code', model: 'test-model', appendSystemPrompt: 'Stay focused' },
    profile: { envVars: { PROFILE_SETTING: 'preserved' }, setupCommands: ['pnpm install'] },
    finalization: { autoCommit: true, condenseOnComplete: true },
    workspace: {
      sandboxId: SHARED_SANDBOX_ID,
      sandboxProvider: 'cloudflare',
      sandboxRoute: { kind: 'shared', routeKey: SHARED_SANDBOX_ID },
      worktreeId: WORKTREE_ID,
      workspacePath: getWorktreeWorkspacePath(organizationId, userId, WORKTREE_ID),
      branchName: 'feature/shared',
      shallow: true,
      credentialContainment: { github: true, gitlab: false, kilocode: true },
    },
    lifecycle: { version: 1, timestamp: 1 },
  };
}

function ownershipRow(overrides: Partial<OwnershipFixture> = {}): OwnershipFixture {
  return {
    kiloSessionId: SOURCE_KILO_SESSION_ID,
    cloudAgentSessionId: SOURCE_WORKSPACE_ID,
    userId: USER_ID,
    organizationId: null,
    worktreeId: WORKTREE_ID,
    createdOnPlatform: 'cloud-agent-web',
    parentSessionId: null,
    cloudAgentSessionScopeId: SOURCE_WORKSPACE_ID,
    gitUrl: 'https://github.com/acme/repo',
    ...overrides,
  };
}

function destinationOwnershipRow(overrides: Partial<OwnershipFixture> = {}): OwnershipFixture {
  return ownershipRow({
    kiloSessionId: DESTINATION_KILO_SESSION_ID,
    cloudAgentSessionId: DESTINATION_WORKSPACE_ID,
    cloudAgentSessionScopeId: DESTINATION_WORKSPACE_ID,
    ...overrides,
  });
}

function destinationMetadata(source: SessionMetadata): SessionMetadata {
  const workspace = { ...source.workspace };
  delete workspace.providerRuntime;
  const repository = source.repository ? { ...source.repository } : undefined;
  if (repository && 'token' in repository) delete repository.token;

  return {
    ...source,
    identity: { ...source.identity, sessionId: DESTINATION_WORKSPACE_ID },
    auth: { kiloSessionId: DESTINATION_KILO_SESSION_ID, kilocodeToken: CURRENT_AUTH_TOKEN },
    ...(repository ? { repository } : {}),
    workspace,
  };
}

function ledgerRow(overrides: Partial<OperationLedgerRow> = {}): OperationLedgerRow {
  return {
    id: LEDGER_ROW_ID,
    operation_key: OPERATION_KEY,
    domain: 'session',
    intent: 'create_worktree_chat',
    kilo_user_id: USER_ID,
    organization_id: null,
    resource_key: WORKTREE_ID,
    provider_ref: null,
    taxonomy: 'safe-retry',
    status: 'admitted',
    outcome_code: null,
    canonical_result: null,
    admitted_at: new Date().toISOString(),
    settled_at: null,
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    ...overrides,
  };
}

function makeDb(results: OwnershipFixture[][]): WorkerDb {
  const limit = vi.fn(async () => results.shift() ?? []);
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit })),
      })),
    })),
  } as unknown as WorkerDb;
}

function fixture(options?: {
  organizationId?: string;
  userId?: string;
  metadata?: SessionMetadata;
  ownershipResults?: OwnershipFixture[][];
  internalSecret?: string;
  controlPlaneIds?: string;
  botId?: string;
  authToken?: string;
}) {
  const userId = options?.userId ?? USER_ID;
  const metadata =
    options?.metadata ?? sourceMetadata({ userId, organizationId: options?.organizationId });
  const source = ownershipRow({
    userId,
    organizationId: options?.organizationId ?? null,
    cloudAgentSessionId: metadata.identity.sessionId,
    cloudAgentSessionScopeId: metadata.identity.sessionId,
    kiloSessionId: metadata.auth.kiloSessionId ?? SOURCE_KILO_SESSION_ID,
  });
  const db = makeDb(options?.ownershipResults ?? [[source]]);
  getPgDbMock.mockReturnValue(db);

  const sourceStub = { getMetadata: vi.fn().mockResolvedValue(metadata) };
  const destinationStub = {
    getMetadata: vi.fn().mockResolvedValue(null),
    getRuntimeAuthorizationStatus: vi.fn().mockResolvedValue('legacy'),
    registerSession: vi.fn().mockResolvedValue({ success: true }),
    createSessionWithInitialAdmission: vi.fn(),
  };
  const sandboxSessionNamespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((name: string) =>
      name === `${userId}:${metadata.identity.sessionId}` ? sourceStub : destinationStub
    ),
  };
  const legacySessionNamespace = { idFromName: vi.fn(), get: vi.fn() };
  const sandboxControlNamespace = { idFromName: vi.fn(), get: vi.fn() };
  const headers = new Headers({
    'x-internal-api-key': options?.internalSecret ?? INTERNAL_SECRET,
  });
  const context = {
    userId,
    authToken: options?.authToken ?? CURRENT_AUTH_TOKEN,
    ...(options?.botId ? { botId: options.botId } : {}),
    request: { headers } as Request,
    env: {
      INTERNAL_API_SECRET: INTERNAL_SECRET,
      NEXTAUTH_SECRET: 'runtime-authorization-test-secret',
      CONTROL_PLANE_IDS: options?.controlPlaneIds ?? '*',
      WORKTREE_CREATION_ENABLED_IDS: '',
      HYPERDRIVE: { connectionString: 'postgres://worktree-handler-test' },
      SANDBOX_SESSION: sandboxSessionNamespace,
      CLOUD_AGENT_SESSION: legacySessionNamespace,
      SANDBOX_CONTROL: sandboxControlNamespace,
      SESSION_INGEST: {
        createSessionForCloudAgent: createSessionForCloudAgentMock,
        deleteSessionForCloudAgent: deleteSessionForCloudAgentMock,
      },
    },
  } as unknown as TRPCContext;
  const input = {
    sourceKiloSessionId: source.kiloSessionId,
    sourceCloudAgentSessionId: source.cloudAgentSessionId as `workspace_${string}`,
    operationKey: OPERATION_KEY,
    ...(options?.organizationId ? { kilocodeOrganizationId: options.organizationId } : {}),
    clientProvenance: 'browser' as const,
  };

  return {
    caller: router.createCaller(context),
    context,
    db,
    input,
    metadata,
    source,
    sourceStub,
    destinationStub,
    sandboxSessionNamespace,
    legacySessionNamespace,
    sandboxControlNamespace,
  };
}

async function progressFor(
  input: ReturnType<typeof fixture>['input'],
  overrides: Record<string, unknown> = {}
) {
  const fingerprint = await sha256Hex(
    JSON.stringify({
      sourceKiloSessionId: input.sourceKiloSessionId,
      sourceCloudAgentSessionId: input.sourceCloudAgentSessionId,
      organizationId: input.kilocodeOrganizationId ?? null,
      worktreeId: WORKTREE_ID,
      clientProvenance: input.clientProvenance,
    })
  );
  return {
    cloudAgentSessionId: DESTINATION_WORKSPACE_ID,
    kiloSessionId: DESTINATION_KILO_SESSION_ID,
    worktreeId: WORKTREE_ID,
    createIntentFingerprint: fingerprint,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  generateSessionIdMock.mockReturnValue(DESTINATION_WORKSPACE_ID);
  generateKiloSessionIdMock.mockReturnValue(DESTINATION_KILO_SESSION_ID);
  assertOrganizationMembershipMock.mockResolvedValue(undefined);
  markReconcilePendingMock.mockResolvedValue(null);
  recordOperationProgressMock.mockImplementation(
    async (_db: WorkerDb, _rowId: string, progress: Record<string, unknown>) =>
      ledgerRow({ canonical_result: progress })
  );
  settleOperationMock.mockResolvedValue({ settled: true });
  deleteSessionForCloudAgentMock.mockResolvedValue(undefined);
  verifyKiloTokenForPolicyMock.mockResolvedValue({ claims: {} });
  createRuntimeAuthorizationMock.mockResolvedValue({
    authorization: { id: 'destination-authorization', state: 'active' },
    token: 'destination-delegated-token',
  });
  sealRuntimeAuthorizationMock.mockResolvedValue('destination-seal');
  createSessionForCloudAgentMock.mockResolvedValue({
    status: 'ready',
    clone: { sessionId: DESTINATION_KILO_SESSION_ID, copiedItemCount: 0 },
  });
  admitOperationMock.mockImplementation(
    async (
      _db: WorkerDb,
      input: { userId: string; orgId?: string; intent: string; resourceKey?: string }
    ) => ({
      admission: 'admitted',
      row: ledgerRow({
        kilo_user_id: input.userId,
        organization_id: input.orgId ?? null,
        intent: input.intent,
        resource_key: input.resourceKey ?? null,
      }),
    })
  );
  withDORetryMock.mockImplementation(
    async (getStub: () => unknown, operation: (stub: unknown) => Promise<unknown>) => {
      try {
        return await operation(getStub());
      } catch (error) {
        if (error instanceof Error && 'retryable' in error && error.retryable === true) {
          return operation(getStub());
        }
        throw error;
      }
    }
  );
});

describe('createWorktreeChat request validation and authorization', () => {
  it('rejects malformed identities, non-browser provenance, and unknown input fields', () => {
    const { input } = fixture();

    expect(CreateWorktreeChatInput.safeParse(input).success).toBe(true);
    expect(
      CreateWorktreeChatInput.safeParse({ ...input, sourceKiloSessionId: 'ses_invalid' }).success
    ).toBe(false);
    expect(
      CreateWorktreeChatInput.safeParse({
        ...input,
        sourceCloudAgentSessionId: 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }).success
    ).toBe(false);
    expect(
      CreateWorktreeChatInput.safeParse({ ...input, operationKey: 'not-a-uuid' }).success
    ).toBe(false);
    expect(
      CreateWorktreeChatInput.safeParse({ ...input, clientProvenance: 'mobile' }).success
    ).toBe(false);
    expect(CreateWorktreeChatInput.safeParse({ ...input, unexpected: true }).success).toBe(false);
  });

  it('requires internal authentication before loading source ownership', async () => {
    const { caller, input } = fixture({ internalSecret: 'wrong-secret' });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(getPgDbMock).not.toHaveBeenCalled();
    expect(admitOperationMock).not.toHaveBeenCalled();
  });

  it('rejects another owner or a same-organization member without source ownership', async () => {
    const { caller, input } = fixture({
      organizationId: ORGANIZATION_ID,
      ownershipResults: [[]],
    });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(assertOrganizationMembershipMock).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      ORGANIZATION_ID
    );
    expect(admitOperationMock).not.toHaveBeenCalled();
  });

  it('rejects revoked organization membership before reading source metadata', async () => {
    assertOrganizationMembershipMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'membership revoked' })
    );
    const { caller, input, sourceStub } = fixture({ organizationId: ORGANIZATION_ID });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sourceStub.getMetadata).not.toHaveBeenCalled();
    expect(admitOperationMock).not.toHaveBeenCalled();
  });

  it('rejects a source from another organization context', async () => {
    const source = ownershipRow({ organizationId: OTHER_ORGANIZATION_ID });
    const { caller, input } = fixture({
      organizationId: ORGANIZATION_ID,
      ownershipResults: [[source]],
    });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(admitOperationMock).not.toHaveBeenCalled();
  });

  it('rejects bot-authenticated callers', async () => {
    const { caller, input, sourceStub } = fixture({ botId: 'bot-user' });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sourceStub.getMetadata).not.toHaveBeenCalled();
    expect(admitOperationMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing group', (row: OwnershipFixture) => ({ ...row, worktreeId: null })],
    ['malformed group', (row: OwnershipFixture) => ({ ...row, worktreeId: 'worktree_../../bad' })],
    [
      'child session',
      (row: OwnershipFixture) => ({ ...row, parentSessionId: SOURCE_KILO_SESSION_ID }),
    ],
    [
      'different scope',
      (row: OwnershipFixture) => ({ ...row, cloudAgentSessionScopeId: DESTINATION_WORKSPACE_ID }),
    ],
    ['automation origin', (row: OwnershipFixture) => ({ ...row, createdOnPlatform: 'slack' })],
  ])('rejects an ineligible ownership row: %s', async (_label, mutate) => {
    const { caller, input } = fixture({ ownershipResults: [[mutate(ownershipRow())]] });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(admitOperationMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'owner mismatch',
      (metadata: SessionMetadata) => ({
        ...metadata,
        identity: { ...metadata.identity, userId: 'different-owner' },
      }),
    ],
    [
      'source Kilo mismatch',
      (metadata: SessionMetadata) => ({
        ...metadata,
        auth: { ...metadata.auth, kiloSessionId: DESTINATION_KILO_SESSION_ID },
      }),
    ],
    [
      'worktree mismatch',
      (metadata: SessionMetadata) => ({
        ...metadata,
        workspace: { ...metadata.workspace, worktreeId: OTHER_WORKTREE_ID },
      }),
    ],
    [
      'noncanonical path',
      (metadata: SessionMetadata) => ({
        ...metadata,
        workspace: { ...metadata.workspace, workspacePath: '/workspace/another-owner/worktree' },
      }),
    ],
    [
      'devcontainer session',
      (metadata: SessionMetadata) => ({
        ...metadata,
        workspace: { ...metadata.workspace, devcontainerRequested: true },
      }),
    ],
    [
      'repository mismatch',
      (metadata: SessionMetadata) => ({
        ...metadata,
        repository: { type: 'github' as const, repo: 'different/repository' },
      }),
    ],
  ])('rejects unsafe source metadata: %s', async (_label, mutate) => {
    const original = sourceMetadata();
    const { caller, input, sourceStub } = fixture({ metadata: original });
    sourceStub.getMetadata.mockResolvedValueOnce(mutate(original));

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(admitOperationMock).not.toHaveBeenCalled();
  });

  it('rejects a grouped owner that is no longer enrolled in the control plane', async () => {
    const { caller, input } = fixture({ controlPlaneIds: 'another-owner' });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(admitOperationMock).not.toHaveBeenCalled();
  });
});

describe('createWorktreeChat ownership, metadata, and control-plane routing', () => {
  it('preserves legacy registration for audience-bound tokens without modern policy markers', async () => {
    const controlToken = 'legacy.header.signature';
    verifyKiloTokenForPolicyMock.mockResolvedValue({
      claims: { aud: 'cloud-agent-next' },
    });
    const { caller, input, destinationStub } = fixture({ authToken: controlToken });

    await caller.createWorktreeChat(input);

    expect(createRuntimeAuthorizationMock).not.toHaveBeenCalled();
    expect(destinationStub.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { kiloSessionId: DESTINATION_KILO_SESSION_ID, kilocodeToken: controlToken },
      })
    );
  });

  it('derives and seals authority for the exact destination, never persisting control authority', async () => {
    const controlToken = 'header.payload.signature';
    verifyKiloTokenForPolicyMock.mockResolvedValue({
      claims: { aud: 'cloud-agent-next', runtimeAdmission: {} },
    });
    const { caller, input, destinationStub } = fixture({ authToken: controlToken });

    await caller.createWorktreeChat(input);

    expect(createRuntimeAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: controlToken,
        resourceKind: 'cloud-agent-next',
        resourceId: DESTINATION_WORKSPACE_ID,
      })
    );
    expect(destinationStub.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: {
          kiloSessionId: DESTINATION_KILO_SESSION_ID,
          kilocodeToken: 'destination-delegated-token',
        },
        runtimeAuthorizationSeal: 'destination-seal',
      })
    );
    const progress = recordOperationProgressMock.mock.calls[0]?.[2] as Record<string, unknown>;
    const completed = settleOperationMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(JSON.stringify(progress)).not.toContain(controlToken);
    expect(JSON.stringify(progress)).not.toContain('destination-seal');
    expect(JSON.stringify(completed)).not.toContain(controlToken);
    expect(JSON.stringify(completed)).not.toContain('destination-seal');
  });

  it.each([
    { autoCommit: true, condenseOnComplete: true },
    { autoCommit: false, condenseOnComplete: true },
    { condenseOnComplete: true },
    undefined,
  ])('inherits source finalization without coercion: %j', async finalization => {
    const metadata = { ...sourceMetadata(), finalization };
    const { caller, input, destinationStub } = fixture({ metadata });

    await caller.createWorktreeChat(input);

    expect(destinationStub.registerSession.mock.calls[0]?.[0]?.finalization).toEqual(finalization);
  });

  it('records canonical IDs and source routing while new worktree creation is disabled', async () => {
    const {
      caller,
      input,
      metadata,
      destinationStub,
      sandboxSessionNamespace,
      legacySessionNamespace,
      sandboxControlNamespace,
    } = fixture();
    const steps: string[] = [];
    recordOperationProgressMock.mockImplementation(
      async (_db: WorkerDb, _rowId: string, progress: Record<string, unknown>) => {
        steps.push('progress');
        return ledgerRow({ canonical_result: progress });
      }
    );
    createSessionForCloudAgentMock.mockImplementation(async () => {
      steps.push('ownership');
      return {
        status: 'ready',
        clone: { sessionId: DESTINATION_KILO_SESSION_ID, copiedItemCount: 0 },
      };
    });
    destinationStub.registerSession.mockImplementation(async () => {
      steps.push('register');
      return { success: true };
    });
    settleOperationMock.mockImplementation(async () => {
      steps.push('complete');
      return { settled: true };
    });

    await expect(caller.createWorktreeChat(input)).resolves.toEqual({
      cloudAgentSessionId: DESTINATION_WORKSPACE_ID,
      kiloSessionId: DESTINATION_KILO_SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(steps).toEqual(['progress', 'ownership', 'register', 'complete']);
    expect(admitOperationMock).toHaveBeenCalledWith(expect.anything(), {
      userId: USER_ID,
      orgId: undefined,
      domain: 'session',
      intent: 'create_worktree_chat',
      operationKey: OPERATION_KEY,
      resourceKey: WORKTREE_ID,
      taxonomy: 'safe-retry',
      leaseSeconds: 120,
    });
    expect(recordOperationProgressMock).toHaveBeenCalledWith(
      expect.anything(),
      LEDGER_ROW_ID,
      expect.objectContaining({
        cloudAgentSessionId: DESTINATION_WORKSPACE_ID,
        kiloSessionId: DESTINATION_KILO_SESSION_ID,
        worktreeId: WORKTREE_ID,
        createIntentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    expect(createSessionForCloudAgentMock).toHaveBeenCalledWith({
      sessionId: DESTINATION_KILO_SESSION_ID,
      kiloUserId: USER_ID,
      cloudAgentSessionId: DESTINATION_WORKSPACE_ID,
      cloudAgentWorktreeId: WORKTREE_ID,
      cloudAgentWorktreeLocation: {
        sandboxId: metadata.workspace?.sandboxId,
        provider: 'cloudflare',
      },
      organizationId: undefined,
      createdOnPlatform: 'cloud-agent-web',
      title: expect.stringMatching(/^New session - /),
      gitUrl: 'https://github.com/acme/repo',
    });
    expect(destinationStub.registerSession).toHaveBeenCalledWith({
      identity: { ...metadata.identity, sessionId: DESTINATION_WORKSPACE_ID },
      auth: { kiloSessionId: DESTINATION_KILO_SESSION_ID, kilocodeToken: CURRENT_AUTH_TOKEN },
      agent: metadata.agent,
      repository: {
        type: 'github',
        repo: 'Acme/Repo',
        upstreamBranch: 'feature/shared',
        githubInstallationId: '12345',
      },
      workspace: metadata.workspace,
      profile: metadata.profile,
      finalization: { autoCommit: true, condenseOnComplete: true },
    });
    expect(sandboxSessionNamespace.idFromName).toHaveBeenCalledWith(
      `${USER_ID}:${DESTINATION_WORKSPACE_ID}`
    );
    expect(legacySessionNamespace.idFromName).not.toHaveBeenCalled();
    expect(legacySessionNamespace.get).not.toHaveBeenCalled();
    expect(sandboxControlNamespace.get).not.toHaveBeenCalled();
    expect(destinationStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(generateSessionIdMock).toHaveBeenCalledWith('control');
  });

  it('does not create ownership when canonical operation progress cannot be recorded', async () => {
    recordOperationProgressMock.mockResolvedValueOnce(null);
    const { caller, input, destinationStub } = fixture();

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(createSessionForCloudAgentMock).not.toHaveBeenCalled();
    expect(destinationStub.registerSession).not.toHaveBeenCalled();
  });

  it('preserves an organization-scoped isolated Vercel route without copying provider runtime', async () => {
    const metadata = sourceMetadata({ organizationId: ORGANIZATION_ID });
    metadata.workspace = {
      ...metadata.workspace,
      sandboxId: 'ses-0123456789abcdef',
      sandboxProvider: 'vercel',
      sandboxRoute: undefined,
      providerRuntime: { provider: 'vercel', sessionId: 'vercel-instance' },
    };
    const { caller, input, destinationStub } = fixture({
      organizationId: ORGANIZATION_ID,
      metadata,
    });

    await caller.createWorktreeChat(input);

    expect(assertOrganizationMembershipMock).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      ORGANIZATION_ID
    );
    expect(destinationStub.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ orgId: ORGANIZATION_ID }),
        workspace: expect.objectContaining({
          sandboxId: 'ses-0123456789abcdef',
          sandboxProvider: 'vercel',
          worktreeId: WORKTREE_ID,
          workspacePath: getWorktreeWorkspacePath(ORGANIZATION_ID, USER_ID, WORKTREE_ID),
        }),
      })
    );
    const registration = destinationStub.registerSession.mock.calls[0]?.[0];
    expect(registration?.workspace).not.toHaveProperty('providerRuntime');
    expect(registration?.repository).not.toHaveProperty('token');
    expect(registration?.auth.kilocodeToken).toBe(CURRENT_AUTH_TOKEN);
  });
});

describe('createWorktreeChat operation-ledger replay and conflict handling', () => {
  it('replays only canonical sanitized IDs for an identical completed operation', async () => {
    const { caller, input, destinationStub } = fixture({
      ownershipResults: [[ownershipRow()], [ownershipRow()]],
    });
    await caller.createWorktreeChat(input);
    const progress = recordOperationProgressMock.mock.calls[0]?.[2] as Record<string, unknown>;
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: ledgerRow({ status: 'completed', canonical_result: progress }),
    });

    await expect(caller.createWorktreeChat(input)).resolves.toEqual({
      cloudAgentSessionId: DESTINATION_WORKSPACE_ID,
      kiloSessionId: DESTINATION_KILO_SESSION_ID,
      worktreeId: WORKTREE_ID,
      replayed: true,
    });
    expect(createSessionForCloudAgentMock).toHaveBeenCalledTimes(1);
    expect(destinationStub.registerSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['first-chat intent', { intent: 'create_cloud', resource_key: null }],
    ['different domain', { domain: 'security' }],
    ['different user', { kilo_user_id: 'different-user' }],
    ['different organization', { organization_id: OTHER_ORGANIZATION_ID }],
    ['different worktree', { resource_key: OTHER_WORKTREE_ID }],
  ] as const)(
    'rejects an admitted identity collision before handling %s',
    async (_label, change) => {
      const { caller, input, destinationStub } = fixture();
      admitOperationMock.mockResolvedValueOnce({
        admission: 'duplicate_settled',
        row: ledgerRow({
          ...change,
          status: 'completed',
          canonical_result: await progressFor(input),
        }),
      });

      await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(recordOperationProgressMock).not.toHaveBeenCalled();
      expect(createSessionForCloudAgentMock).not.toHaveBeenCalled();
      expect(destinationStub.getMetadata).not.toHaveBeenCalled();
      expect(destinationStub.registerSession).not.toHaveBeenCalled();
    }
  );

  it('rejects a same-worktree retry whose source chat changed before replay or reconciliation', async () => {
    const alternateSource = sourceMetadata({
      cloudAgentSessionId: ALTERNATE_SOURCE_WORKSPACE_ID,
      kiloSessionId: ALTERNATE_SOURCE_KILO_SESSION_ID,
    });
    const { caller, input, destinationStub } = fixture({ metadata: alternateSource });
    const progress = await progressFor({
      ...input,
      sourceKiloSessionId: SOURCE_KILO_SESSION_ID,
      sourceCloudAgentSessionId: SOURCE_WORKSPACE_ID,
    });
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({ status: 'reconcile_pending', canonical_result: progress }),
    });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(destinationStub.getMetadata).not.toHaveBeenCalled();
    expect(createSessionForCloudAgentMock).not.toHaveBeenCalled();
  });

  it.each(['duplicate_in_flight', 'duplicate_reconcile_in_progress'] as const)(
    'returns an in-progress conflict for %s without side effects',
    async admission => {
      const { caller, input, destinationStub } = fixture();
      admitOperationMock.mockResolvedValueOnce({ admission, row: ledgerRow() });

      await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'creation_in_progress',
      });
      expect(destinationStub.registerSession).not.toHaveBeenCalled();
      expect(createSessionForCloudAgentMock).not.toHaveBeenCalled();
    }
  );

  it('does not replay IDs from a failed settled operation', async () => {
    const { caller, input } = fixture();
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_settled',
      row: ledgerRow({ status: 'failed', canonical_result: await progressFor(input) }),
    });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(createSessionForCloudAgentMock).not.toHaveBeenCalled();
  });
});

describe('createWorktreeChat registration rollback and unknown-outcome reconciliation', () => {
  it('recreates a fresh destination seal after a lost response', async () => {
    const controlToken = 'header.payload.signature';
    verifyKiloTokenForPolicyMock.mockResolvedValue({
      claims: { aud: 'cloud-agent-next', runtimeAdmission: {} },
    });
    const { caller, input, metadata, destinationStub } = fixture({
      authToken: controlToken,
      ownershipResults: [[ownershipRow()], [ownershipRow()], [destinationOwnershipRow()]],
    });
    destinationStub.registerSession.mockRejectedValueOnce(new Error('lost response'));

    await expect(caller.createWorktreeChat(input)).rejects.toThrow('lost response');
    const progress = recordOperationProgressMock.mock.calls[0]?.[2] as Record<string, unknown>;
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({ status: 'reconcile_pending', canonical_result: progress }),
    });
    destinationStub.getMetadata.mockResolvedValueOnce(null);
    sealRuntimeAuthorizationMock.mockResolvedValueOnce('fresh-recovery-seal');

    await caller.createWorktreeChat(input);

    expect(createRuntimeAuthorizationMock).toHaveBeenCalledTimes(2);
    expect(destinationStub.registerSession.mock.calls[1]?.[0]).toMatchObject({
      auth: { kilocodeToken: 'destination-delegated-token' },
      runtimeAuthorizationSeal: 'fresh-recovery-seal',
    });
    expect(JSON.stringify(metadata)).not.toContain('fresh-recovery-seal');
  });

  it('fails closed when current control authority is revoked during recovery', async () => {
    const controlToken = 'header.payload.signature';
    verifyKiloTokenForPolicyMock.mockResolvedValueOnce({
      claims: { aud: 'cloud-agent-next', runtimeAdmission: {} },
    });
    const { caller, input, destinationStub } = fixture({
      authToken: controlToken,
      ownershipResults: [[ownershipRow()], [ownershipRow()], [destinationOwnershipRow()]],
    });
    destinationStub.registerSession.mockRejectedValueOnce(new Error('lost response'));
    await expect(caller.createWorktreeChat(input)).rejects.toThrow('lost response');

    const progress = recordOperationProgressMock.mock.calls[0]?.[2] as Record<string, unknown>;
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({ status: 'reconcile_pending', canonical_result: progress }),
    });
    verifyKiloTokenForPolicyMock.mockRejectedValueOnce(new Error('revoked'));

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(destinationStub.registerSession).toHaveBeenCalledTimes(1);
  });

  it('does not accept a modern committed destination without its private authorization record', async () => {
    const controlToken = 'header.payload.signature';
    verifyKiloTokenForPolicyMock.mockResolvedValue({
      claims: { aud: 'cloud-agent-next', runtimeAdmission: {} },
    });
    const { caller, input, metadata, destinationStub } = fixture({ authToken: controlToken });
    destinationStub.getMetadata.mockResolvedValueOnce(destinationMetadata(metadata));
    destinationStub.getRuntimeAuthorizationStatus.mockResolvedValueOnce('revoked');
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({
        status: 'reconcile_pending',
        canonical_result: await progressFor(input),
      }),
    });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(destinationStub.registerSession).not.toHaveBeenCalled();
  });

  it('rolls back only the empty ownership row after an explicit registration rejection', async () => {
    const { caller, input, destinationStub } = fixture();
    destinationStub.registerSession.mockResolvedValueOnce({
      success: false,
      error: 'sensitive internal registration detail',
    });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'worktree_chat_registration_failed',
    });
    expect(deleteSessionForCloudAgentMock).toHaveBeenCalledWith({
      sessionId: DESTINATION_KILO_SESSION_ID,
      kiloUserId: USER_ID,
      onlyIfEmpty: true,
    });
    expect(settleOperationMock).toHaveBeenCalledWith(expect.anything(), {
      rowId: LEDGER_ROW_ID,
      status: 'failed',
      outcomeCode: 'registration_rejected',
    });
    expect(markReconcilePendingMock).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined])(
    'reconciles ambiguous registration without changing stored autoCommit=%s',
    async autoCommit => {
      const { caller, input, metadata, destinationStub } = fixture({
        ownershipResults: [[ownershipRow()], [ownershipRow()], [destinationOwnershipRow()]],
      });
      destinationStub.registerSession.mockRejectedValueOnce(
        new Error('registration outcome unknown')
      );

      await expect(caller.createWorktreeChat(input)).rejects.toThrow(
        'registration outcome unknown'
      );
      expect(markReconcilePendingMock).toHaveBeenCalledWith(expect.anything(), {
        rowId: LEDGER_ROW_ID,
      });
      expect(deleteSessionForCloudAgentMock).not.toHaveBeenCalled();
      expect(settleOperationMock).not.toHaveBeenCalled();

      const progress = recordOperationProgressMock.mock.calls[0]?.[2] as Record<string, unknown>;
      admitOperationMock.mockResolvedValueOnce({
        admission: 'duplicate_reconcile_pending',
        row: ledgerRow({ status: 'reconcile_pending', canonical_result: progress }),
      });
      const registered = destinationMetadata(metadata);
      registered.finalization = { ...registered.finalization, autoCommit };
      destinationStub.getMetadata.mockResolvedValueOnce(registered);

      await expect(caller.createWorktreeChat(input)).resolves.toEqual({
        cloudAgentSessionId: DESTINATION_WORKSPACE_ID,
        kiloSessionId: DESTINATION_KILO_SESSION_ID,
        worktreeId: WORKTREE_ID,
        replayed: true,
      });
      expect(createSessionForCloudAgentMock).toHaveBeenCalledTimes(1);
      expect(destinationStub.registerSession).toHaveBeenCalledTimes(1);
      expect(settleOperationMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'completed' })
      );
    }
  );

  it('reads committed metadata before retrying a retryable registration transport failure', async () => {
    const { caller, input, metadata, destinationStub } = fixture();
    const transportError = Object.assign(new Error('retryable transport failure'), {
      retryable: true,
    });
    destinationStub.registerSession.mockRejectedValueOnce(transportError);
    destinationStub.getMetadata.mockResolvedValueOnce(destinationMetadata(metadata));

    await expect(caller.createWorktreeChat(input)).resolves.toEqual({
      cloudAgentSessionId: DESTINATION_WORKSPACE_ID,
      kiloSessionId: DESTINATION_KILO_SESSION_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(destinationStub.getMetadata).toHaveBeenCalledTimes(1);
    expect(destinationStub.registerSession).toHaveBeenCalledTimes(1);
    expect(deleteSessionForCloudAgentMock).not.toHaveBeenCalled();
    expect(markReconcilePendingMock).not.toHaveBeenCalled();
  });

  it('resumes the recorded IDs when ownership exists but destination metadata is absent', async () => {
    const { caller, input, destinationStub } = fixture({
      ownershipResults: [[ownershipRow()], [destinationOwnershipRow()]],
    });
    admitOperationMock.mockResolvedValueOnce({
      admission: 'takeover',
      row: ledgerRow({ canonical_result: await progressFor(input) }),
    });

    await expect(caller.createWorktreeChat(input)).resolves.toEqual({
      cloudAgentSessionId: DESTINATION_WORKSPACE_ID,
      kiloSessionId: DESTINATION_KILO_SESSION_ID,
      worktreeId: WORKTREE_ID,
      replayed: true,
    });
    expect(destinationStub.getMetadata).toHaveBeenCalledTimes(1);
    expect(destinationStub.registerSession).toHaveBeenCalledTimes(1);
    expect(createSessionForCloudAgentMock).not.toHaveBeenCalled();
    expect(generateSessionIdMock).not.toHaveBeenCalled();
  });

  it('recreates missing ownership without registering already-committed destination metadata twice', async () => {
    const { caller, input, metadata, destinationStub } = fixture({
      ownershipResults: [[ownershipRow()], []],
    });
    destinationStub.getMetadata.mockResolvedValueOnce(destinationMetadata(metadata));
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({
        status: 'reconcile_pending',
        canonical_result: await progressFor(input),
      }),
    });

    await caller.createWorktreeChat(input);

    expect(createSessionForCloudAgentMock).toHaveBeenCalledTimes(1);
    expect(destinationStub.registerSession).not.toHaveBeenCalled();
  });

  it('rejects destination metadata that points at a different physical route', async () => {
    const { caller, input, metadata, destinationStub } = fixture();
    const destination = destinationMetadata(metadata);
    destination.workspace = {
      ...destination.workspace,
      sandboxId: 'usr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sandboxRoute: undefined,
    };
    destinationStub.getMetadata.mockResolvedValueOnce(destination);
    admitOperationMock.mockResolvedValueOnce({
      admission: 'duplicate_reconcile_pending',
      row: ledgerRow({
        status: 'reconcile_pending',
        canonical_result: await progressFor(input),
      }),
    });

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(destinationStub.registerSession).not.toHaveBeenCalled();
    expect(createSessionForCloudAgentMock).not.toHaveBeenCalled();
  });

  it('does not report success when the completed ledger settlement is not recorded', async () => {
    settleOperationMock.mockResolvedValueOnce({ settled: false, row: null });
    const { caller, input, destinationStub } = fixture();

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(destinationStub.registerSession).toHaveBeenCalledTimes(1);
    expect(markReconcilePendingMock).toHaveBeenCalledWith(expect.anything(), {
      rowId: LEDGER_ROW_ID,
    });
  });

  it('marks a missing ownership-create acknowledgement for reconciliation without registering', async () => {
    createSessionForCloudAgentMock.mockResolvedValueOnce(undefined);
    const { caller, input, destinationStub } = fixture();

    await expect(caller.createWorktreeChat(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(markReconcilePendingMock).toHaveBeenCalledWith(expect.anything(), {
      rowId: LEDGER_ROW_ID,
    });
    expect(destinationStub.registerSession).not.toHaveBeenCalled();
  });
});
