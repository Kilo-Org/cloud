import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schemas from './router/schemas.js';

const { generateSessionIdMock, generateSandboxIdMock, createCliSessionMock, deleteCliSessionMock } =
  vi.hoisted(() => ({
    generateSessionIdMock: vi.fn(() => 'agent_12345678-1234-1234-1234-123456789abc'),
    generateSandboxIdMock: vi.fn().mockResolvedValue('sb-test-123'),
    createCliSessionMock: vi.fn().mockResolvedValue(undefined),
    deleteCliSessionMock: vi.fn().mockResolvedValue(undefined),
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
import type { TRPCContext, SessionId } from './types.js';

function createMockDOStub(
  overrides: {
    registerSession?: ReturnType<typeof vi.fn>;
    tryUpdate?: ReturnType<typeof vi.fn>;
    getMetadata?: ReturnType<typeof vi.fn>;
    queueSessionMessage?: ReturnType<typeof vi.fn>;
  } = {}
) {
  return {
    registerSession: overrides.registerSession ?? vi.fn().mockResolvedValue({ success: true }),
    tryUpdate: overrides.tryUpdate ?? vi.fn().mockResolvedValue({ success: true }),
    getMetadata: overrides.getMetadata ?? vi.fn().mockResolvedValue(null),
    queueSessionMessage:
      overrides.queueSessionMessage ??
      vi.fn().mockResolvedValue({
        success: true,
        status: 'started',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        delivery: 'queued',
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
    },
  } as TRPCContext;
}

describe('prepareSession endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateSessionIdMock.mockReturnValue('agent_12345678-1234-1234-1234-123456789abc');
    generateSandboxIdMock.mockResolvedValue('sb-test-123');
    createCliSessionMock.mockResolvedValue(undefined);
    deleteCliSessionMock.mockResolvedValue(undefined);
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

  it('auto-initiates the same registered first-turn message ID, prompt, and images', async () => {
    const initialMessageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
    const images = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.png'],
    };
    const queueSessionMessage = vi.fn().mockResolvedValue({
      success: true,
      status: 'started',
      messageId: initialMessageId,
      delivery: 'queued',
    });
    const doStub = createMockDOStub({ queueSessionMessage });
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

    expect(doStub.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          initialMessageId,
          turn: {
            type: 'prompt',
            id: initialMessageId,
            prompt: 'Inspect the screenshot',
            images,
          },
        },
      })
    );
    expect(queueSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user-message',
        turn: {
          type: 'prompt',
          id: initialMessageId,
          prompt: 'Inspect the screenshot',
          images,
        },
      })
    );
  });

  it('registers auto-initiated devcontainer sessions with DIND sandbox intent', async () => {
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
    expect(doStub.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: {
          sandboxId: 'dind-abcdef',
          shallow: false,
          devcontainerRequested: true,
        },
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
    ).rejects.toThrow('devcontainer sessions must use autoInitiate');

    expect(doStub.registerSession).not.toHaveBeenCalled();
  });

  it('auto-initiates command-valued initialPayload as a command turn', async () => {
    const initialMessageId = 'msg_018f1e2d3c4bInitCmdAbCdEfG';
    const queueSessionMessage = vi.fn().mockResolvedValue({
      success: true,
      status: 'started',
      messageId: initialMessageId,
      delivery: 'queued',
    });
    const doStub = createMockDOStub({ queueSessionMessage });
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

    expect(doStub.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          initialMessageId,
          turn: {
            type: 'command',
            id: initialMessageId,
            command: 'compact',
            arguments: '--aggressive',
          },
        },
      })
    );
    expect(queueSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user-message',
        turn: {
          type: 'command',
          id: initialMessageId,
          command: 'compact',
          arguments: '--aggressive',
        },
      })
    );
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
    expect(doStub.queueSessionMessage).not.toHaveBeenCalled();
  });

  it('rolls back the cli session when registration fails', async () => {
    const doStub = createMockDOStub({
      registerSession: vi
        .fn()
        .mockResolvedValue({ success: false, error: 'Session already exists' }),
    });
    const caller = appRouter.createCaller(createInternalApiContext({ doStub }));

    await expect(
      caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'code',
        model: 'claude-3',
        githubRepo: 'acme/repo',
      })
    ).rejects.toThrow('Session already exists');

    expect(deleteCliSessionMock).toHaveBeenCalledWith(
      'cli-session-abc123',
      'test-user-123',
      expect.any(Object),
      { onlyIfEmpty: true }
    );
  });
});

describe('start endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateSessionIdMock.mockReturnValue('agent_12345678-1234-1234-1234-123456789abc');
    generateSandboxIdMock.mockResolvedValue('sb-test-123');
    createCliSessionMock.mockResolvedValue(undefined);
    deleteCliSessionMock.mockResolvedValue(undefined);
  });

  it('queues the registered first-turn message ID, prompt, and images', async () => {
    const initialMessageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
    const images = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.png'],
    };
    const queueSessionMessage = vi.fn().mockResolvedValue({
      success: true,
      status: 'started',
      messageId: initialMessageId,
      delivery: 'queued',
    });
    const doStub = createMockDOStub({ queueSessionMessage });
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
    expect(doStub.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          initialMessageId,
          turn: {
            type: 'prompt',
            id: initialMessageId,
            prompt: 'Describe the attached image',
            images,
          },
        },
      })
    );
    expect(queueSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user-message',
        turn: {
          type: 'prompt',
          id: initialMessageId,
          prompt: 'Describe the attached image',
          images,
        },
      })
    );
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
    expect(doStub.queueSessionMessage).not.toHaveBeenCalled();
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
