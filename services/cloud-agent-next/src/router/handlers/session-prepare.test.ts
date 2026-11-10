/**
 * Focused handler tests for the prepareSession operation-ledger admission
 * gate (plan P1-A-08b): `operationKey` + `autoInitiate` propagation to
 * `createSessionWithLedger`, the legacy fallback gates, and the `replayed`
 * output flag.
 *
 * The ledger functions in `session-registration.js` are mocked so the gate
 * logic in the handler is exercised deterministically; the full ladder is
 * covered by `src/session/session-prepare.test.ts`.
 */
import { TRPCError } from '@trpc/server';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CloudAgentProfile from '@kilocode/cloud-agent-profile';

import { t } from '../auth.js';
import { PrepareSessionInput, StartSessionInput } from '../schemas.js';
import type { TRPCContext } from '../../types.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import {
  createSessionPrepareHandlers,
  prepareInputToSessionCreateRequest,
} from './session-prepare.js';
import { createSessionStartHandlers } from './session-start.js';

function environmentLoad(
  layer: Record<string, unknown>,
  environmentId: string,
  sandboxAllocation: string | null = null
) {
  return {
    layer,
    sandboxAllocation,
    reference: {
      environmentId,
      owner: { type: 'user' as const, id: 'user-123' },
      configurationRevision: 3,
      repository: { platform: 'github' as const, repoFullName: 'acme/repo' },
    },
  };
}

const {
  mergeProfileConfigurationMock,
  getBuiltinAgentSettingsMock,
  loadEnvironmentForSessionMock,
  assertKiloModelAvailableMock,
  assertBitbucketRepositoryAccessMock,
  assertOrganizationMembershipMock,
  registerNewSessionMock,
  startNewSessionMock,
  createSessionWithLedgerMock,
  parentSpawnContextMock,
  parentMetadataMock,
  getSandboxSessionStubMock,
  requireCurrentSessionAccessMock,
} = vi.hoisted(() => ({
  mergeProfileConfigurationMock: vi.fn().mockResolvedValue({}),
  getBuiltinAgentSettingsMock: vi.fn().mockResolvedValue({}),
  loadEnvironmentForSessionMock: vi.fn().mockResolvedValue({ status: 'none' }),
  parentSpawnContextMock: vi.fn().mockResolvedValue({
    token: 'trusted-parent-model-token',
    createdOnPlatform: 'cloud-agent-web',
  }),
  parentMetadataMock: vi.fn().mockResolvedValue({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'workspace_12345678-1234-4234-8234-123456789abc',
      userId: 'test-user-123',
    },
    auth: {},
    lifecycle: { version: 1, timestamp: 1 },
  }),
  assertKiloModelAvailableMock: vi.fn().mockResolvedValue(undefined),
  assertBitbucketRepositoryAccessMock: vi.fn().mockResolvedValue(undefined),
  assertOrganizationMembershipMock: vi.fn().mockResolvedValue(undefined),
  registerNewSessionMock: vi.fn().mockResolvedValue({
    cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    kiloSessionId: 'cli-session-abc123',
    sandboxId: 'sb-test-123',
    sandboxProvider: 'cloudflare',
    initialTurn: {
      type: 'prompt',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      prompt: 'test',
    },
  }),
  startNewSessionMock: vi.fn().mockResolvedValue({
    cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    kiloSessionId: 'cli-session-abc123',
    sandboxId: 'sb-test-123',
    sandboxProvider: 'cloudflare',
    admission: {
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      compatibilityDelivery: 'queued',
    },
  }),
  createSessionWithLedgerMock: vi.fn().mockResolvedValue({
    cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    kiloSessionId: 'cli-session-abc123',
  }),
  getSandboxSessionStubMock: vi.fn(),
  requireCurrentSessionAccessMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../session-access.js', () => ({
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));

vi.mock('@kilocode/cloud-agent-profile', async importActual => {
  const actual = await importActual<typeof CloudAgentProfile>();
  return {
    ...actual,
    mergeProfileConfiguration: mergeProfileConfigurationMock,
    getBuiltinAgentSettings: getBuiltinAgentSettingsMock,
    loadEnvironmentForSession: loadEnvironmentForSessionMock,
  };
});

vi.mock('../../db/pg.js', () => ({
  getPgDb: vi.fn(() => ({ mockedDb: true })),
}));

vi.mock('../../model-validation.js', () => ({
  assertKiloModelAvailable: assertKiloModelAvailableMock,
}));

vi.mock('../../session/validate-repository-access.js', () => ({
  assertRepositoryAccessBeforeSessionCreation: assertBitbucketRepositoryAccessMock,
  assertEnvironmentRepositoriesAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./organization-membership.js', () => ({
  assertOrganizationMembership: assertOrganizationMembershipMock,
}));

vi.mock('../../session/session-registration.js', () => ({
  registerNewSession: registerNewSessionMock,
  startNewSession: startNewSessionMock,
  createSessionWithLedger: createSessionWithLedgerMock,
}));

vi.mock('../../sandbox-session/session-stub.js', () => ({
  getSandboxSessionStub: getSandboxSessionStubMock,
}));
vi.mock('../../balance-validation.js', () => ({
  validateBalanceOnly: vi.fn(async () => ({ success: true })),
}));

const handlers = createSessionPrepareHandlers();
const router = t.router({
  prepareSession: handlers.prepareSession,
  updateSession: handlers.updateSession,
  start: createSessionStartHandlers().start,
});

function createContext(overrides?: {
  userId?: string;
  organizationMembership?: boolean;
}): TRPCContext {
  const headers = new Headers();
  headers.set('x-internal-api-key', 'test-internal-api-secret');
  if (overrides?.organizationMembership === false) {
    assertOrganizationMembershipMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this organization' })
    );
  }
  return {
    userId: overrides?.userId ?? 'test-user-123',
    authToken: 'test-auth-token',
    request: { headers } as Request,
    env: {
      INTERNAL_API_SECRET: 'test-internal-api-secret',
      NEXTAUTH_SECRET: 'test-secret',
      HYPERDRIVE: {
        connectionString: 'postgres://handler-test',
      },
    } as unknown as TRPCContext['env'],
  } as TRPCContext;
}

const OPERATION_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const WORKSPACE_PARENT_ID = 'workspace_12345678-1234-4234-8234-123456789abc';
const WORKSPACE_TARGET_ID = 'workspace_22345678-1234-4234-8234-123456789abc';
const WORKSPACE_WORKTREE_ID = 'worktree_12345678-1234-4234-8234-123456789abc';

function callbackMetadata(
  sessionId: string,
  overrides: {
    worktreeId?: string;
    parentId?: string;
    allowSubagentSessions?: boolean;
  } = {}
): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: { userId: 'test-user-123', sessionId },
    auth: { kiloSessionId: `ses_${sessionId.slice(-8)}` },
    lifecycle: { version: 1, timestamp: 1 },
    allowSubagentSessions: overrides.allowSubagentSessions ?? true,
    ...(overrides.worktreeId ? { workspace: { worktreeId: overrides.worktreeId } } : {}),
    ...(overrides.parentId ? { parentCloudAgentSessionId: overrides.parentId } : {}),
  } as SessionMetadata;
}

function useSessionMetadata(entries: ReadonlyArray<readonly [string, SessionMetadata | null]>) {
  const metadata = new Map(entries);
  getSandboxSessionStubMock.mockImplementation(
    (_env: unknown, _userId: string, sessionId: string) => ({
      getCloudAgentSpawnContext: parentSpawnContextMock,
      getMetadata: async () => metadata.get(sessionId) ?? null,
    })
  );
}

describe('prepareSession operation-ledger admission gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSandboxSessionStubMock.mockImplementation(() => ({
      getCloudAgentSpawnContext: parentSpawnContextMock,
      getMetadata: parentMetadataMock,
    }));
    mergeProfileConfigurationMock.mockResolvedValue({});
    getBuiltinAgentSettingsMock.mockResolvedValue({});
    loadEnvironmentForSessionMock.mockResolvedValue({ status: 'none' });
    assertKiloModelAvailableMock.mockResolvedValue(undefined);
    assertBitbucketRepositoryAccessMock.mockResolvedValue(undefined);
    assertOrganizationMembershipMock.mockResolvedValue(undefined);
    registerNewSessionMock.mockResolvedValue({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      sandboxId: 'sb-test-123',
      sandboxProvider: 'cloudflare',
      initialTurn: {
        type: 'prompt',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        prompt: 'test',
      },
    });
    startNewSessionMock.mockResolvedValue({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      sandboxId: 'sb-test-123',
      sandboxProvider: 'cloudflare',
      admission: {
        success: true,
        outcome: 'queued',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        compatibilityDelivery: 'queued',
      },
    });
    createSessionWithLedgerMock.mockResolvedValue({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
    });
  });

  it('propagates operationKey to the ledger create only when autoInitiate is also true', async () => {
    const caller = router.createCaller(createContext());

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
      createdOnPlatform: 'cloud-agent-web',
      clientProvenance: 'browser',
    });

    expect(createSessionWithLedgerMock).toHaveBeenCalledTimes(1);
    expect(createSessionWithLedgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          operationKey: OPERATION_KEY,
          createdOnPlatform: 'cloud-agent-web',
          clientProvenance: 'browser',
        }),
      }),
      expect.objectContaining({ userId: 'test-user-123', authToken: 'test-auth-token' }),
      expect.objectContaining({
        billingOrigin: 'cloud-agent-web',
        operationKey: OPERATION_KEY,
        startedAt: expect.any(Number),
      })
    );
    expect(startNewSessionMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
  });

  it('removes the caller-controlled spawn opt-in from the prepare input', () => {
    const parsed = PrepareSessionInput.parse({
      prompt: 'parent',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      allowSubagentSessions: true,
    });
    expect(parsed).not.toHaveProperty('allowSubagentSessions');
  });

  it.each(['workspace:new-chat'])(
    'derives child lineage from authority and requires a ledger operation key for %s',
    async url => {
      const context = createContext();
      context.authToken = jwt.sign({ aud: 'cloud-agent-next' }, 'fixture');
      const authority = {
        version: 1,
        ownerId: context.userId ?? 'user-123',
        parentSessionId: 'workspace_12345678-1234-4234-8234-123456789abc',
        organizationId: null,
        authorizationId: '12345678-1234-4234-8234-123456789abc',
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
      } satisfies NonNullable<TRPCContext['cloudAgentAuthority']>;
      context.cloudAgentAuthority = authority;
      const caller = router.createCaller(context);
      await caller.prepareSession({
        prompt: 'child',
        callbackTarget: { url },
        mode: 'code',
        model: 'kilo/test-model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        operationKey: OPERATION_KEY,
        createdOnPlatform: 'cloud-agent',
      });
      const [request, registration, options] = createSessionWithLedgerMock.mock.calls[0];
      expect(request.parentCloudAgentSessionId).toBe(authority.parentSessionId);
      expect(request).not.toHaveProperty('allowSubagentSessions');
      expect(request.options.createdOnPlatform).toBe('cloud-agent-web');
      expect(request.options.callbackTarget).toEqual({ url });
      expect(registration.cloudAgentAuthority).toEqual(context.cloudAgentAuthority);
      expect(options.operationKey).toBe(OPERATION_KEY);
      expect(startNewSessionMock).not.toHaveBeenCalled();
      expect(registerNewSessionMock).not.toHaveBeenCalled();
    }
  );

  it('accepts one workspace session callback target in the child workspace', async () => {
    useSessionMetadata([
      [
        WORKSPACE_PARENT_ID,
        callbackMetadata(WORKSPACE_PARENT_ID, { worktreeId: WORKSPACE_WORKTREE_ID }),
      ],
      [
        WORKSPACE_TARGET_ID,
        callbackMetadata(WORKSPACE_TARGET_ID, { worktreeId: WORKSPACE_WORKTREE_ID }),
      ],
    ]);
    const context = createContext();
    context.authToken = jwt.sign({ aud: 'cloud-agent-next' }, 'fixture');
    context.cloudAgentAuthority = {
      version: 1,
      ownerId: context.userId ?? 'user-123',
      parentSessionId: WORKSPACE_PARENT_ID,
      organizationId: null,
      authorizationId: '12345678-1234-4234-8234-123456789abc',
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    };
    const caller = router.createCaller(context);

    await caller.prepareSession({
      prompt: 'child',
      callbackTarget: { url: `workspace:${WORKSPACE_TARGET_ID}` },
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
      createdOnPlatform: 'cloud-agent',
    });

    const [request] = createSessionWithLedgerMock.mock.calls[0];
    expect(request.options.callbackTarget).toEqual({
      url: `workspace:${WORKSPACE_TARGET_ID}`,
    });
  });

  it.each([
    ['a target in another workspace', { worktreeId: 'worktree_other' }],
    ['a child target', { parentId: WORKSPACE_PARENT_ID }],
    ['a target that cannot spawn children', { allowSubagentSessions: false }],
  ])('rejects a workspace session callback with %s', async (_label, override) => {
    useSessionMetadata([
      [
        WORKSPACE_PARENT_ID,
        callbackMetadata(WORKSPACE_PARENT_ID, { worktreeId: WORKSPACE_WORKTREE_ID }),
      ],
      [
        WORKSPACE_TARGET_ID,
        callbackMetadata(WORKSPACE_TARGET_ID, {
          worktreeId: 'worktreeId' in override ? override.worktreeId : WORKSPACE_WORKTREE_ID,
          parentId: 'parentId' in override ? override.parentId : undefined,
          allowSubagentSessions:
            'allowSubagentSessions' in override ? override.allowSubagentSessions : true,
        }),
      ],
    ]);
    const context = createContext();
    context.authToken = jwt.sign({ aud: 'cloud-agent-next' }, 'fixture');
    context.cloudAgentAuthority = {
      version: 1,
      ownerId: context.userId ?? 'user-123',
      parentSessionId: WORKSPACE_PARENT_ID,
      organizationId: null,
      authorizationId: '12345678-1234-4234-8234-123456789abc',
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    };
    const caller = router.createCaller(context);

    await expect(
      caller.prepareSession({
        prompt: 'child',
        callbackTarget: { url: `workspace:${WORKSPACE_TARGET_ID}` },
        mode: 'code',
        model: 'kilo/test-model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        operationKey: OPERATION_KEY,
        createdOnPlatform: 'cloud-agent',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
  });

  it('rejects a workspace session callback when the authority parent metadata is unavailable', async () => {
    useSessionMetadata([
      [
        WORKSPACE_TARGET_ID,
        callbackMetadata(WORKSPACE_TARGET_ID, { worktreeId: WORKSPACE_WORKTREE_ID }),
      ],
    ]);
    const context = createContext();
    context.authToken = jwt.sign({ aud: 'cloud-agent-next' }, 'fixture');
    context.cloudAgentAuthority = {
      version: 1,
      ownerId: context.userId ?? 'user-123',
      parentSessionId: WORKSPACE_PARENT_ID,
      organizationId: null,
      authorizationId: '12345678-1234-4234-8234-123456789abc',
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    };
    const caller = router.createCaller(context);

    await expect(
      caller.prepareSession({
        prompt: 'child',
        callbackTarget: { url: `workspace:${WORKSPACE_TARGET_ID}` },
        mode: 'code',
        model: 'kilo/test-model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        operationKey: OPERATION_KEY,
        createdOnPlatform: 'cloud-agent',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
  });

  it('rejects a workspace session callback without a parent authority', async () => {
    const caller = router.createCaller(createContext());

    await expect(
      caller.prepareSession({
        prompt: 'child',
        callbackTarget: { url: `workspace:${WORKSPACE_TARGET_ID}` },
        mode: 'code',
        model: 'kilo/test-model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        operationKey: OPERATION_KEY,
        createdOnPlatform: 'cloud-agent',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
  });

  it('rejects a scoped child launch without a ledger operation key', async () => {
    const context = createContext();
    context.authToken = jwt.sign({ aud: 'cloud-agent-next' }, 'fixture');
    context.cloudAgentAuthority = {
      version: 1,
      ownerId: context.userId ?? 'user-123',
      parentSessionId: 'workspace_12345678-1234-4234-8234-123456789abc',
      organizationId: null,
      authorizationId: '12345678-1234-4234-8234-123456789abc',
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    };
    const caller = router.createCaller(context);

    await expect(
      caller.prepareSession({
        prompt: 'child',
        mode: 'code',
        model: 'kilo/test-model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'operation_key_required' });

    expect(parentSpawnContextMock).not.toHaveBeenCalled();
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
  });

  it('inherits an environment allowlist when prepare supplies only an allocation', async () => {
    loadEnvironmentForSessionMock.mockResolvedValueOnce({
      status: 'match',
      environment: {
        reference: {
          environmentId: '123e4567-e89b-12d3-a456-426614174099',
          owner: { type: 'user', id: 'test-user-123' },
          configurationRevision: 1,
          repository: { platform: 'github', repoFullName: 'acme/repo' },
        },
        layer: {},
        sandboxAllocation: null,
        egressMode: 'allowlist',
        egressAllowlist: ['api.example.com'],
      },
    });
    const caller = router.createCaller(createContext());

    await caller.prepareSession({
      prompt: 'child',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      sandboxAllocation: 'cloudflare-containers-standard-3',
      autoInitiate: true,
      createdOnPlatform: 'cloud-agent-web',
    });

    expect(startNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: {
          sandboxAllocation: 'cloudflare-containers-standard-3',
          egressMode: 'allowlist',
          egressAllowlist: ['api.example.com'],
        },
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it('inherits the recorded parent policy for a scoped child', async () => {
    const context = createContext();
    context.authToken = jwt.sign({ aud: 'cloud-agent-next' }, 'fixture');
    const authority = {
      version: 1,
      ownerId: context.userId ?? 'user-123',
      parentSessionId: 'workspace_12345678-1234-4234-8234-123456789abc',
      organizationId: null,
      authorizationId: '12345678-1234-4234-8234-123456789abc',
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    } satisfies NonNullable<TRPCContext['cloudAgentAuthority']>;
    context.cloudAgentAuthority = authority;
    parentMetadataMock.mockResolvedValueOnce({
      metadataSchemaVersion: 2,
      identity: { sessionId: authority.parentSessionId, userId: context.userId },
      auth: {},
      workspace: {
        sandboxProvider: 'cloudflare-containers',
        sandboxId: 'ses-0123456789abcdef',
        egressMode: 'allowlist',
        egressAllowlist: ['api.example.com'],
      },
      lifecycle: { version: 1, timestamp: 1 },
    });

    await router.createCaller(context).prepareSession({
      prompt: 'child',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
    });

    expect(createSessionWithLedgerMock.mock.calls[0][0].runtime).toEqual({
      egressMode: 'allowlist',
      egressAllowlist: ['api.example.com'],
    });
    expect(loadEnvironmentForSessionMock).toHaveBeenCalledTimes(1);
  });

  it('uses a recorded policy for a grandchild after the repository policy changes', async () => {
    const context = createContext();
    const caller = router.createCaller(context);
    const childSessionId = 'workspace_87654321-4321-4321-8321-210987654321';
    loadEnvironmentForSessionMock.mockResolvedValueOnce({
      status: 'match',
      environment: {
        reference: {
          environmentId: '123e4567-e89b-12d3-a456-426614174099',
          owner: { type: 'user', id: 'test-user-123' },
          configurationRevision: 1,
          repository: { platform: 'github', repoFullName: 'acme/repo' },
        },
        layer: {},
        sandboxAllocation: 'cloudflare-containers-standard-3',
        egressMode: 'allowlist',
        egressAllowlist: ['api.example.com'],
      },
    });
    startNewSessionMock.mockResolvedValueOnce({
      cloudAgentSessionId: childSessionId,
      kiloSessionId: 'cli-child',
    });

    await caller.prepareSession({
      prompt: 'child',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      createdOnPlatform: 'cloud-agent-web',
    });

    const childRequest = startNewSessionMock.mock.calls[0][0];
    expect(childRequest.runtime).toEqual({
      egressMode: 'allowlist',
      egressAllowlist: ['api.example.com'],
    });

    const childMetadata = {
      metadataSchemaVersion: 2,
      allowSubagentSessions: true,
      identity: { sessionId: childSessionId, userId: context.userId },
      auth: {},
      profile: {
        envVars: { PARENT_ONLY: '1' },
        setupCommands: ['echo parent'],
        encryptedSecrets: {
          PARENT_SECRET: {
            encryptedData: 'ciphertext',
            encryptedDEK: 'dek',
            algorithm: 'rsa-aes-256-gcm',
            version: 1,
          },
        },
      },
      workspace: {
        sandboxProvider: 'cloudflare-containers',
        sandboxId: 'ses-fedcba9876543210',
        sandboxAllocation: 'cloudflare-containers-standard-3',
        egressMode: 'allowlist',
        egressAllowlist: childRequest.runtime?.egressAllowlist,
      },
      lifecycle: { version: 1, timestamp: 1 },
    };

    loadEnvironmentForSessionMock.mockResolvedValueOnce({
      status: 'match',
      environment: {
        reference: {
          environmentId: '123e4567-e89b-12d3-a456-426614174099',
          owner: { type: 'user', id: 'test-user-123' },
          configurationRevision: 1,
          repository: { platform: 'github', repoFullName: 'acme/repo' },
        },
        layer: {},
        sandboxAllocation: 'cloudflare-containers-standard-4',
        egressMode: 'allowlist',
        egressAllowlist: ['changed.example.com'],
      },
    });
    context.authToken = jwt.sign({ aud: 'cloud-agent-next' }, 'fixture');
    context.cloudAgentAuthority = {
      version: 1,
      ownerId: context.userId ?? 'test-user-123',
      parentSessionId: childSessionId,
      organizationId: null,
      authorizationId: '12345678-1234-4234-8234-123456789abc',
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
    };
    parentMetadataMock.mockResolvedValueOnce(childMetadata);

    await caller.prepareSession({
      prompt: 'grandchild',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
    });

    const grandchildRequest = createSessionWithLedgerMock.mock.calls[0][0];
    expect(grandchildRequest).toMatchObject({
      parentCloudAgentSessionId: childSessionId,
      runtime: {
        egressMode: 'allowlist',
        egressAllowlist: ['api.example.com'],
      },
    });
    expect(grandchildRequest.runtime).not.toHaveProperty('sandboxAllocation');
    expect(grandchildRequest.environmentSandboxAllocation).toBe('cloudflare-containers-standard-4');
    expect(grandchildRequest.profile?.resolved?.envVars).toBeUndefined();
    expect(grandchildRequest.profile?.resolved?.setupCommands).toBeUndefined();
    expect(grandchildRequest.profile?.resolved?.encryptedSecrets).toBeUndefined();
    expect(loadEnvironmentForSessionMock).toHaveBeenCalledTimes(2);
  });

  it('permits normal parent preparation inputs without requiring auto-initiation or GitHub', async () => {
    const caller = router.createCaller(createContext());
    await caller.prepareSession({
      prompt: 'parent',
      mode: 'code',
      model: 'kilo/test-model',
      gitUrl: 'https://example.test/repo.git',
      autoInitiate: false,
      envVars: { CUSTOM: 'value' },
      setupCommands: ['pnpm install'],
      mcpServers: {},
    });
    expect(registerNewSessionMock.mock.calls[0][0]).toMatchObject({
      repository: { type: 'git', url: 'https://example.test/repo.git' },
      profile: { overrides: { envVars: { CUSTOM: 'value' }, setupCommands: ['pnpm install'] } },
    });
    expect(startNewSessionMock).not.toHaveBeenCalled();
  });

  it('rejects a parent callback without authenticated spawn authority before creating a session', async () => {
    for (const url of ['workspace:new-chat']) {
      await expect(
        router.createCaller(createContext()).prepareSession({
          prompt: 'ordinary session',
          mode: 'code',
          model: 'kilo/test-model',
          githubRepo: 'acme/repo',
          autoInitiate: true,
          callbackTarget: { url },
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(startNewSessionMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
  });

  it('does not accept caller lineage on ordinary preparation', async () => {
    const caller = router.createCaller(createContext());
    const input = {
      prompt: 'parent',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      parentCloudAgentSessionId: 'workspace_forged',
    };
    await caller.prepareSession(input);
    expect(startNewSessionMock.mock.calls[0][0].parentCloudAgentSessionId).toBeUndefined();
  });

  it('rejects setting a workspace callback through updateSession before accessing the session', async () => {
    for (const url of [
      'workspace:new-chat',
      'workspace:workspace_22345678-1234-4234-8234-123456789abc',
      'workspace:foo',
    ]) {
      await expect(
        router.createCaller(createContext()).updateSession({
          cloudAgentSessionId: 'workspace_12345678-1234-4234-8234-123456789abc',
          callbackTarget: { url },
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message:
          'A workspace callback can only be set when a Cloud Agent parent launches a session',
      });
    }
  });

  it('rejects the retired session:parent target through updateSession', async () => {
    await expect(
      router.createCaller(createContext()).updateSession({
        cloudAgentSessionId: 'workspace_12345678-1234-4234-8234-123456789abc',
        callbackTarget: { url: 'session:parent' },
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Unsupported callback target',
    });
  });

  it('retains normal repository and model access checks for interactive parents', async () => {
    const input = {
      prompt: 'parent',
      mode: 'code',
      model: 'kilo/test-model',
      githubRepo: 'new-owner/new-repo',
      autoInitiate: true,
    };
    assertBitbucketRepositoryAccessMock.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'Repository access denied' })
    );
    await expect(router.createCaller(createContext()).prepareSession(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    assertKiloModelAvailableMock.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Model unavailable' })
    );
    await expect(router.createCaller(createContext()).prepareSession(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(startNewSessionMock).not.toHaveBeenCalled();
  });

  it('removes the caller-controlled spawn opt-in from the grouped start input', () => {
    const parsed = StartSessionInput.parse({
      message: { prompt: 'start' },
      agent: { mode: 'code', model: 'kilo/test-model' },
      repository: { type: 'git', url: 'https://example.test/repo.git' },
      allowSubagentSessions: true,
    });
    expect(parsed).not.toHaveProperty('allowSubagentSessions');
  });

  it('adapts the legacy GitHub integration id into grouped repository identity', async () => {
    const caller = router.createCaller(createContext());
    const githubIntegrationId = '123e4567-e89b-12d3-a456-426614174022';

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      githubIntegrationId,
      autoInitiate: true,
    });

    expect(startNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: {
          type: 'github',
          repo: 'acme/repo',
          githubIntegrationId,
          githubAccessPurpose: 'workflow',
        },
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('preserves trusted mobile provenance on internally authenticated preparation', async () => {
    const caller = router.createCaller(createContext());

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
      createdOnPlatform: 'cloud-agent-web',
      githubAccessPurpose: 'agent',
      clientProvenance: 'mobile',
    });

    expect(createSessionWithLedgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: expect.objectContaining({ githubAccessPurpose: 'agent' }),
        options: expect.objectContaining({ clientProvenance: 'mobile' }),
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it('ignores operationKey when autoInitiate is false and retains legacy registration', async () => {
    const caller = router.createCaller(createContext());

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: false,
      operationKey: OPERATION_KEY,
    });

    expect(registerNewSessionMock).toHaveBeenCalledTimes(1);
    expect(registerNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ operationKey: OPERATION_KEY }),
      }),
      expect.objectContaining({ userId: 'test-user-123' }),
      { billingOrigin: undefined }
    );
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).not.toHaveBeenCalled();
  });

  it('ignores operationKey when autoInitiate is omitted', async () => {
    const caller = router.createCaller(createContext());

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      operationKey: OPERATION_KEY,
    });

    expect(registerNewSessionMock).toHaveBeenCalledTimes(1);
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).not.toHaveBeenCalled();
  });

  it('uses grouped startNewSession when autoInitiate is true without an operationKey', async () => {
    const caller = router.createCaller(createContext());

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
    });

    expect(startNewSessionMock).toHaveBeenCalledTimes(1);
    expect(startNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.not.objectContaining({ operationKey: expect.anything() }),
      }),
      expect.objectContaining({ userId: 'test-user-123' }),
      { billingOrigin: undefined }
    );
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
  });

  it('does not reach the ledger when organization membership is rejected', async () => {
    const caller = router.createCaller(createContext({ organizationMembership: false }));
    const organizationId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

    await expect(
      caller.prepareSession({
        prompt: 'Attempt organization attribution',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        kilocodeOrganizationId: organizationId,
        autoInitiate: true,
        operationKey: OPERATION_KEY,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).not.toHaveBeenCalled();
  });

  it('does not reach registration or the ledger when repository access is rejected', async () => {
    const caller = router.createCaller(createContext());
    assertBitbucketRepositoryAccessMock.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Repository access rejected' })
    );

    await expect(
      caller.prepareSession({
        prompt: 'Attempt repository access',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        operationKey: OPERATION_KEY,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).not.toHaveBeenCalled();
  });

  it('does not reach the ledger when the model preflight rejects', async () => {
    const caller = router.createCaller(createContext());
    assertKiloModelAvailableMock.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Selected model is not available' })
    );

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'missing/model',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        operationKey: OPERATION_KEY,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).not.toHaveBeenCalled();
  });

  it.each(['webhook', 'scheduled'])(
    'prepares a repository agent without runtimeAgents for %s',
    async createdOnPlatform => {
      const caller = router.createCaller(createContext());

      await caller.prepareSession({
        prompt: 'Use the repository foreman agent',
        mode: 'foreman',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        createdOnPlatform,
      });

      expect(registerNewSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({ mode: 'foreman' }),
          options: expect.objectContaining({ createdOnPlatform }),
          profile: expect.objectContaining({
            resolved: expect.objectContaining({ runtimeAgents: undefined }),
          }),
        }),
        expect.anything(),
        expect.anything()
      );
      expect(assertKiloModelAvailableMock).toHaveBeenCalledOnce();
      expect(assertBitbucketRepositoryAccessMock).toHaveBeenCalledOnce();
    }
  );

  it.each(['webhook', 'scheduled'])(
    'retains explicit runtimeAgents validation for %s',
    async createdOnPlatform => {
      const caller = router.createCaller(createContext());
      await expect(
        caller.prepareSession({
          prompt: 'Use foreman',
          mode: 'foreman',
          model: 'claude-3',
          githubRepo: 'acme/repo',
          createdOnPlatform,
          runtimeAgents: [],
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('does not match any runtimeAgents'),
      });
      expect(registerNewSessionMock).not.toHaveBeenCalled();
    }
  );

  it.each(['webhook', 'scheduled'])(
    'preserves profile-defined agents for %s',
    async createdOnPlatform => {
      const agent = {
        slug: 'foreman',
        name: 'Foreman',
        config: { mode: 'primary' as const, prompt: 'Use the profile foreman' },
      };
      mergeProfileConfigurationMock.mockResolvedValueOnce({ agents: [agent] });
      const caller = router.createCaller(createContext());
      await caller.prepareSession({
        prompt: 'Use foreman',
        mode: 'foreman',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        createdOnPlatform,
        profileId: '123e4567-e89b-12d3-a456-426614174011',
      });
      expect(registerNewSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({ mode: 'foreman' }),
          profile: expect.objectContaining({
            resolved: expect.objectContaining({ runtimeAgents: [agent] }),
          }),
        }),
        expect.anything(),
        expect.anything()
      );
    }
  );

  it.each(['cloud-agent-web', 'discord', 'slack', 'code-review', undefined])(
    'retains missing custom-agent rejection for %s',
    async createdOnPlatform => {
      const caller = router.createCaller(createContext());
      await expect(
        caller.prepareSession({
          prompt: 'Use foreman',
          mode: 'foreman',
          model: 'claude-3',
          githubRepo: 'acme/repo',
          createdOnPlatform,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(registerNewSessionMock).not.toHaveBeenCalled();
    }
  );

  it('passes the exact profile-resolved request to registration', async () => {
    const caller = router.createCaller(createContext());
    const profileId = '123e4567-e89b-12d3-a456-426614174011';
    const runtimeAgent = {
      slug: 'reviewer',
      name: 'Reviewer',
      config: { prompt: 'Review the diff', mode: 'subagent' as const },
    };
    mergeProfileConfigurationMock.mockResolvedValueOnce({
      envVars: { PROFILE_VALUE: 'resolved' },
      agents: [runtimeAgent],
    });
    const input = {
      prompt: 'Use the resolved profile',
      mode: 'reviewer',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      profileId,
      createdOnPlatform: 'cloud-agent-web',
      autoInitiate: false,
      shallow: false,
    } as const;

    await caller.prepareSession(input);

    const unresolved = prepareInputToSessionCreateRequest(PrepareSessionInput.parse(input));
    expect(registerNewSessionMock.mock.calls[0]?.[0]).toEqual({
      ...unresolved,
      profile: {
        ...unresolved.profile,
        resolved: {
          envVars: { PROFILE_VALUE: 'resolved' },
          setupCommands: undefined,
          encryptedSecrets: undefined,
          mcpServers: undefined,
          runtimeSkills: undefined,
          runtimeAgents: [runtimeAgent],
          kiloCommands: undefined,
        },
      },
    });
  });

  it('registers command creation without model validation', async () => {
    const caller = router.createCaller(createContext());

    await caller.prepareSession({
      prompt: '/compact --aggressive',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      initialPayload: {
        type: 'command',
        command: 'compact',
        arguments: '--aggressive',
      },
    });

    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
    expect(startNewSessionMock).toHaveBeenCalledOnce();
    expect(createSessionWithLedgerMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
  });

  it('returns replayed true only when the ledger replays a settled create', async () => {
    createSessionWithLedgerMock.mockResolvedValueOnce({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      replayed: true,
    });
    const caller = router.createCaller(createContext());

    const result = await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
    });

    expect(result).toEqual({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      replayed: true,
    });
  });

  it('omits the replayed key on a fresh ledger create', async () => {
    const caller = router.createCaller(createContext());

    const result = await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
    });

    expect(result).toEqual({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
    });
    expect(result).not.toHaveProperty('replayed');
  });

  it('propagates the clone source through createSessionWithLedger and replays on a same-key retry', async () => {
    const caller = router.createCaller(createContext());
    const sourceKiloSessionId = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const organizationId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const profileId = '123e4567-e89b-12d3-a456-426614174011';
    mergeProfileConfigurationMock.mockResolvedValue({
      agents: [
        {
          slug: 'reviewer',
          name: 'Reviewer',
          config: { prompt: 'Review the diff', mode: 'subagent' },
        },
      ],
    });
    const input = {
      mode: 'reviewer',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
      cloneFromKiloSessionId: sourceKiloSessionId,
      kilocodeOrganizationId: organizationId,
      profileId,
      createdOnPlatform: 'cloud-agent-web',
    } as const;

    await caller.prepareSession(input);

    expect(createSessionWithLedgerMock).toHaveBeenCalledTimes(1);
    expect(createSessionWithLedgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialTurn: undefined,
        clone: { cloneFromKiloSessionId: sourceKiloSessionId },
      }),
      expect.objectContaining({ userId: 'test-user-123' }),
      expect.objectContaining({ operationKey: OPERATION_KEY })
    );
    expect(startNewSessionMock).not.toHaveBeenCalled();
    expect(registerNewSessionMock).not.toHaveBeenCalled();
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();

    // Same-key retry resumes: the ledger replays the settled clone create.
    createSessionWithLedgerMock.mockResolvedValueOnce({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      replayed: true,
    });
    const retry = await caller.prepareSession(input);

    expect(createSessionWithLedgerMock).toHaveBeenCalledTimes(2);
    expect(assertOrganizationMembershipMock).toHaveBeenCalledTimes(2);
    expect(assertBitbucketRepositoryAccessMock).toHaveBeenCalledTimes(2);
    expect(mergeProfileConfigurationMock).toHaveBeenCalledTimes(2);
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
    for (let call = 0; call < 2; call += 1) {
      expect(assertOrganizationMembershipMock.mock.invocationCallOrder[call]).toBeLessThan(
        assertBitbucketRepositoryAccessMock.mock.invocationCallOrder[call] ??
          Number.POSITIVE_INFINITY
      );
      expect(assertBitbucketRepositoryAccessMock.mock.invocationCallOrder[call]).toBeLessThan(
        mergeProfileConfigurationMock.mock.invocationCallOrder[call] ?? Number.POSITIVE_INFINITY
      );
      expect(mergeProfileConfigurationMock.mock.invocationCallOrder[call]).toBeLessThan(
        createSessionWithLedgerMock.mock.invocationCallOrder[call] ?? Number.POSITIVE_INFINITY
      );
    }
    expect(retry).toEqual({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      replayed: true,
    });

    mergeProfileConfigurationMock.mockResolvedValueOnce({});
    await expect(caller.prepareSession(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('does not match any runtimeAgents'),
    });
    expect(mergeProfileConfigurationMock).toHaveBeenCalledTimes(3);
    expect(createSessionWithLedgerMock).toHaveBeenCalledTimes(2);
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
  });

  it('repeats prompt preflight before ledger replay and blocks a mode removed from the profile', async () => {
    const caller = router.createCaller(createContext());
    const input = {
      prompt: 'Replay prompt creation',
      mode: 'reviewer',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
      kilocodeOrganizationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      profileId: '123e4567-e89b-12d3-a456-426614174011',
      createdOnPlatform: 'cloud-agent-web',
    } as const;
    mergeProfileConfigurationMock.mockResolvedValue({
      agents: [
        {
          slug: 'reviewer',
          name: 'Reviewer',
          config: { prompt: 'Review the diff', mode: 'subagent' },
        },
      ],
    });

    await caller.prepareSession(input);
    createSessionWithLedgerMock.mockResolvedValueOnce({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      replayed: true,
    });
    await expect(caller.prepareSession(input)).resolves.toMatchObject({ replayed: true });

    mergeProfileConfigurationMock.mockResolvedValueOnce({});
    await expect(caller.prepareSession(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('does not match any runtimeAgents'),
    });

    expect(assertOrganizationMembershipMock).toHaveBeenCalledTimes(3);
    expect(assertBitbucketRepositoryAccessMock).toHaveBeenCalledTimes(3);
    expect(mergeProfileConfigurationMock).toHaveBeenCalledTimes(3);
    expect(assertKiloModelAvailableMock).toHaveBeenCalledTimes(2);
    expect(createSessionWithLedgerMock).toHaveBeenCalledTimes(2);
    for (let call = 0; call < 2; call += 1) {
      expect(assertOrganizationMembershipMock.mock.invocationCallOrder[call]).toBeLessThan(
        assertBitbucketRepositoryAccessMock.mock.invocationCallOrder[call] ??
          Number.POSITIVE_INFINITY
      );
      expect(assertBitbucketRepositoryAccessMock.mock.invocationCallOrder[call]).toBeLessThan(
        mergeProfileConfigurationMock.mock.invocationCallOrder[call] ?? Number.POSITIVE_INFINITY
      );
      expect(mergeProfileConfigurationMock.mock.invocationCallOrder[call]).toBeLessThan(
        assertKiloModelAvailableMock.mock.invocationCallOrder[call] ?? Number.POSITIVE_INFINITY
      );
      expect(assertKiloModelAvailableMock.mock.invocationCallOrder[call]).toBeLessThan(
        createSessionWithLedgerMock.mock.invocationCallOrder[call] ?? Number.POSITIVE_INFINITY
      );
    }
  });

  it('repeats authorization before prompt ledger replay and rejects later repository access', async () => {
    const caller = router.createCaller(createContext());
    const input = {
      prompt: 'Replay authorization',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      operationKey: OPERATION_KEY,
      kilocodeOrganizationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      profileId: '123e4567-e89b-12d3-a456-426614174011',
      createdOnPlatform: 'cloud-agent-web',
    } as const;

    await caller.prepareSession(input);
    createSessionWithLedgerMock.mockResolvedValueOnce({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      replayed: true,
    });
    await expect(caller.prepareSession(input)).resolves.toMatchObject({ replayed: true });

    assertBitbucketRepositoryAccessMock.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Repository access rejected' })
    );
    await expect(caller.prepareSession(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(assertOrganizationMembershipMock).toHaveBeenCalledTimes(3);
    expect(assertBitbucketRepositoryAccessMock).toHaveBeenCalledTimes(3);
    expect(mergeProfileConfigurationMock).toHaveBeenCalledTimes(2);
    expect(assertKiloModelAvailableMock).toHaveBeenCalledTimes(2);
    expect(createSessionWithLedgerMock).toHaveBeenCalledTimes(2);
  });

  it('carries the repository environment and its merged configuration in the registration-only create request', async () => {
    const caller = router.createCaller(createContext());
    const environmentId = '123e4567-e89b-12d3-a456-426614174099';
    const layer = { envVars: { ENV_ONLY: 'from-environment' }, setupCommands: ['env-setup'] };
    loadEnvironmentForSessionMock.mockResolvedValueOnce({
      status: 'match',
      environment: environmentLoad(layer, environmentId),
    });
    mergeProfileConfigurationMock.mockResolvedValueOnce(layer);

    await caller.prepareSession({
      prompt: 'Use environment',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: false,
      createdOnPlatform: 'cloud-agent-web',
    });

    expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ environment: layer })
    );
    expect(registerNewSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: environmentLoad({}, environmentId).reference,
        profile: expect.objectContaining({
          resolved: expect.objectContaining({
            envVars: { ENV_ONLY: 'from-environment' },
            setupCommands: ['env-setup'],
          }),
        }),
      }),
      expect.objectContaining({ userId: 'test-user-123' }),
      { billingOrigin: 'cloud-agent-web' }
    );
  });
});
