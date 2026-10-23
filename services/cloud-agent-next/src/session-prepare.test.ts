import type * as CloudAgentProfile from '@kilocode/cloud-agent-profile';
import type * as SandboxPlacementModule from './sandbox-placement.js';
import type * as SessionIdentityModule from './session-identity.js';
import { TRPCError } from '@trpc/server';
import {
  getSandboxAllocationRequest,
  sandboxAllocationSchema,
} from '@kilocode/worker-utils/sandbox-allocation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schemas from './router/schemas.js';

const {
  generateSessionIdMock,
  selectControlPlaneSandboxMock,
  createCliSessionMock,
  deleteCliSessionMock,
  mergeProfileConfigurationMock,
  organizationMembershipLimitMock,
  assertKiloModelAvailableMock,
  getSandboxAllocationCandidatesMock,
} = vi.hoisted(() => ({
  generateSessionIdMock: vi.fn(() => 'workspace_12345678-1234-1234-1234-123456789abc'),
  selectControlPlaneSandboxMock: vi.fn(),
  createCliSessionMock: vi.fn().mockResolvedValue({ created: true }),
  deleteCliSessionMock: vi.fn().mockResolvedValue({ deleted: true }),
  mergeProfileConfigurationMock: vi.fn(),
  organizationMembershipLimitMock: vi.fn(),
  assertKiloModelAvailableMock: vi.fn(),
  getSandboxAllocationCandidatesMock: vi.fn(),
}));

vi.mock('@kilocode/cloud-agent-profile', async importActual => {
  const actual = await importActual<typeof CloudAgentProfile>();
  return {
    ...actual,
    mergeProfileConfiguration: mergeProfileConfigurationMock,
    getSandboxAllocationCandidates: getSandboxAllocationCandidatesMock,
  };
});

vi.mock('./db/pg.js', () => ({
  getPgDb: vi.fn(() => ({
    mockedDb: true,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), { limit: organizationMembershipLimitMock })
        ),
      })),
    })),
  })),
}));

vi.mock('./telemetry/session-reports.js', () => ({
  createCloudAgentSessionReport: vi.fn().mockResolvedValue(undefined),
  recordCloudAgentSandboxIdentity: vi.fn().mockResolvedValue(undefined),
  recordCloudAgentSessionFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./utils/kilo-session-id.js', () => ({
  generateKiloSessionId: vi.fn(() => 'cli-session-abc123'),
}));

vi.mock('./sandbox-placement.js', async importOriginal => {
  const actual = await importOriginal<typeof SandboxPlacementModule>();
  return {
    ...actual,
    selectControlPlaneSandbox: async (
      input: Parameters<typeof actual.selectControlPlaneSandbox>[0]
    ) => (await selectControlPlaneSandboxMock(input)) ?? actual.selectControlPlaneSandbox(input),
  };
});

vi.mock('./model-validation.js', () => ({
  assertKiloModelAvailable: assertKiloModelAvailableMock,
}));

vi.mock('./session-identity.js', async importOriginal => ({
  ...(await importOriginal<typeof SessionIdentityModule>()),
  generateSessionId: () => generateSessionIdMock(),
}));

import { appRouter } from './router.js';
import { profileResolutionPolicyForSessionCreateOrigin } from './router/handlers/session-creation-preflight.js';
import type { TRPCContext, SessionId } from './types.js';

function createMockDOStub(
  overrides: {
    registerSessionFromMetadata?: ReturnType<typeof vi.fn>;
    createSessionWithInitialAdmission?: ReturnType<typeof vi.fn>;
    tryUpdate?: ReturnType<typeof vi.fn>;
    getMetadata?: ReturnType<typeof vi.fn>;
    admitSubmittedMessage?: ReturnType<typeof vi.fn>;
  } = {}
) {
  return {
    registerSessionFromMetadata:
      overrides.registerSessionFromMetadata ?? vi.fn().mockResolvedValue({ success: true }),
    createSessionWithInitialAdmission:
      overrides.createSessionWithInitialAdmission ??
      vi.fn().mockResolvedValue({
        success: true,
        outcome: 'queued',
        compatibilityDelivery: 'queued',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      }),
    tryUpdate: overrides.tryUpdate ?? vi.fn().mockResolvedValue({ success: true }),
    getMetadata: overrides.getMetadata ?? vi.fn().mockResolvedValue(null),
    admitSubmittedMessage:
      overrides.admitSubmittedMessage ??
      vi.fn().mockResolvedValue({
        success: true,
        outcome: 'queued',
        compatibilityDelivery: 'queued',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      }),
    markAsInterrupted: vi.fn().mockResolvedValue(undefined),
    isInterrupted: vi.fn().mockResolvedValue(false),
    clearInterrupted: vi.fn().mockResolvedValue(undefined),
    updateKiloSessionId: vi.fn().mockResolvedValue(undefined),
  };
}

function createInternalApiContext(options: {
  userId?: string | null;
  authToken?: string | null;
  internalApiSecret?: string | null;
  requestInternalApiKey?: string | null;
  skipBalanceCheck?: boolean;
  credentialContainmentEnabled?: string;
  doStub?: ReturnType<typeof createMockDOStub>;
  getTokenForRepo?: ReturnType<typeof vi.fn>;
  getBitbucketToken?: ReturnType<typeof vi.fn>;
}): TRPCContext {
  const doStub = options.doStub ?? createMockDOStub();
  const effectiveUserId =
    options.userId === undefined
      ? 'test-user-123'
      : options.userId === null
        ? undefined
        : options.userId;
  const effectiveAuthToken =
    options.authToken === undefined
      ? 'test-auth-token'
      : options.authToken === null
        ? undefined
        : options.authToken;
  const effectiveInternalApiSecret =
    options.internalApiSecret === undefined
      ? 'test-internal-api-secret'
      : options.internalApiSecret === null
        ? undefined
        : options.internalApiSecret;
  const effectiveRequestInternalApiKey =
    options.requestInternalApiKey === undefined
      ? 'test-internal-api-secret'
      : options.requestInternalApiKey;

  const headers = new Headers();
  if (effectiveRequestInternalApiKey !== null) {
    headers.set('x-internal-api-key', effectiveRequestInternalApiKey);
  }
  if (options.skipBalanceCheck) {
    headers.set('x-skip-balance-check', 'true');
  }

  return {
    userId: effectiveUserId,
    authToken: effectiveAuthToken,
    request: { headers } as Request,
    env: {
      Sandbox: {} as TRPCContext['env']['Sandbox'],
      SandboxSmall: {} as TRPCContext['env']['SandboxSmall'],
      SANDBOX_SESSION: {
        idFromName: vi.fn((id: string) => ({ id })),
        get: vi.fn(() => doStub),
      } as unknown as TRPCContext['env']['SANDBOX_SESSION'],
      SESSION_INGEST: {
        fetch: vi.fn(),
        createSessionForCloudAgent: createCliSessionMock,
        deleteSessionForCloudAgent: deleteCliSessionMock,
      } as unknown as TRPCContext['env']['SESSION_INGEST'],
      INTERNAL_API_SECRET: effectiveInternalApiSecret,
      NEXTAUTH_SECRET: 'test-secret',
      R2_BUCKET: {} as TRPCContext['env']['R2_BUCKET'],
      R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID: 'fixture-access-key',
      R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: 'fixture-secret-key',
      R2_ENDPOINT: 'https://attachments.example.test',
      R2_ATTACHMENTS_BUCKET: 'attachments',
      CLOUD_AGENT_REPORT_QUEUE: {} as TRPCContext['env']['CLOUD_AGENT_REPORT_QUEUE'],
      GIT_TOKEN_SERVICE: {
        authorizeCloudAgentGitHubRepo:
          options.getTokenForRepo ?? vi.fn().mockResolvedValue({ success: true }),
        getTokenForRepo:
          options.getTokenForRepo ??
          vi.fn().mockResolvedValue({
            success: true,
            token: 'managed-github-token',
            installationId: '123',
            accountLogin: 'acme',
            appType: 'standard',
          }),
        getBitbucketToken:
          options.getBitbucketToken ??
          vi.fn().mockResolvedValue({ success: true, token: 'managed-bitbucket-token' }),
      } as unknown as TRPCContext['env']['GIT_TOKEN_SERVICE'],
      HYPERDRIVE: {
        connectionString: 'postgres://profile-test',
      } as TRPCContext['env']['HYPERDRIVE'],
      CREDENTIAL_CONTAINMENT_ENABLED: options.credentialContainmentEnabled,
    },
  } as TRPCContext;
}

describe('sandbox selection Worker API', () => {
  const orgId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const prepareInput = {
    prompt: 'Test prompt',
    mode: 'code',
    model: 'claude-3',
    githubRepo: 'acme/repo',
    kilocodeOrganizationId: orgId,
    sandboxAllocation: 'cloudflare-single' as const,
  };
  const startInput = {
    message: { prompt: 'Test prompt' },
    agent: { mode: 'code', model: 'claude-3' },
    repository: { type: 'github' as const, repo: 'acme/repo' },
    options: { kilocodeOrganizationId: orgId },
    runtime: { sandboxAllocation: 'cloudflare-single' as const },
  };
  const allocationInputs = sandboxAllocationSchema.options.flatMap(allocation => [
    { name: allocation, sandboxAllocation: allocation },
    {
      name: `structured ${allocation}`,
      sandboxAllocation: getSandboxAllocationRequest(allocation),
    },
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
    selectControlPlaneSandboxMock.mockReset();
    organizationMembershipLimitMock.mockResolvedValue([{ id: 'membership' }]);
    mergeProfileConfigurationMock.mockResolvedValue({});
    assertKiloModelAvailableMock.mockResolvedValue(undefined);
    getSandboxAllocationCandidatesMock.mockResolvedValue({});
  });

  it('requires authentication for capability discovery', async () => {
    const caller = appRouter.createCaller(
      createInternalApiContext({ userId: null, authToken: null })
    );
    await expect(
      caller.getSandboxSelectionOptions({ kilocodeOrganizationId: orgId })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(organizationMembershipLimitMock).not.toHaveBeenCalled();
  });

  it.each(allocationInputs)(
    'requires membership for $name even for disabled options and skip-balance callers',
    async ({ sandboxAllocation }) => {
      organizationMembershipLimitMock.mockResolvedValue([]);
      const caller = appRouter.createCaller(createInternalApiContext({ skipBalanceCheck: true }));
      await expect(
        caller.getSandboxSelectionOptions({ kilocodeOrganizationId: orgId })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller.prepareSession({ ...prepareInput, sandboxAllocation })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller.start({ ...startInput, runtime: { sandboxAllocation } })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
      expect(createCliSessionMock).not.toHaveBeenCalled();
    }
  );

  it('exposes only authoritative capability options and keeps the disabled result empty', async () => {
    const ctx = createInternalApiContext({});
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.getSandboxSelectionOptions({ kilocodeOrganizationId: orgId })
    ).resolves.toMatchObject({ enabled: false, options: [] });
    ctx.env.SANDBOX_SELECTION_IDS = orgId;
    const result = await caller.getSandboxSelectionOptions({ kilocodeOrganizationId: orgId });
    expect(result.enabled).toBe(true);
    expect(
      result.options
        .filter(option => option.unavailableReason === undefined)
        .map(option => option.allocation)
    ).toEqual([
      getSandboxAllocationRequest('cloudflare-containers-standard-3'),
      getSandboxAllocationRequest('cloudflare-shared'),
    ]);
  });

  it.each(allocationInputs)(
    'rejects $name in prepare and public start when selection is disabled',
    async ({ sandboxAllocation }) => {
      const caller = appRouter.createCaller(createInternalApiContext({ skipBalanceCheck: true }));
      await expect(
        caller.prepareSession({ ...prepareInput, sandboxAllocation })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller.start({ ...startInput, runtime: { sandboxAllocation } })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(createCliSessionMock).not.toHaveBeenCalled();
      expect(selectControlPlaneSandboxMock).not.toHaveBeenCalled();
    }
  );

  it('reports the default destination even when selection is disabled', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({}));
    const result = await caller.getSandboxSelectionOptions({ kilocodeOrganizationId: orgId });
    expect(result).toMatchObject({
      enabled: false,
      options: [],
      defaultDestination: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
    });
    expect(result.effectiveDestination).toBeUndefined();
  });

  describe('effective destination', () => {
    const enrolledCaller = (owner: 'org' | 'personal' = 'org') => {
      const ctx = createInternalApiContext({});
      ctx.env.SANDBOX_SELECTION_IDS = owner === 'org' ? orgId : 'test-user-123';
      return appRouter.createCaller(ctx);
    };
    const input = {
      kilocodeOrganizationId: orgId,
      repositoryType: 'github' as const,
      repositoryFullName: 'Acme/Repo',
    };

    it('falls back to the default destination when nothing is saved', async () => {
      const result = await enrolledCaller().getSandboxSelectionOptions(input);
      expect(result.effectiveDestination).toEqual(result.defaultDestination);
    });

    it('prefers the repository override over the owner default', async () => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        repositoryAllocation: 'cloudflare-shared',
        contextAllocation: 'cloudflare-single',
      });
      const result = await enrolledCaller().getSandboxSelectionOptions(input);
      expect(result.effectiveDestination).toEqual(getSandboxAllocationRequest('cloudflare-shared'));
      expect(getSandboxAllocationCandidatesMock).toHaveBeenCalledWith(
        expect.anything(),
        { type: 'organization', id: orgId },
        { platform: 'github', fullName: 'Acme/Repo' }
      );
    });

    it('skips a saved allocation that is unavailable', async () => {
      getSandboxAllocationCandidatesMock.mockResolvedValue({
        repositoryAllocation: 'vercel-small',
        contextAllocation: 'cloudflare-shared',
      });
      const result = await enrolledCaller().getSandboxSelectionOptions({
        ...input,
        repositoryType: 'gitlab',
      });
      expect(result.effectiveDestination).toEqual(getSandboxAllocationRequest('cloudflare-shared'));
    });

    it('is not computed without a repository type', async () => {
      const result = await enrolledCaller().getSandboxSelectionOptions({
        kilocodeOrganizationId: orgId,
      });
      expect(result.effectiveDestination).toBeUndefined();
      expect(getSandboxAllocationCandidatesMock).not.toHaveBeenCalled();
    });
  });

  it('exposes personal capabilities without membership when the user is enrolled', async () => {
    const ctx = createInternalApiContext({});
    ctx.env.SANDBOX_SELECTION_IDS = 'test-user-123';
    const caller = appRouter.createCaller(ctx);
    const result = await caller.getSandboxSelectionOptions({});
    expect(result.enabled).toBe(true);
    expect(organizationMembershipLimitMock).not.toHaveBeenCalled();
  });

  it.each(allocationInputs)(
    'rejects personal $name when only an organization is enrolled',
    async ({ sandboxAllocation }) => {
      const ctx = createInternalApiContext({ skipBalanceCheck: true });
      ctx.env.SANDBOX_SELECTION_IDS = orgId;
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.prepareSession({
          ...prepareInput,
          kilocodeOrganizationId: undefined,
          sandboxAllocation,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller.start({ ...startInput, options: {}, runtime: { sandboxAllocation } })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(createCliSessionMock).not.toHaveBeenCalled();
      expect(selectControlPlaneSandboxMock).not.toHaveBeenCalled();
    }
  );

  it.each(['*', 'test-user-123'] as const)(
    'authorizes personal Cloudflare allocation when SANDBOX_SELECTION_IDS is %s',
    async allowlist => {
      const doStub = createMockDOStub();
      const ctx = createInternalApiContext({ doStub, skipBalanceCheck: true });
      ctx.env.SANDBOX_SELECTION_IDS = allowlist;
      generateSessionIdMock.mockReturnValue('workspace_12345678-1234-1234-1234-123456789abc');
      const caller = appRouter.createCaller(ctx);
      await caller.prepareSession({
        ...prepareInput,
        kilocodeOrganizationId: undefined,
        sandboxAllocation: 'cloudflare-single',
      });
      await caller.start({
        ...startInput,
        options: {},
        runtime: { sandboxAllocation: 'cloudflare-single' },
      });
      expect(doStub.registerSessionFromMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            workspace: expect.objectContaining({
              sandboxAllocation: 'cloudflare-containers-standard-3',
            }),
          }),
        })
      );
      expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            workspace: expect.objectContaining({
              sandboxAllocation: 'cloudflare-containers-standard-3',
            }),
          }),
        })
      );
    }
  );

  it.each([orgId, undefined])(
    'ignores retired selection context for owner %s without allocating',
    async kilocodeOrganizationId => {
      const ctx = createInternalApiContext({});
      ctx.env.SANDBOX_SELECTION_IDS = '*';
      ctx.env.PER_SESSION_SANDBOX_ORG_IDS = '*';
      const caller = appRouter.createCaller(ctx);
      const normal = await caller.getSandboxSelectionOptions({ kilocodeOrganizationId });
      expect(normal.defaultDestination).toEqual(
        getSandboxAllocationRequest('cloudflare-containers-standard-3')
      );
      for (const devcontainer of [false, true]) {
        expect(
          await caller.getSandboxSelectionOptions({ kilocodeOrganizationId, devcontainer })
        ).toEqual(normal);
      }
      expect(generateSessionIdMock).not.toHaveBeenCalled();
      expect(selectControlPlaneSandboxMock).not.toHaveBeenCalled();
      expect(createCliSessionMock).not.toHaveBeenCalled();
    }
  );

  it.each(['small', 'large'] as const)(
    'rejects BYOC %s before allocation side effects',
    async instanceType => {
      const ctx = createInternalApiContext({ skipBalanceCheck: true });
      ctx.env.SANDBOX_SELECTION_IDS = orgId;
      const caller = appRouter.createCaller(ctx);
      const sandboxAllocation = {
        provider: { id: 'vercel', account: 'byoc' },
        instanceType,
      } as const;
      await expect(
        caller.prepareSession({ ...prepareInput, sandboxAllocation })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('BYOC'),
      });
      await expect(
        caller.start({ ...startInput, runtime: { sandboxAllocation } })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('BYOC'),
      });
      expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
      expect(createCliSessionMock).not.toHaveBeenCalled();
      expect(selectControlPlaneSandboxMock).not.toHaveBeenCalled();
    }
  );

  it('authorizes Dedicated Standard in public start without an internal API key', async () => {
    const doStub = createMockDOStub();
    const ctx = createInternalApiContext({ doStub, requestInternalApiKey: null });
    ctx.env.SANDBOX_SELECTION_IDS = orgId;
    generateSessionIdMock.mockReturnValue('workspace_12345678-1234-1234-1234-123456789abc');
    await appRouter.createCaller(ctx).start({
      ...startInput,
      runtime: { sandboxAllocation: 'isolated-standard' },
    });
    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          identity: expect.objectContaining({ orgId }),
          workspace: expect.objectContaining({ sandboxAllocation: 'isolated-standard' }),
        }),
      })
    );
  });

  it.each(['legacy', 'structured'] as const)(
    'keeps canonical workspace metadata for authorized %s starts and prepares',
    async format => {
      const doStub = createMockDOStub();
      const ctx = createInternalApiContext({ doStub });
      ctx.env.SANDBOX_SELECTION_IDS = orgId;
      generateSessionIdMock.mockReturnValue('workspace_12345678-1234-1234-1234-123456789abc');
      const sandboxAllocation =
        format === 'legacy'
          ? 'cloudflare-single'
          : getSandboxAllocationRequest('cloudflare-single');
      const caller = appRouter.createCaller(ctx);
      await caller.start({ ...startInput, runtime: { sandboxAllocation } });
      await caller.prepareSession({ ...prepareInput, sandboxAllocation });
      const metadata = expect.objectContaining({
        workspace: expect.objectContaining({
          sandboxAllocation: 'cloudflare-containers-standard-3',
          sandboxProvider: 'cloudflare-containers',
        }),
      });
      expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
        expect.objectContaining({ metadata })
      );
      expect(doStub.registerSessionFromMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ metadata })
      );
    }
  );
});

describe('effective session profile policy', () => {
  it.each([
    { origin: 'cloud-agent-web', expected: 'include-web-defaults' },
    { origin: 'slack', expected: 'include-web-defaults' },
    { origin: 'github', expected: 'include-web-defaults' },
    { origin: 'linear', expected: 'include-web-defaults' },
    { origin: 'discord', expected: 'include-web-defaults' },
    { origin: 'webhook', expected: 'include-web-defaults' },
    { origin: 'scheduled', expected: 'include-web-defaults' },
    { origin: undefined, expected: 'explicit-profile-only' },
    { origin: '', expected: 'explicit-profile-only' },
    { origin: 'unknown', expected: 'explicit-profile-only' },
    { origin: 'Slack', expected: 'explicit-profile-only' },
    { origin: 'code-review', expected: 'explicit-profile-only' },
    { origin: 'security-agent', expected: 'explicit-profile-only' },
  ])('selects $expected for origin $origin', ({ origin, expected }) => {
    expect(profileResolutionPolicyForSessionCreateOrigin(origin)).toEqual({
      defaultProfileResolution: expected,
    });
  });
});

describe('prepareSession endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectControlPlaneSandboxMock.mockReset();
    generateSessionIdMock.mockReturnValue('workspace_12345678-1234-1234-1234-123456789abc');
    createCliSessionMock.mockResolvedValue({ created: true });
    deleteCliSessionMock.mockResolvedValue({ deleted: true });
    mergeProfileConfigurationMock.mockResolvedValue({});
    organizationMembershipLimitMock.mockResolvedValue([{ id: 'membership-123' }]);
    assertKiloModelAvailableMock.mockResolvedValue(undefined);
  });

  it('rejects request without internal API key header', async () => {
    const caller = appRouter.createCaller(
      createInternalApiContext({ requestInternalApiKey: null })
    );

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('Invalid or missing internal API key');
  });

  it('rejects an incorrect internal API key of a different length', async () => {
    const caller = appRouter.createCaller(
      createInternalApiContext({ requestInternalApiKey: 'wrong' })
    );

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('Invalid or missing internal API key');
  });

  it('rejects request without customer token', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({ userId: null }));

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('Invalid customer token');
  });

  it('rejects an unavailable model before registration or auto-initiation', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));
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
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(createCliSessionMock).not.toHaveBeenCalled();
    expect(doStub.registerSessionFromMetadata).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
  });

  it.each([
    {
      origin: 'cloud-agent-web',
      repository: { githubRepo: 'acme/github-repo' },
      expectedRepoFullName: 'acme/github-repo',
      expectedPlatform: 'github',
    },
    {
      origin: 'slack',
      repository: { githubRepo: 'acme/slack-repo' },
      expectedRepoFullName: 'acme/slack-repo',
      expectedPlatform: 'github',
    },
    {
      origin: 'linear',
      repository: {
        gitUrl: 'https://gitlab.com/acme/linear-repo.git',
        platform: 'gitlab' as const,
      },
      expectedRepoFullName: 'acme/linear-repo',
      expectedPlatform: 'gitlab',
    },
    {
      origin: 'slack',
      repository: {
        gitUrl: 'https://gitlab.example.com/acme/subgroup/slack-repo.git',
        platform: 'gitlab' as const,
      },
      expectedRepoFullName: 'acme/subgroup/slack-repo',
      expectedPlatform: 'gitlab',
    },
  ])(
    'resolves implicit profiles for approved $origin creation',
    async ({ origin, repository, expectedRepoFullName, expectedPlatform }) => {
      const caller = appRouter.createCaller(createInternalApiContext({}));

      await caller.prepareSession({
        prompt: 'Implicit profile',
        mode: 'code',
        model: 'claude-3',
        ...repository,
        createdOnPlatform: origin,
      });

      expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          profileId: undefined,
          owner: { type: 'user', id: 'test-user-123' },
          repoFullName: expectedRepoFullName,
          platform: expectedPlatform,
        })
      );
    }
  );

  it.each([{ origin: undefined }, { origin: 'unknown' }])(
    'does not resolve implicit profiles for non-approved origin $origin',
    async ({ origin }) => {
      const caller = appRouter.createCaller(createInternalApiContext({}));

      await caller.prepareSession({
        prompt: 'Other platform',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        createdOnPlatform: origin,
      });

      expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
    }
  );

  it('resolves an explicit profile for non-web creation and passes inline overrides', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({}));
    const profileId = '123e4567-e89b-12d3-a456-426614174011';

    await caller.prepareSession({
      prompt: 'Explicit profile',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      createdOnPlatform: 'code-review',
      profileId,
      envVars: { INLINE: 'wins' },
      setupCommands: ['pnpm install'],
    });

    expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profileId,
        envVars: { INLINE: 'wins' },
        setupCommands: ['pnpm install'],
      })
    );
  });

  it('registers full lazy-prep metadata in one DO call', async () => {
    selectControlPlaneSandboxMock.mockResolvedValueOnce({
      kind: 'isolated',
      sandboxId: 'crv-abcdef',
    });
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    const result = await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'plan',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      githubToken: 'ghp_token',
      envVars: { API_KEY: 'secret' },
      setupCommands: ['npm install'],
      mcpServers: { test: { type: 'local', command: ['npx', 'test-server'] } },
      upstreamBranch: 'feature/test-branch',
      autoCommit: true,
      condenseOnComplete: true,
      appendSystemPrompt: 'extra rules',
      callbackTarget: { url: 'https://example.com/callback' },
      createdOnPlatform: 'code-review',
      shallow: true,
      gateThreshold: 'warning',
      kilocodeOrganizationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    });

    expect(result).toEqual({
      cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
    });
    expect(createCliSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cli-session-abc123',
        cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
        kiloUserId: 'test-user-123',
        organizationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        profileId: undefined,
        createdOnPlatform: 'code-review',
        title: expect.stringMatching(/^New session - /),
        gitUrl: 'https://github.com/acme/repo',
        cloneFromKiloSessionId: undefined,
      })
    );
    expect(doStub.registerSessionFromMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          identity: expect.objectContaining({
            sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
            userId: 'test-user-123',
            orgId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            botId: undefined,
            createdOnPlatform: 'code-review',
            billingOrigin: 'code-review',
          }),
          auth: { kiloSessionId: 'cli-session-abc123', kilocodeToken: 'test-auth-token' },
          initialMessage: expect.objectContaining({
            id: expect.stringMatching(/^msg_/) as unknown,
            turn: expect.objectContaining({
              type: 'prompt',
              prompt: 'Test prompt',
              attachments: undefined,
            }),
          }),
          agent: expect.objectContaining({
            mode: 'plan',
            model: 'claude-3',
            variant: undefined,
            appendSystemPrompt: 'extra rules',
          }),
          repository: expect.objectContaining({
            type: 'github',
            repo: 'acme/repo',
            upstreamBranch: 'feature/test-branch',
            githubAccessPurpose: 'workflow',
          }),
          profile: expect.objectContaining({
            envVars: { API_KEY: 'secret' },
            setupCommands: ['npm install'],
            mcpServers: { test: { type: 'local', command: ['npx', 'test-server'] } },
          }),
          finalization: { autoCommit: true, condenseOnComplete: true, gateThreshold: 'warning' },
          callback: { target: { url: 'https://example.com/callback' } },
          workspace: expect.objectContaining({
            sandboxId: 'crv-abcdef',
            sandboxProvider: 'cloudflare',
            shallow: true,
            credentialContainment: {
              github: true,
              gitlab: false,
              bitbucket: false,
              kilocode: true,
            },
          }),
        }),
      })
    );
  });

  it('persists the resolved profile id on the created session, not the requested one', async () => {
    mergeProfileConfigurationMock.mockResolvedValue({ resolvedProfileId: 'profile-abc123' });
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      profileId: 'a1111111-1111-4111-8111-111111111111',
      createdOnPlatform: 'cloud-agent-web',
    });

    expect(createCliSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.any(String),
        cloudAgentSessionId: expect.any(String),
        kiloUserId: 'test-user-123',
        organizationId: undefined,
        profileId: 'profile-abc123',
        createdOnPlatform: 'cloud-agent-web',
        title: expect.stringMatching(/^New session - /),
        gitUrl: 'https://github.com/acme/repo',
        cloneFromKiloSessionId: undefined,
      })
    );
  });

  it('projects resolved instruction files into registered profile metadata', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));
    mergeProfileConfigurationMock.mockResolvedValue({
      instructions: [{ name: 'repo-rules', content: 'Follow the repository policy' }],
    });

    await caller.prepareSession({
      prompt: 'Test prompt',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      createdOnPlatform: 'cloud-agent-web',
    });

    expect(doStub.registerSessionFromMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          profile: expect.objectContaining({
            runtimeInstructions: [{ name: 'repo-rules', content: 'Follow the repository policy' }],
          }),
        }),
      })
    );
  });

  it('rejects organization attribution when the internal caller user is not a member', async () => {
    organizationMembershipLimitMock.mockResolvedValueOnce([]);
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.prepareSession({
        prompt: 'Attempt unrelated organization attribution',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        kilocodeOrganizationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(doStub.registerSessionFromMetadata).not.toHaveBeenCalled();
  });

  it('retains split legacy preparation as registration-only', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.prepareSession({
      prompt: 'Prepare without initiation',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: false,
    });

    expect(doStub.registerSessionFromMetadata).toHaveBeenCalledOnce();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
  });

  it('registers GitLab repository metadata without caller gitToken', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.prepareSession({
      prompt: 'Test GitLab prompt',
      mode: 'code',
      model: 'claude-3',
      gitUrl: 'https://gitlab.com/acme/repo.git',
      gitToken: 'caller-gitlab-token',
      platform: 'gitlab',
      upstreamBranch: 'feature/gitlab',
    });

    expect(doStub.registerSessionFromMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          repository: expect.objectContaining({
            type: 'gitlab',
            url: 'https://gitlab.com/acme/repo.git',
            upstreamBranch: 'feature/gitlab',
          }),
        }),
      })
    );
  });

  it('persists generic GitLab review origin and repository context without a caller token', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.prepareSession({
      prompt: 'Test GitLab review prompt',
      mode: 'code',
      model: 'claude-3',
      gitUrl: 'https://gitlab.com/acme/repo.git',
      gitToken: 'caller-gitlab-token',
      platform: 'gitlab',
      createdOnPlatform: 'code-review',
      upstreamBranch: 'feature/gitlab',
    });

    expect(doStub.registerSessionFromMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          identity: expect.objectContaining({ createdOnPlatform: 'code-review' }),
          repository: expect.objectContaining({
            type: 'gitlab',
            url: 'https://gitlab.com/acme/repo.git',
            upstreamBranch: 'feature/gitlab',
          }),
        }),
      })
    );
    expect(
      doStub.registerSessionFromMetadata.mock.calls[0]?.[0].metadata.repository
    ).not.toHaveProperty('token');
  });

  it('persists only generic Bitbucket repository identity after access preflight', async () => {
    const doStub = createMockDOStub();
    const getBitbucketToken = vi
      .fn()
      .mockResolvedValue({ success: true, token: 'managed-bitbucket-token' });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub, getBitbucketToken }));
    const reviewId = '123e4567-e89b-12d3-a456-426614174023';
    const integrationId = '123e4567-e89b-12d3-a456-426614174022';
    const organizationId = '123e4567-e89b-12d3-a456-426614174030';

    await caller.prepareSession({
      prompt: 'Test Bitbucket review prompt',
      mode: 'code',
      model: 'claude-3',
      gitUrl: 'https://bitbucket.org/acme/repo.git',
      platform: 'bitbucket',
      bitbucketWorkspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      bitbucketWorkspaceSlug: 'acme',
      bitbucketRepositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      bitbucketRepositorySlug: 'repo',
      bitbucketIntegrationId: integrationId,
      bitbucketPullRequestId: 42,
      bitbucketExpectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      kilocodeOrganizationId: organizationId,
      createdOnPlatform: 'code-review',
      callbackTarget: {
        url: `https://kilo.example/api/internal/code-review-status/${reviewId}?attemptId=attempt-1`,
      },
      upstreamBranch: 'feature/bitbucket',
    });

    expect(getBitbucketToken).toHaveBeenCalledWith({
      userId: 'test-user-123',
      orgId: organizationId,
      expectedIntegrationId: integrationId,
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      repositoryUrl: 'https://bitbucket.org/acme/repo.git',
    });
    expect(doStub.registerSessionFromMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          identity: expect.objectContaining({
            orgId: organizationId,
            createdOnPlatform: 'code-review',
          }),
          workspace: expect.objectContaining({
            credentialContainment: {
              github: false,
              gitlab: false,
              bitbucket: true,
              kilocode: true,
            },
          }),
          repository: expect.objectContaining({
            type: 'bitbucket',
            url: 'https://bitbucket.org/acme/repo.git',
            workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
            repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
            bitbucketIntegrationId: integrationId,
            upstreamBranch: 'feature/bitbucket',
          }),
        }),
      })
    );
    expect(
      doStub.registerSessionFromMetadata.mock.calls[0]?.[0].metadata.repository
    ).not.toHaveProperty('token');
  });

  it('preserves caller gitToken for generic git repositories', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.prepareSession({
      prompt: 'Test generic git prompt',
      mode: 'code',
      model: 'claude-3',
      gitUrl: 'https://git.example.com/acme/repo.git',
      gitToken: 'generic-git-token',
      upstreamBranch: 'feature/generic',
    });

    expect(doStub.registerSessionFromMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          repository: expect.objectContaining({
            type: 'git',
            url: 'https://git.example.com/acme/repo.git',
            token: 'generic-git-token',
            upstreamBranch: 'feature/generic',
          }),
        }),
      })
    );
  });

  it('auto-initiates through grouped creation with canonicalized legacy initial attachments', async () => {
    const initialMessageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
    const images = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.png'],
    };
    const createSessionWithInitialAdmission = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: initialMessageId,
    });
    const doStub = createMockDOStub({ createSessionWithInitialAdmission });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.prepareSession({
      prompt: 'Inspect the screenshot',
      images,
      initialMessageId,
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
    });

    expect(createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          initialMessage: expect.objectContaining({
            turn: expect.objectContaining({
              type: 'prompt',
              prompt: 'Inspect the screenshot',
              attachments: images,
            }),
            id: initialMessageId,
          }),
        }),
      })
    );
    expect(doStub.registerSessionFromMetadata).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
  });

  it('stores one neutral shared allocation across session IDs and ignores retired KV suffixes', async () => {
    const overrideStore = { get: vi.fn().mockResolvedValue('shared-slot-v1'), put: vi.fn() };
    const doStub = createMockDOStub();
    const context = createInternalApiContext({ doStub });
    context.env.SANDBOX_SELECTION_IDS = '*';
    Object.assign(context.env, { SHARED_SANDBOX_OVERRIDES: overrideStore });
    const caller = appRouter.createCaller(context);
    const input = {
      message: { prompt: 'Use the shared allocation' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github' as const, repo: 'acme/repo' },
      runtime: { sandboxAllocation: 'cloudflare-shared' as const },
    };
    await caller.start(input);
    generateSessionIdMock.mockReturnValueOnce('workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    await caller.start(input);
    const first = doStub.createSessionWithInitialAdmission.mock.calls[0]?.[0];
    const second = doStub.createSessionWithInitialAdmission.mock.calls[1]?.[0];
    expect(first.metadata.workspace).toMatchObject({
      sandboxId: expect.stringMatching(/^sbx-[a-f0-9]{48}$/),
      sandboxKind: 'shared',
      sandboxProvider: 'cloudflare',
      sandboxAllocation: 'cloudflare-shared',
    });
    expect(second.metadata.workspace.sandboxId).toBe(first.metadata.workspace.sandboxId);
    expect(first.metadata.workspace).not.toHaveProperty('sandboxRoute');
    expect(overrideStore.get).not.toHaveBeenCalled();
  });

  it('does not let public createdOnPlatform select the Code Review sandbox class', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.start({
      message: { prompt: 'Attempt to select a reserved class' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'acme/repo' },
      profile: { id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
      options: { createdOnPlatform: 'code-review' },
    });

    expect(selectControlPlaneSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-123',
        orgId: undefined,
        sessionId: expect.any(String),
      })
    );
    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          identity: expect.objectContaining({ billingOrigin: 'cloud-agent' }),
        }),
      })
    );
  });

  it('rejects retired devcontainer sessions before allocation or registration', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.prepareSession({
        prompt: 'Prepare the devcontainer runtime',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        devcontainer: true,
      })
    ).rejects.toThrow('Devcontainer support has been retired');

    expect(selectControlPlaneSandboxMock).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    expect(doStub.registerSessionFromMetadata).not.toHaveBeenCalled();
  });

  it('enables containment when the global flag is true', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(
      createInternalApiContext({ doStub, credentialContainmentEnabled: 'true' })
    );

    await caller.prepareSession({
      prompt: 'Test containment',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'Kilo-Org/kg',
      autoInitiate: true,
    });

    expect(selectControlPlaneSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-123',
        orgId: undefined,
        sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
      })
    );
    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspace: expect.objectContaining({
            credentialContainment: {
              github: true,
              gitlab: false,
              bitbucket: false,
              kilocode: true,
            },
          }),
        }),
      })
    );
  });

  it.each([
    [`sbx-${'a'.repeat(48)}`, undefined, undefined],
    [`sbx-${'b'.repeat(48)}`, 'cloudflare-single', undefined],
    [`sbx-${'c'.repeat(48)}`, undefined, 'code-review'],
  ] as const)(
    'persists the generated %s identity unchanged with containment disabled',
    async (sandboxId, sandboxAllocation, createdOnPlatform) => {
      selectControlPlaneSandboxMock.mockResolvedValueOnce({
        sandboxKind: createdOnPlatform === 'code-review' ? 'code-review' : 'isolated',
        sandboxId,
        provider: 'cloudflare',
      });
      const doStub = createMockDOStub();
      const ctx = createInternalApiContext({ doStub, credentialContainmentEnabled: 'false' });
      ctx.env.SANDBOX_SELECTION_IDS = '*';
      await appRouter.createCaller(ctx).prepareSession({
        prompt: 'Create a non-contained session',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        sandboxAllocation,
        createdOnPlatform,
      });
      expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            workspace: expect.objectContaining({
              sandboxId,
              sandboxProvider: 'cloudflare',
              ...(sandboxAllocation ? { sandboxAllocation } : {}),
              credentialContainment: {
                github: false,
                gitlab: false,
                bitbucket: false,
                kilocode: false,
              },
            }),
          }),
        })
      );
    }
  );

  it('disables all containment when the global flag is false', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(
      createInternalApiContext({ doStub, credentialContainmentEnabled: 'false' })
    );

    await caller.prepareSession({
      prompt: 'Test containment disabled',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'Kilo-Org/kg',
    });

    expect(doStub.registerSessionFromMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspace: expect.objectContaining({
            credentialContainment: {
              github: false,
              gitlab: false,
              bitbucket: false,
              kilocode: false,
            },
          }),
        }),
      })
    );
  });

  it('enables containment for standard GitLab sessions', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.prepareSession({
      prompt: 'Test GitLab containment',
      mode: 'code',
      model: 'claude-3',
      gitUrl: 'https://gitlab.com/acme/repo.git',
      platform: 'gitlab',
      autoInitiate: true,
    });

    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspace: expect.objectContaining({
            credentialContainment: {
              github: false,
              gitlab: true,
              bitbucket: false,
              kilocode: true,
            },
          }),
        }),
      })
    );
  });

  it('enables containment for personal GitHub sessions without an organization', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.prepareSession({
      prompt: 'Test containment',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'Kilo-Org/kg',
      autoInitiate: true,
    });

    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspace: expect.objectContaining({
            credentialContainment: {
              github: true,
              gitlab: false,
              bitbucket: false,
              kilocode: true,
            },
          }),
        }),
      })
    );
  });

  it('rejects devcontainer preparation without auto-initiation', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.prepareSession({
        prompt: 'Prepare the devcontainer runtime',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        autoInitiate: false,
        devcontainer: true,
      })
    ).rejects.toThrow('Devcontainer support has been retired');

    expect(doStub.registerSessionFromMetadata).not.toHaveBeenCalled();
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
  });

  it('auto-initiates command-valued initialPayload through grouped canonical admission', async () => {
    const initialMessageId = 'msg_018f1e2d3c4bInitCmdAbCdEfG';
    const createSessionWithInitialAdmission = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: initialMessageId,
    });
    const doStub = createMockDOStub({ createSessionWithInitialAdmission });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.prepareSession({
      prompt: '/compact --aggressive',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      initialMessageId,
      initialPayload: {
        type: 'command',
        command: 'compact',
        arguments: '--aggressive',
      },
    });

    expect(createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          initialMessage: expect.objectContaining({
            turn: expect.objectContaining({
              type: 'command',
              command: 'compact',
              arguments: '--aggressive',
            }),
            id: initialMessageId,
          }),
        }),
      })
    );
    expect(doStub.registerSessionFromMetadata).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
  });

  it('rejects command-valued initialPayload attachments before registration', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.prepareSession({
        prompt: '/compact --aggressive',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        attachments: {
          path: '123e4567-e89b-12d3-a456-426614174000',
          files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
        },
        initialPayload: {
          type: 'command',
          command: 'compact',
          arguments: '--aggressive',
        },
      })
    ).rejects.toThrow('Attachments cannot be attached to slash commands');

    expect(doStub.registerSessionFromMetadata).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
  });

  it('returns a prepared session after metadata registration', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({}));

    const result = await caller.prepareSession({
      prompt: 'Prepare even if reporting is unavailable',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
    });

    expect(result).toMatchObject({
      cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
    });
  });

  it('preserves a split preparation registration rejection', async () => {
    const doStub = createMockDOStub({
      registerSessionFromMetadata: vi
        .fn()
        .mockResolvedValue({ success: false, error: 'Registration rejected' }),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.prepareSession({
        prompt: 'Reject even if reporting is unavailable',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('Registration rejected');
  });

  it('preserves an unknown split preparation outcome', async () => {
    const doStub = createMockDOStub({
      registerSessionFromMetadata: vi
        .fn()
        .mockRejectedValue(new Error('unknown registration outcome')),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.prepareSession({
        prompt: 'Unknown even if reporting is unavailable',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('unknown registration outcome');
  });

  it('attempts best-effort ownership-row compensation on explicit registration rejection', async () => {
    const doStub = createMockDOStub({
      registerSessionFromMetadata: vi
        .fn()
        .mockResolvedValue({ success: false, error: 'Registration rejected' }),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('Registration rejected');

    expect(deleteCliSessionMock).toHaveBeenCalledWith({
      sessionId: 'cli-session-abc123',
      kiloUserId: 'test-user-123',
      ...{ onlyIfEmpty: true },
    });
    expect(doStub.registerSessionFromMetadata).toHaveBeenCalledTimes(1);
  });

  it('does not record compensation when empty-only ownership deletion declines deletion', async () => {
    deleteCliSessionMock.mockResolvedValueOnce({ deleted: false });
    const doStub = createMockDOStub({
      registerSessionFromMetadata: vi
        .fn()
        .mockResolvedValue({ success: false, error: 'Registration rejected' }),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.prepareSession({
        prompt: 'Do not erase non-empty ownership',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('Registration rejected');

    expect(deleteCliSessionMock).toHaveBeenCalled();
  });

  it('retries idempotent registration without compensating an unknown committed state', async () => {
    const retryableError = Object.assign(new Error('registration response lost'), {
      retryable: true,
    });
    const registerSessionFromMetadata = vi.fn().mockRejectedValue(retryableError);
    const caller = appRouter.createCaller(
      createInternalApiContext({ doStub: createMockDOStub({ registerSessionFromMetadata }) })
    );

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('registration response lost');

    expect(registerSessionFromMetadata).toHaveBeenCalledTimes(3);
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
  });

  it('retains ownership state when registration outcome remains unknown', async () => {
    const registerSessionFromMetadata = vi
      .fn()
      .mockRejectedValue(new Error('unknown registration outcome'));
    const caller = appRouter.createCaller(
      createInternalApiContext({ doStub: createMockDOStub({ registerSessionFromMetadata }) })
    );

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('unknown registration outcome');

    expect(registerSessionFromMetadata).toHaveBeenCalledTimes(1);
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
  });
});

describe('start endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectControlPlaneSandboxMock.mockReset();
    generateSessionIdMock.mockReturnValue('workspace_12345678-1234-1234-1234-123456789abc');
    createCliSessionMock.mockResolvedValue({ created: true });
    deleteCliSessionMock.mockResolvedValue({ deleted: true });
    mergeProfileConfigurationMock.mockResolvedValue({});
    organizationMembershipLimitMock.mockResolvedValue([{ id: 'membership-123' }]);
    assertKiloModelAvailableMock.mockResolvedValue(undefined);
  });

  it('rejects non-member organization profile resolution when balance validation is skipped', async () => {
    organizationMembershipLimitMock.mockResolvedValueOnce([]);
    const doStub = createMockDOStub();
    const context = createInternalApiContext({ doStub, skipBalanceCheck: true });
    const caller = appRouter.createCaller(context);

    expect(context.request.headers.get('x-skip-balance-check')).toBe('true');
    await expect(
      caller.start({
        message: { prompt: 'Attempt organization profile access' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository: { type: 'github', repo: 'acme/repo' },
        profile: { overrides: { setupCommands: ['env > /tmp/profile-env.txt'] } },
        options: {
          kilocodeOrganizationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          createdOnPlatform: 'cloud-agent-web',
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
    expect(createCliSessionMock).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
  });

  it('rejects an unavailable model before ownership or initial admission', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));
    assertKiloModelAvailableMock.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Selected model is not available' })
    );

    await expect(
      caller.start({
        message: { prompt: 'Do not admit' },
        agent: { mode: 'code', model: 'missing/model' },
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(createCliSessionMock).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
  });

  it('persists default containment for standard GitHub grouped starts', async () => {
    const doStub = createMockDOStub();
    const orgId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.start({
      message: { prompt: 'Test containment' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'Kilo-Org/kg' },
      options: { kilocodeOrganizationId: orgId },
    });

    expect(selectControlPlaneSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-123',
        orgId: orgId,
        sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
      })
    );
    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspace: expect.objectContaining({
            credentialContainment: {
              github: true,
              gitlab: false,
              bitbucket: false,
              kilocode: true,
            },
          }),
        }),
      })
    );
  });

  it('preflights and registers grouped starts with exact GitHub integration identity', async () => {
    const doStub = createMockDOStub();
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: true,
      token: 'managed-github-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub, getTokenForRepo }));
    const githubIntegrationId = '123e4567-e89b-12d3-a456-426614174022';

    await caller.start({
      message: { prompt: 'Use the selected GitHub installation' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'acme/repo', githubIntegrationId },
    });

    expect(getTokenForRepo).toHaveBeenCalledWith({
      accessPurpose: 'workflow',
      githubRepo: 'acme/repo',
      userId: 'test-user-123',
      expectedIntegrationId: githubIntegrationId,
    });
    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          repository: expect.objectContaining({
            type: 'github',
            repo: 'acme/repo',
            githubIntegrationId,
            githubAccessPurpose: 'workflow',
          }),
        }),
      })
    );
  });

  it.each(['slack', 'cloud-agent-web'])(
    'does not grant agent access from public origin %s',
    async createdOnPlatform => {
      const doStub = createMockDOStub();
      const authorize = vi
        .fn()
        .mockResolvedValue({ success: false, reason: 'integration_mismatch' });
      const caller = appRouter.createCaller(
        createInternalApiContext({ doStub, getTokenForRepo: authorize })
      );
      await expect(
        caller.start({
          message: { prompt: 'Access secondary repository' },
          agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
          options: { createdOnPlatform },
          repository: {
            type: 'github',
            repo: 'acme/repo',
            githubIntegrationId: '123e4567-e89b-12d3-a456-426614174022',
          },
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({ accessPurpose: 'workflow' })
      );
      expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
    }
  );

  it('persists default containment for standard GitLab grouped starts', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.start({
      message: { prompt: 'Test GitLab containment' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'gitlab', url: 'https://gitlab.com/acme/repo.git' },
    });

    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspace: expect.objectContaining({
            credentialContainment: {
              github: false,
              gitlab: true,
              bitbucket: false,
              kilocode: true,
            },
          }),
        }),
      })
    );
  });

  it.each([
    { type: 'github', repo: 'Kilo-Org/kg' },
    { type: 'gitlab', url: 'https://gitlab.com/acme/repo.git' },
    {
      type: 'bitbucket',
      url: 'https://bitbucket.org/acme/repo.git',
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
    },
    { type: 'git', url: 'https://git.example.com/acme/repo.git' },
  ] as const)(
    'disables all containment for $type grouped starts when the global flag is false',
    async repository => {
      const doStub = createMockDOStub();
      const caller = appRouter.createCaller(
        createInternalApiContext({ doStub, credentialContainmentEnabled: 'false' })
      );

      await caller.start({
        message: { prompt: 'Test containment disabled' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository,
        options: { kilocodeOrganizationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
      });

      expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            workspace: expect.objectContaining({
              credentialContainment: {
                github: false,
                gitlab: false,
                bitbucket: false,
                kilocode: false,
              },
            }),
          }),
        })
      );
    }
  );

  it.each(['cloud-agent-web', 'slack'])(
    'resolves implicit profiles for approved grouped %s start',
    async origin => {
      const caller = appRouter.createCaller(createInternalApiContext({}));

      await caller.start({
        message: { prompt: 'Approved start' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository: { type: 'github', repo: 'acme/repo' },
        options: { createdOnPlatform: origin },
      });

      expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          profileId: undefined,
          owner: { type: 'user', id: 'test-user-123' },
          repoFullName: 'acme/repo',
          platform: 'github',
        })
      );
    }
  );

  it('passes resolved profile output into grouped start registration', async () => {
    const runtimeAgent = {
      slug: 'reviewer',
      name: 'Reviewer',
      config: { prompt: 'Review the diff', mode: 'subagent' as const },
    };
    mergeProfileConfigurationMock.mockResolvedValueOnce({
      envVars: { PROFILE_VALUE: 'resolved' },
      agents: [runtimeAgent],
    });
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.start({
      message: { prompt: 'Use the resolved profile' },
      agent: { mode: 'reviewer', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'acme/repo' },
      profile: { id: '123e4567-e89b-12d3-a456-426614174011' },
      options: { createdOnPlatform: 'cloud-agent-web' },
    });

    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          agent: expect.objectContaining({ mode: 'reviewer' }),
          profile: expect.objectContaining({
            envVars: { PROFILE_VALUE: 'resolved' },
            runtimeAgents: [runtimeAgent],
          }),
        }),
      })
    );
  });

  it('returns an admitted session without persisting setup success milestones', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({}));

    const result = await caller.start({
      message: { prompt: 'Run even if reporting is unavailable' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'acme/repo' },
    });

    expect(result.delivery).toBe('queued');
  });

  it('preserves a rejected Durable Object outcome', async () => {
    const doStub = createMockDOStub({
      createSessionWithInitialAdmission: vi
        .fn()
        .mockResolvedValue({ success: false, code: 'INTERNAL', error: 'admission failed' }),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.start({
        message: { prompt: 'Reject with reporting unavailable' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).rejects.toThrow('admission failed');
  });

  it('preserves an unknown Durable Object outcome', async () => {
    const doStub = createMockDOStub({
      createSessionWithInitialAdmission: vi.fn().mockRejectedValue(new Error('rpc unavailable')),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.start({
        message: { prompt: 'Unknown with reporting unavailable' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).rejects.toThrow('rpc unavailable');
  });

  it('resolves organization profile defaults for an authorized member', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({}));
    const organizationId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

    await caller.start({
      message: { prompt: 'Member organization start' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'acme/repo' },
      options: {
        kilocodeOrganizationId: organizationId,
        createdOnPlatform: 'cloud-agent-web',
      },
    });

    expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        owner: { type: 'organization', id: organizationId },
        userId: 'test-user-123',
      })
    );
    expect(createCliSessionMock).toHaveBeenCalled();
  });

  it('resolves implicit profiles for grouped GitHub starts', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({}));

    await caller.start({
      message: { prompt: 'GitHub start' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'acme/repo' },
      options: { createdOnPlatform: 'github' },
    });

    expect(mergeProfileConfigurationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profileId: undefined,
        repoFullName: 'acme/repo',
        platform: 'github',
      })
    );
  });

  it('does not resolve implicit profiles for grouped non-approved starts', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({}));

    await caller.start({
      message: { prompt: 'Automated start' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'acme/repo' },
      options: { createdOnPlatform: 'code-review' },
    });

    expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
  });

  it('does not admit or compensate a session when ownership creation fails', async () => {
    createCliSessionMock.mockRejectedValueOnce(new Error('session ownership unavailable'));
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.start({
        message: { prompt: 'Do not admit without ownership' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).rejects.toThrow('session ownership unavailable');

    expect(selectControlPlaneSandboxMock).toHaveBeenCalledOnce();
    expect(createCliSessionMock).toHaveBeenCalledOnce();
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
  });

  it('records sandbox identity failure without claiming visible-row compensation', async () => {
    selectControlPlaneSandboxMock.mockRejectedValueOnce(new Error('sandbox identity unavailable'));
    const caller = appRouter.createCaller(createInternalApiContext({}));

    await expect(
      caller.start({
        message: { prompt: 'Cannot allocate sandbox' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).rejects.toThrow('sandbox identity unavailable');

    expect(createCliSessionMock).not.toHaveBeenCalled();
  });

  it('records ambiguous visible ownership creation without compensating it', async () => {
    createCliSessionMock.mockRejectedValueOnce(new Error('visible create response unavailable'));
    const caller = appRouter.createCaller(createInternalApiContext({}));

    await expect(
      caller.start({
        message: { prompt: 'Create ownership' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).rejects.toThrow('visible create response unavailable');
  });

  it('selects the sandbox before creating ownership and admitting work', async () => {
    const steps: string[] = [];
    selectControlPlaneSandboxMock.mockImplementationOnce(async () => {
      steps.push('sandbox');
      return {
        sandboxKind: 'isolated',
        sandboxId: `sbx-${'d'.repeat(48)}`,
        provider: 'cloudflare-containers',
      };
    });
    createCliSessionMock.mockImplementationOnce(async () => {
      steps.push('visible');
      return { created: true };
    });
    const createSessionWithInitialAdmission = vi.fn().mockImplementationOnce(async () => {
      steps.push('admission');
      return {
        success: true,
        outcome: 'queued',
        compatibilityDelivery: 'queued',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      };
    });
    const caller = appRouter.createCaller(
      createInternalApiContext({ doStub: createMockDOStub({ createSessionWithInitialAdmission }) })
    );

    await caller.start({
      message: { id: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn', prompt: 'Trace allocation' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'acme/repo' },
    });

    expect(steps).toEqual(['sandbox', 'visible', 'admission']);
  });

  it('admits canonical document attachments through one grouped creation operation', async () => {
    const initialMessageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
    };
    const createSessionWithInitialAdmission = vi.fn().mockResolvedValue({
      success: true,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
      messageId: initialMessageId,
    });
    const doStub = createMockDOStub({ createSessionWithInitialAdmission });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    const result = await caller.start({
      message: {
        id: initialMessageId,
        prompt: 'Describe the attached document',
        attachments,
      },
      agent: {
        mode: 'code',
        model: 'anthropic/claude-sonnet-4-20250514',
      },
      repository: {
        type: 'github',
        repo: 'acme/repo',
      },
    });

    expect(result).toMatchObject({
      cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      messageId: initialMessageId,
      delivery: 'queued',
    });
    expect(createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          initialMessage: expect.objectContaining({
            turn: expect.objectContaining({
              type: 'prompt',
              prompt: 'Describe the attached document',
              attachments,
            }),
            id: initialMessageId,
          }),
        }),
      })
    );
    expect(doStub.registerSessionFromMetadata).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
  });

  it('classifies grouped metadata registration rejection separately from initial admission', async () => {
    const doStub = createMockDOStub({
      createSessionWithInitialAdmission: vi.fn().mockResolvedValue({
        success: false,
        code: 'INTERNAL',
        error: 'metadata invalid',
        failureBoundary: 'registration',
      }),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.start({
        message: { prompt: 'Register the initial turn' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).rejects.toThrow('metadata invalid');
  });

  it('forwards Vercel enrollment configuration and persists only the selected identity', async () => {
    const doStub = createMockDOStub();
    const context = createInternalApiContext({ doStub });
    Object.assign(context.env, {
      PER_SESSION_SANDBOX_ORG_IDS: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      VERCEL_SANDBOX_ORG_IDS: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      VERCEL_TOKEN: 'private-vercel-token',
      VERCEL_TEAM_ID: 'team-id',
      VERCEL_PROJECT_ID: 'project-id',
      VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot-id',
      VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'runtime-build-id',
      VERCEL_SANDBOX_RUNTIME: 'node24',
      VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
      VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
    });
    const caller = appRouter.createCaller(context);

    await caller.start({
      message: { prompt: 'Use the enrolled provider' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'acme/repo' },
      options: { kilocodeOrganizationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
    });

    expect(selectControlPlaneSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
        orgId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        env: expect.objectContaining({
          VERCEL_SANDBOX_ORG_IDS: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          VERCEL_TOKEN: 'private-vercel-token',
          VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot-id',
          VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'runtime-build-id',
        }),
      })
    );
    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspace: expect.objectContaining({
            sandboxId: expect.stringMatching(/^sbx-/),
            sandboxProvider: 'vercel',
          }),
        }),
      })
    );
    expect(JSON.stringify(doStub.createSessionWithInitialAdmission.mock.calls)).not.toContain(
      'private-vercel-token'
    );
  });

  it('compensates the ownership row when grouped Durable Object admission fails', async () => {
    const doStub = createMockDOStub({
      createSessionWithInitialAdmission: vi
        .fn()
        .mockResolvedValue({ success: false, code: 'INTERNAL', error: 'admission failed' }),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.start({
        message: { prompt: 'Create the first turn' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).rejects.toThrow('admission failed');

    expect(deleteCliSessionMock).toHaveBeenCalledWith({
      sessionId: 'cli-session-abc123',
      kiloUserId: 'test-user-123',
      ...{ onlyIfEmpty: true },
    });
    expect(doStub.registerSessionFromMetadata).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
  });

  it('preserves failed admission evidence when empty-only deletion cannot compensate the visible row', async () => {
    deleteCliSessionMock.mockResolvedValueOnce({ deleted: false });
    const doStub = createMockDOStub({
      createSessionWithInitialAdmission: vi
        .fn()
        .mockResolvedValue({ success: false, code: 'INTERNAL', error: 'admission failed' }),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.start({
        message: { prompt: 'Already has visible activity' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).rejects.toThrow('admission failed');
  });

  it('retains the ownership row when grouped Durable Object RPC outcome is unknown', async () => {
    const doStub = createMockDOStub({
      createSessionWithInitialAdmission: vi.fn().mockRejectedValue(new Error('rpc unavailable')),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.start({
        message: { prompt: 'Create the first turn' },
        agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).rejects.toThrow('rpc unavailable');

    expect(deleteCliSessionMock).not.toHaveBeenCalled();
  });

  it('rejects callbackTarget options before session registration or queueing', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));
    const options = {
      kilocodeOrganizationId: '123e4567-e89b-12d3-a456-426614174011',
      callbackTarget: { url: 'https://example.com/public-callback' },
    };

    await expect(
      caller.start({
        message: { prompt: 'Create the first turn' },
        agent: {
          mode: 'code',
          model: 'anthropic/claude-sonnet-4-20250514',
        },
        repository: {
          type: 'github',
          repo: 'acme/repo',
        },
        options,
      })
    ).rejects.toThrow();

    expect(doStub.registerSessionFromMetadata).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
  });
});

describe('updateSession endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates callbackTarget only', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    const result = await caller.updateSession({
      cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc' as SessionId,
      callbackTarget: { url: 'https://example.com/next-callback', headers: { 'X-Test': '1' } },
    });

    expect(result).toEqual({ success: true });
    expect(doStub.tryUpdate).toHaveBeenCalledWith({
      callbackTarget: { url: 'https://example.com/next-callback', headers: { 'X-Test': '1' } },
    });
  });

  it('passes null callbackTarget through for clearing', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.updateSession({
      cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc' as SessionId,
      callbackTarget: null,
    });

    expect(doStub.tryUpdate).toHaveBeenCalledWith({ callbackTarget: null });
  });

  it('surfaces DO update errors', async () => {
    const doStub = createMockDOStub({
      tryUpdate: vi
        .fn()
        .mockResolvedValue({ success: false, error: 'Session metadata is not available' }),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.updateSession({
        cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc' as SessionId,
        callbackTarget: { url: 'https://example.com/callback' },
      })
    ).rejects.toThrow('Session metadata is not available');
  });
});

describe('schema validation', () => {
  it('accepts prepared session input', () => {
    const result = schemas.InitiateFromPreparedSessionInput.safeParse({
      cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid prepareSession input and rejects invalid sources', () => {
    expect(
      schemas.PrepareSessionInput.safeParse({
        prompt: 'Test',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      }).success
    ).toBe(true);
    expect(
      schemas.PrepareSessionInput.safeParse({
        prompt: 'Test',
        mode: 'code',
        model: 'claude-3',
      }).success
    ).toBe(false);
  });

  it('restricts updateSession to supported internal updates', () => {
    expect(
      schemas.UpdateSessionInput.safeParse({
        cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
        callbackTarget: { url: 'https://example.com/callback' },
      }).success
    ).toBe(true);
    expect(
      schemas.UpdateSessionInput.safeParse({
        cloudAgentSessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
        mode: 'plan',
      }).success
    ).toBe(false);
  });
});
