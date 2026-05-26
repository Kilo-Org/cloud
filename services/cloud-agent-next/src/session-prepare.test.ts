import type * as CloudAgentProfile from '@kilocode/cloud-agent-profile';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schemas from './router/schemas.js';

const {
  generateSessionIdMock,
  generateSandboxIdMock,
  createCliSessionMock,
  deleteCliSessionMock,
  mergeProfileConfigurationMock,
  organizationMembershipLimitMock,
  assertKiloModelAvailableMock,
} = vi.hoisted(() => ({
  generateSessionIdMock: vi.fn(() => 'agent_12345678-1234-1234-1234-123456789abc'),
  generateSandboxIdMock: vi.fn().mockResolvedValue('sb-test-123'),
  createCliSessionMock: vi.fn().mockResolvedValue(undefined),
  deleteCliSessionMock: vi.fn().mockResolvedValue(undefined),
  mergeProfileConfigurationMock: vi.fn(),
  organizationMembershipLimitMock: vi.fn(),
  assertKiloModelAvailableMock: vi.fn(),
}));

vi.mock('@kilocode/cloud-agent-profile', async importActual => {
  const actual = await importActual<typeof CloudAgentProfile>();
  return {
    ...actual,
    mergeProfileConfiguration: mergeProfileConfigurationMock,
  };
});

vi.mock('./db/pg.js', () => ({
  getPgDb: vi.fn(() => ({
    mockedDb: true,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: organizationMembershipLimitMock })),
      })),
    })),
  })),
}));

vi.mock('./utils/kilo-session-id.js', () => ({
  generateKiloSessionId: vi.fn(() => 'cli-session-abc123'),
}));

vi.mock('./sandbox-id.js', () => ({
  generateSandboxId: generateSandboxIdMock,
  getSandboxNamespace: vi.fn(),
}));

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
  Sandbox: class Sandbox {},
}));

vi.mock('./model-validation.js', () => ({
  assertKiloModelAvailable: assertKiloModelAvailableMock,
}));

vi.mock('./session-service.js', () => ({
  generateSessionId: () => generateSessionIdMock(),
  fetchSessionMetadata: vi.fn(),
  determineBranchName: vi.fn(
    (sessionId: string, upstreamBranch?: string) => upstreamBranch || `session/${sessionId}`
  ),
  runSetupCommands: vi.fn().mockResolvedValue(undefined),
  writeAuthFile: vi.fn().mockResolvedValue(undefined),
  InvalidSessionMetadataError: class InvalidSessionMetadataError extends Error {
    constructor(
      public readonly userId: string,
      public readonly sessionId: string,
      public readonly details?: string
    ) {
      super(`Invalid session metadata for session ${sessionId}`);
      this.name = 'InvalidSessionMetadataError';
    }
  },
  SessionService: class SessionService {
    createCliSessionViaSessionIngest = createCliSessionMock;
    deleteCliSessionViaSessionIngest = deleteCliSessionMock;
  },
}));

import { appRouter } from './router.js';
import { profileResolutionPolicyForSessionCreateOrigin } from './router/handlers/session-prepare.js';
import type { TRPCContext, SessionId } from './types.js';

function createMockDOStub(
  overrides: {
    registerSession?: ReturnType<typeof vi.fn>;
    createSessionWithInitialAdmission?: ReturnType<typeof vi.fn>;
    tryUpdate?: ReturnType<typeof vi.fn>;
    getMetadata?: ReturnType<typeof vi.fn>;
    admitSubmittedMessage?: ReturnType<typeof vi.fn>;
  } = {}
) {
  return {
    registerSession: overrides.registerSession ?? vi.fn().mockResolvedValue({ success: true }),
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
  doStub?: ReturnType<typeof createMockDOStub>;
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
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn((id: string) => ({ id })),
        get: vi.fn(() => doStub),
      } as unknown as TRPCContext['env']['CLOUD_AGENT_SESSION'],
      SESSION_INGEST: {
        fetch: vi.fn(),
        createSessionForCloudAgent: vi.fn().mockResolvedValue(undefined),
        deleteSessionForCloudAgent: vi.fn().mockResolvedValue(undefined),
      } as unknown as TRPCContext['env']['SESSION_INGEST'],
      INTERNAL_API_SECRET: effectiveInternalApiSecret,
      NEXTAUTH_SECRET: 'test-secret',
      R2_BUCKET: {} as TRPCContext['env']['R2_BUCKET'],
      GIT_TOKEN_SERVICE: {} as TRPCContext['env']['GIT_TOKEN_SERVICE'],
      HYPERDRIVE: {
        connectionString: 'postgres://profile-test',
      } as TRPCContext['env']['HYPERDRIVE'],
    },
  } as TRPCContext;
}

describe('effective session profile policy', () => {
  it('selects web-default resolution explicitly at the platform adaptation boundary', () => {
    expect(profileResolutionPolicyForSessionCreateOrigin('cloud-agent-web')).toEqual({
      defaultProfileResolution: 'include-web-defaults',
    });
    expect(profileResolutionPolicyForSessionCreateOrigin('code-review')).toEqual({
      defaultProfileResolution: 'explicit-profile-only',
    });
  });
});

describe('prepareSession endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateSessionIdMock.mockReturnValue('agent_12345678-1234-1234-1234-123456789abc');
    generateSandboxIdMock.mockResolvedValue('sb-test-123');
    createCliSessionMock.mockResolvedValue(undefined);
    deleteCliSessionMock.mockResolvedValue(undefined);
    mergeProfileConfigurationMock.mockResolvedValue({});
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
    expect(doStub.registerSession).not.toHaveBeenCalled();
    expect(doStub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
  });

  it('resolves web defaults when no explicit profile is selected', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({}));

    await caller.prepareSession({
      prompt: 'Web default profile',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      createdOnPlatform: 'cloud-agent-web',
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

  it('does not resolve web defaults for non-web creation without an explicit profile', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({}));

    await caller.prepareSession({
      prompt: 'Other platform',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      createdOnPlatform: 'code-review',
    });

    expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
  });

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
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
    });
    expect(createCliSessionMock).toHaveBeenCalledWith(
      'cli-session-abc123',
      'agent_12345678-1234-1234-1234-123456789abc',
      'test-user-123',
      expect.any(Object),
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      'code-review',
      expect.stringMatching(/^New session - /)
    );
    expect(doStub.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          sessionId: 'agent_12345678-1234-1234-1234-123456789abc',
          userId: 'test-user-123',
          orgId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          botId: undefined,
          createdOnPlatform: 'code-review',
        },
        auth: {
          kiloSessionId: 'cli-session-abc123',
          kilocodeToken: 'test-auth-token',
        },
        message: {
          initialMessageId: expect.stringMatching(/^msg_/) as unknown,
          turn: {
            type: 'prompt',
            id: expect.stringMatching(/^msg_/) as unknown,
            prompt: 'Test prompt',
            images: undefined,
          },
        },
        agent: {
          mode: 'plan',
          model: 'claude-3',
          variant: undefined,
          appendSystemPrompt: 'extra rules',
        },
        repository: {
          type: 'github',
          repo: 'acme/repo',
          branch: 'feature/test-branch',
        },
        profile: {
          envVars: { API_KEY: 'secret' },
          setupCommands: ['npm install'],
          mcpServers: { test: { type: 'local', command: ['npx', 'test-server'] } },
          encryptedSecrets: undefined,
          runtimeSkills: undefined,
          runtimeAgents: undefined,
          kiloCommands: undefined,
        },
        finalization: {
          autoCommit: true,
          condenseOnComplete: true,
          gateThreshold: 'warning',
        },
        callback: {
          target: { url: 'https://example.com/callback' },
        },
        workspace: {
          sandboxId: 'sb-test-123',
          shallow: true,
        },
      })
    );
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

    expect(doStub.registerSession).toHaveBeenCalledOnce();
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

    expect(doStub.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: {
          type: 'gitlab',
          url: 'https://gitlab.com/acme/repo.git',
          branch: 'feature/gitlab',
        },
      })
    );
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

    expect(doStub.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: {
          type: 'git',
          url: 'https://git.example.com/acme/repo.git',
          token: 'generic-git-token',
          branch: 'feature/generic',
        },
      })
    );
  });

  it('auto-initiates through grouped creation with the canonical initial message', async () => {
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
        message: {
          initialTurn: {
            type: 'prompt',
            messageId: initialMessageId,
            prompt: 'Inspect the screenshot',
            images,
          },
        },
      })
    );
    expect(doStub.registerSession).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
  });

  it('creates auto-initiated devcontainer sessions with grouped DIND sandbox intent', async () => {
    generateSandboxIdMock.mockResolvedValueOnce('dind-abcdef');
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await caller.prepareSession({
      prompt: 'Prepare the devcontainer runtime',
      mode: 'code',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      autoInitiate: true,
      devcontainer: true,
    });

    expect(generateSandboxIdMock).toHaveBeenCalledWith(
      undefined,
      undefined,
      'test-user-123',
      'agent_12345678-1234-1234-1234-123456789abc',
      undefined,
      true
    );
    expect(doStub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: {
          sandboxId: 'dind-abcdef',
          shallow: false,
          devcontainerRequested: true,
        },
      })
    );
    expect(doStub.registerSession).not.toHaveBeenCalled();
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
    ).rejects.toThrow('devcontainer sessions must use autoInitiate');

    expect(doStub.registerSession).not.toHaveBeenCalled();
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
        message: {
          initialTurn: {
            type: 'command',
            messageId: initialMessageId,
            command: 'compact',
            arguments: '--aggressive',
          },
        },
      })
    );
    expect(doStub.registerSession).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
    expect(assertKiloModelAvailableMock).not.toHaveBeenCalled();
  });

  it('rejects command-valued initialPayload images before registration', async () => {
    const doStub = createMockDOStub();
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.prepareSession({
        prompt: '/compact --aggressive',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        autoInitiate: true,
        images: {
          path: '123e4567-e89b-12d3-a456-426614174000',
          files: ['123e4567-e89b-12d3-a456-426614174001.png'],
        },
        initialPayload: {
          type: 'command',
          command: 'compact',
          arguments: '--aggressive',
        },
      })
    ).rejects.toThrow('Images cannot be attached to slash commands');

    expect(doStub.registerSession).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
  });

  it('attempts best-effort ownership-row compensation on explicit registration rejection', async () => {
    const doStub = createMockDOStub({
      registerSession: vi
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

    expect(deleteCliSessionMock).toHaveBeenCalledWith(
      'cli-session-abc123',
      'test-user-123',
      expect.any(Object),
      { onlyIfEmpty: true }
    );
    expect(doStub.registerSession).toHaveBeenCalledTimes(1);
  });

  it('does not replay or compensate a committed registration with lost retryable response', async () => {
    const retryableError = Object.assign(new Error('registration response lost'), {
      retryable: true,
    });
    const registerSession = vi.fn().mockRejectedValue(retryableError);
    const caller = appRouter.createCaller(
      createInternalApiContext({ doStub: createMockDOStub({ registerSession }) })
    );

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('registration response lost');

    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
  });

  it('retains ownership state when registration outcome remains unknown', async () => {
    const registerSession = vi.fn().mockRejectedValue(new Error('unknown registration outcome'));
    const caller = appRouter.createCaller(
      createInternalApiContext({ doStub: createMockDOStub({ registerSession }) })
    );

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('unknown registration outcome');

    expect(registerSession).toHaveBeenCalledTimes(1);
    expect(deleteCliSessionMock).not.toHaveBeenCalled();
  });
});

describe('start endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateSessionIdMock.mockReturnValue('agent_12345678-1234-1234-1234-123456789abc');
    generateSandboxIdMock.mockResolvedValue('sb-test-123');
    createCliSessionMock.mockResolvedValue(undefined);
    deleteCliSessionMock.mockResolvedValue(undefined);
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

  it('resolves web defaults for grouped start without an explicit profile', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({}));

    await caller.start({
      message: { prompt: 'Web start' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'acme/repo' },
      options: { createdOnPlatform: 'cloud-agent-web' },
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

  it('does not resolve web defaults for grouped non-web start without a profile', async () => {
    const caller = appRouter.createCaller(createInternalApiContext({}));

    await caller.start({
      message: { prompt: 'Other start' },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4-20250514' },
      repository: { type: 'github', repo: 'acme/repo' },
      options: { createdOnPlatform: 'app-builder' },
    });

    expect(mergeProfileConfigurationMock).not.toHaveBeenCalled();
  });

  it('admits the canonical initial turn through one grouped creation operation', async () => {
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

    const result = await caller.start({
      message: {
        id: initialMessageId,
        prompt: 'Describe the attached image',
        images,
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
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      kiloSessionId: 'cli-session-abc123',
      messageId: initialMessageId,
      delivery: 'queued',
    });
    expect(createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          initialTurn: {
            type: 'prompt',
            messageId: initialMessageId,
            prompt: 'Describe the attached image',
            images,
          },
        },
      })
    );
    expect(doStub.registerSession).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
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

    expect(deleteCliSessionMock).toHaveBeenCalledWith(
      'cli-session-abc123',
      'test-user-123',
      expect.any(Object),
      { onlyIfEmpty: true }
    );
    expect(doStub.registerSession).not.toHaveBeenCalled();
    expect(doStub.admitSubmittedMessage).not.toHaveBeenCalled();
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

    expect(doStub.registerSession).not.toHaveBeenCalled();
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
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
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
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
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
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        callbackTarget: { url: 'https://example.com/callback' },
      })
    ).rejects.toThrow('Session metadata is not available');
  });
});

describe('schema validation', () => {
  it('accepts prepared session input', () => {
    const result = schemas.InitiateFromPreparedSessionInput.safeParse({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
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

  it('restricts updateSession to callbackTarget', () => {
    expect(
      schemas.UpdateSessionInput.safeParse({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
        callbackTarget: { url: 'https://example.com/callback' },
      }).success
    ).toBe(true);
    expect(
      schemas.UpdateSessionInput.safeParse({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
        mode: 'plan',
      }).success
    ).toBe(false);
  });
});
