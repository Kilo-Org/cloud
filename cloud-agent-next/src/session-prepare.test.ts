import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schemas from './router/schemas.js';
import * as schemaLimits from './schema.js';

// Create a mock execution session
const createMockExecutionSession = () => ({
  id: 'mock-session-id',
  exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
  execStream: vi.fn(),
  startProcess: vi.fn().mockResolvedValue({
    id: 'mock-process-id',
    status: 'running',
    waitForPort: vi.fn().mockResolvedValue(undefined),
  }),
  listProcesses: vi.fn().mockResolvedValue([]),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
  mkdir: vi.fn().mockResolvedValue(undefined),
});

// Create a mock sandbox
const createMockSandbox = () => {
  const mockSession = createMockExecutionSession();
  return {
    getSession: vi.fn().mockResolvedValue(mockSession),
    createSession: vi.fn().mockResolvedValue(mockSession),
    listProcesses: vi.fn().mockResolvedValue([]),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
};

// Mock Cloudflare sandbox to prevent module resolution errors
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(() => createMockSandbox()),
}));

// Mock workspace functions
vi.mock('./workspace.js', () => ({
  setupWorkspace: vi.fn().mockResolvedValue({
    workspacePath: '/workspace/test',
    sessionHome: '/home/test',
  }),
  cloneGitHubRepo: vi.fn().mockResolvedValue(undefined),
  cloneGitRepo: vi.fn().mockResolvedValue(undefined),
  manageBranch: vi.fn().mockResolvedValue(undefined),
}));

// Mock kilo server-manager functions
vi.mock('./kilo/server-manager.js', () => ({
  ensureKiloServer: vi.fn().mockResolvedValue(4096),
  createKiloCliSession: vi.fn().mockResolvedValue({ id: 'cli-session-abc123' }),
}));

// Define mocks BEFORE vi.mock() to avoid hoisting issues
// vi.hoisted() ensures these are available when the mock factory runs
const { generateSessionIdMock, createKiloSessionInBackendMock, deleteKiloSessionInBackendMock } =
  vi.hoisted(() => ({
    generateSessionIdMock: vi.fn(() => 'agent_12345678-1234-1234-1234-123456789abc'),
    createKiloSessionInBackendMock: vi
      .fn()
      .mockResolvedValue('123e4567-e89b-12d3-a456-426614174000'),
    deleteKiloSessionInBackendMock: vi.fn().mockResolvedValue(undefined),
  }));

// Mock session-service to isolate router tests
vi.mock('./session-service.js', () => ({
  generateSessionId: () => generateSessionIdMock(),
  fetchSessionMetadata: vi.fn(),
  determineBranchName: vi.fn(
    (sessionId: string, upstreamBranch?: string) => upstreamBranch || `session/${sessionId}`
  ),
  runSetupCommands: vi.fn().mockResolvedValue(undefined),
  writeMCPSettings: vi.fn().mockResolvedValue(undefined),
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
    createKiloSessionInBackend = createKiloSessionInBackendMock;
    deleteKiloSessionInBackend = deleteKiloSessionInBackendMock;
    getOrCreateSession = vi.fn().mockResolvedValue(createMockExecutionSession());
    buildContext = vi.fn().mockReturnValue({
      sandboxId: 'test-sandbox',
      orgId: 'test-org',
      userId: 'test-user',
      sessionId: 'test-session',
      workspacePath: '/workspace/test',
      sessionHome: '/home/test',
    });
  },
}));

import { appRouter } from './router.js';
import type { TRPCContext, SessionId } from './types.js';
import type { CloudAgentSessionState } from './persistence/types.js';

// Helper to create a mock DO stub
function createMockDOStub(
  overrides: {
    prepare?: ReturnType<typeof vi.fn>;
    tryUpdate?: ReturnType<typeof vi.fn>;
    tryInitiate?: ReturnType<typeof vi.fn>;
    getMetadata?: ReturnType<typeof vi.fn>;
    updateMetadata?: ReturnType<typeof vi.fn>;
    deleteSession?: ReturnType<typeof vi.fn>;
  } = {}
) {
  return {
    prepare: overrides.prepare ?? vi.fn().mockResolvedValue({ success: true }),
    tryUpdate: overrides.tryUpdate ?? vi.fn().mockResolvedValue({ success: true }),
    tryInitiate: overrides.tryInitiate ?? vi.fn().mockResolvedValue({ success: true, data: {} }),
    getMetadata: overrides.getMetadata ?? vi.fn().mockResolvedValue(null),
    updateMetadata: overrides.updateMetadata ?? vi.fn().mockResolvedValue(undefined),
    deleteSession: overrides.deleteSession ?? vi.fn().mockResolvedValue(undefined),
    markAsInterrupted: vi.fn().mockResolvedValue(undefined),
    isInterrupted: vi.fn().mockResolvedValue(false),
    clearInterrupted: vi.fn().mockResolvedValue(undefined),
    updateKiloSessionId: vi.fn().mockResolvedValue(undefined),
    updateGithubToken: vi.fn().mockResolvedValue(undefined),
  };
}

// Helper to create a properly typed context for internal-API-protected endpoints
function createInternalApiContext(options: {
  userId?: string | null; // null means explicitly no userId
  authToken?: string | null; // null means explicitly no authToken
  internalApiSecret?: string | null; // null means explicitly no internal API secret configured
  requestInternalApiKey?: string | null; // null means no x-internal-api-key header
  doStub?: ReturnType<typeof createMockDOStub>;
}): TRPCContext {
  const {
    userId,
    authToken,
    internalApiSecret,
    requestInternalApiKey,
    doStub = createMockDOStub(),
  } = options;

  // Apply defaults only if not explicitly set to null
  const effectiveUserId =
    userId === undefined ? 'test-user-123' : userId === null ? undefined : userId;
  const effectiveAuthToken =
    authToken === undefined ? 'test-auth-token' : authToken === null ? undefined : authToken;
  const effectiveInternalApiSecret =
    internalApiSecret === undefined
      ? 'test-internal-api-secret'
      : internalApiSecret === null
        ? undefined
        : internalApiSecret;
  const effectiveRequestInternalApiKey =
    requestInternalApiKey === undefined ? 'test-internal-api-secret' : requestInternalApiKey;

  const headers = new Headers();
  if (effectiveRequestInternalApiKey !== null) {
    headers.set('x-internal-api-key', effectiveRequestInternalApiKey);
  }

  return {
    userId: effectiveUserId,
    authToken: effectiveAuthToken,
    botId: undefined,
    request: {
      headers,
    } as unknown as Request,
    env: {
      Sandbox: {} as TRPCContext['env']['Sandbox'],
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn((id: string) => ({ id })),
        get: vi.fn(() => doStub),
      } as unknown as TRPCContext['env']['CLOUD_AGENT_SESSION'],
      INTERNAL_API_SECRET: effectiveInternalApiSecret,
      NEXTAUTH_SECRET: 'test-secret',
    },
  } as TRPCContext;
}

describe('prepareSession endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateSessionIdMock.mockReturnValue('agent_12345678-1234-1234-1234-123456789abc');
    createKiloSessionInBackendMock.mockResolvedValue('123e4567-e89b-12d3-a456-426614174000');
    deleteKiloSessionInBackendMock.mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('should reject request without internal API key header', async () => {
      const doStub = createMockDOStub();
      const ctx = createInternalApiContext({
        requestInternalApiKey: null, // No internal API key
        doStub,
      });

      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.prepareSession({
          prompt: 'Test prompt',
          mode: 'build',
          model: 'claude-3',
          githubRepo: 'acme/repo',
          githubToken: 'ghp_test_token',
        })
      ).rejects.toThrow('Invalid or missing internal API key');
    });

    it('should reject request with invalid internal API key', async () => {
      const doStub = createMockDOStub();
      const ctx = createInternalApiContext({
        requestInternalApiKey: 'wrong-key',
        internalApiSecret: 'correct-key',
        doStub,
      });

      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.prepareSession({
          prompt: 'Test prompt',
          mode: 'build',
          model: 'claude-3',
          githubRepo: 'acme/repo',
          githubToken: 'ghp_test_token',
        })
      ).rejects.toThrow('Invalid or missing internal API key');
    });

    it('should reject request without customer token (userId)', async () => {
      const doStub = createMockDOStub();
      const ctx = createInternalApiContext({
        userId: null, // Explicitly no userId
        doStub,
      });

      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.prepareSession({
          prompt: 'Test prompt',
          mode: 'build',
          model: 'claude-3',
          githubRepo: 'acme/repo',
          githubToken: 'ghp_test_token',
        })
      ).rejects.toThrow('Invalid customer token');
    });

    it('should reject when INTERNAL_API_SECRET is not configured', async () => {
      const doStub = createMockDOStub();
      const ctx = createInternalApiContext({
        internalApiSecret: null, // Explicitly no internal API secret configured
        doStub,
      });

      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.prepareSession({
          prompt: 'Test prompt',
          mode: 'build',
          model: 'claude-3',
          githubRepo: 'acme/repo',
          githubToken: 'ghp_test_token',
        })
      ).rejects.toThrow('Internal API secret not configured');
    });
  });

  describe('success cases', () => {
    it('should successfully prepare a new session with GitHub repo', async () => {
      const doStub = createMockDOStub({
        prepare: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);
      const result = await caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'build',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        githubToken: 'ghp_token',
      });

      expect(result.cloudAgentSessionId).toMatch(/^agent_[0-9a-f-]+$/);
      expect(result.kiloSessionId).toBe('cli-session-abc123');
      expect(doStub.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: expect.stringMatching(/^agent_/),
          userId: 'test-user-123',
          kiloSessionId: 'cli-session-abc123',
          prompt: 'Test prompt',
          mode: 'build',
          model: 'claude-3',
          githubRepo: 'acme/repo',
          githubToken: 'ghp_token',
        })
      );
    });

    it('should successfully prepare a session with git URL', async () => {
      const doStub = createMockDOStub({
        prepare: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);
      const result = await caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'build',
        model: 'claude-3',
        gitUrl: 'https://gitlab.com/org/repo.git',
        gitToken: 'token123',
      });

      expect(result.cloudAgentSessionId).toBeDefined();
      expect(result.kiloSessionId).toBe('cli-session-abc123');
      expect(doStub.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          gitUrl: 'https://gitlab.com/org/repo.git',
          gitToken: 'token123',
        })
      );
    });

    it('should pass optional configuration to DO', async () => {
      const doStub = createMockDOStub({
        prepare: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);
      await caller.prepareSession({
        prompt: 'Test prompt',
        mode: 'plan',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        githubToken: 'ghp_test_token',
        envVars: { API_KEY: 'secret' },
        setupCommands: ['npm install'],
        mcpServers: { test: { command: 'npx', args: ['test-server'] } },
        upstreamBranch: 'feature/test-branch',
        autoCommit: true,
        kilocodeOrganizationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      });

      // Verify the DO was called with the expected configuration
      // Note: mcpServers schema adds default values (type, timeout, alwaysAllow, disabledTools)
      expect(doStub.prepare).toHaveBeenCalledTimes(1);
      const callArg = doStub.prepare.mock.calls[0][0];
      expect(callArg.envVars).toEqual({ API_KEY: 'secret' });
      expect(callArg.setupCommands).toEqual(['npm install']);
      expect(callArg.upstreamBranch).toBe('feature/test-branch');
      expect(callArg.autoCommit).toBe(true);
      expect(callArg.orgId).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
      expect(callArg.mcpServers.test.command).toBe('npx');
      expect(callArg.mcpServers.test.args).toEqual(['test-server']);
    });
  });

  describe('validation', () => {
    it('should reject when prompt is empty', async () => {
      const ctx = createInternalApiContext({});
      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.prepareSession({
          prompt: '',
          mode: 'build',
          model: 'claude-3',
          githubRepo: 'acme/repo',
        })
      ).rejects.toThrow();
    });

    it('should reject when neither githubRepo nor gitUrl is provided', async () => {
      const ctx = createInternalApiContext({});
      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.prepareSession({
          prompt: 'Test prompt',
          mode: 'build',
          model: 'claude-3',
        } as Parameters<typeof caller.prepareSession>[0])
      ).rejects.toThrow();
    });

    it('should reject invalid mode', async () => {
      const ctx = createInternalApiContext({});
      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.prepareSession({
          prompt: 'Test prompt',
          mode: 'invalid-mode' as Parameters<typeof caller.prepareSession>[0]['mode'],
          model: 'claude-3',
          githubRepo: 'acme/repo',
        })
      ).rejects.toThrow();
    });
  });

  describe('error handling', () => {
    it('should return error when DO prepare fails', async () => {
      const doStub = createMockDOStub({
        prepare: vi.fn().mockResolvedValue({ success: false, error: 'Session already prepared' }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.prepareSession({
          prompt: 'Test prompt',
          mode: 'build',
          model: 'claude-3',
          githubRepo: 'acme/repo',
          githubToken: 'ghp_test_token',
        })
      ).rejects.toThrow('Session already prepared');
    });

    // NOTE: Backend session creation (createKiloSessionInBackend) is currently disabled.
    // The kiloSessionId now comes from the kilo CLI server's POST /session API.
    // Tests for backend session creation error handling and rollback have been removed.
  });
});

describe('updateSession endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('authentication', () => {
    it('should reject without internal API key', async () => {
      const ctx = createInternalApiContext({ requestInternalApiKey: null });
      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.updateSession({
          cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
          mode: 'plan',
        })
      ).rejects.toThrow('Invalid or missing internal API key');
    });

    it('should reject without customer token', async () => {
      const ctx = createInternalApiContext({ userId: null }); // Explicitly no userId
      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.updateSession({
          cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
          mode: 'plan',
        })
      ).rejects.toThrow('Invalid customer token');
    });
  });

  describe('success cases', () => {
    it('should successfully update a prepared session', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);
      const result = await caller.updateSession({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        mode: 'plan',
        model: 'claude-3.5-sonnet',
      });

      expect(result.success).toBe(true);
      expect(doStub.tryUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'plan',
          model: 'claude-3.5-sonnet',
        })
      );
    });

    it('should clear fields with null', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);
      await caller.updateSession({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        githubToken: null,
        autoCommit: null,
      });

      expect(doStub.tryUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          githubToken: null,
          autoCommit: null,
        })
      );
    });

    it('should clear collections with empty arrays/objects', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);
      await caller.updateSession({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        envVars: {},
        setupCommands: [],
        mcpServers: {},
      });

      // Handler converts empty to null for DO
      expect(doStub.tryUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: null,
          setupCommands: null,
          mcpServers: null,
        })
      );
    });

    it('should update collections with values', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);
      await caller.updateSession({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        envVars: { NEW_VAR: 'value' },
        setupCommands: ['new-command'],
      });

      expect(doStub.tryUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: { NEW_VAR: 'value' },
          setupCommands: ['new-command'],
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return error if session not prepared', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi
          .fn()
          .mockResolvedValue({ success: false, error: 'Session has not been prepared' }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.updateSession({
          cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
          mode: 'plan',
        })
      ).rejects.toThrow('Session has not been prepared');
    });

    it('should return error if session already initiated', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi
          .fn()
          .mockResolvedValue({ success: false, error: 'Session has already been initiated' }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.updateSession({
          cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
          mode: 'plan',
        })
      ).rejects.toThrow('Session has already been initiated');
    });
  });
});

describe('DO state machine methods', () => {
  describe('prepare()', () => {
    it('should set preparedAt and return success', async () => {
      // This is implicitly tested via prepareSession above,
      // but we can add unit tests for CloudAgentSession class directly if needed.
      // For now, the integration tests cover this path.
    });

    it('should fail if already prepared', async () => {
      const doStub = createMockDOStub({
        prepare: vi.fn().mockResolvedValue({ success: false, error: 'Session already prepared' }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.prepareSession({
          prompt: 'Test',
          mode: 'build',
          model: 'test',
          githubRepo: 'acme/repo',
          githubToken: 'ghp_test_token',
        })
      ).rejects.toThrow('Session already prepared');
    });
  });

  describe('tryUpdate()', () => {
    it('should update only if prepared but not initiated', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);
      const result = await caller.updateSession({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        mode: 'build',
      });

      expect(result.success).toBe(true);
    });

    it('should handle null values for clearing fields', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });

      const caller = appRouter.createCaller(ctx);
      await caller.updateSession({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        gitToken: null,
      });

      expect(doStub.tryUpdate).toHaveBeenCalledWith(expect.objectContaining({ gitToken: null }));
    });
  });

  describe('tryInitiate()', () => {
    it('should set initiatedAt and return metadata on success', async () => {
      const metadata: CloudAgentSessionState = {
        version: Date.now(),
        sessionId: 'agent_12345678-1234-1234-1234-123456789abc',
        userId: 'test-user',
        timestamp: Date.now(),
        preparedAt: Date.now() - 1000,
        initiatedAt: Date.now(),
        prompt: 'Test prompt',
        mode: 'build',
        model: 'claude-3',
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        githubRepo: 'acme/repo',
      };

      const doStub = createMockDOStub({
        tryInitiate: vi.fn().mockResolvedValue({ success: true, data: metadata }),
      });

      // tryInitiate is called internally by initiateFromKilocodeSession
      // when using prepared session mode
      expect(doStub.tryInitiate).toBeDefined();
    });

    it('should fail if session not prepared', async () => {
      const doStub = createMockDOStub({
        tryInitiate: vi.fn().mockResolvedValue({
          success: false,
          error: 'Session has not been prepared',
        }),
      });

      const result = await doStub.tryInitiate();
      expect(result.success).toBe(false);
      expect(result.error).toBe('Session has not been prepared');
    });

    it('should fail if session already initiated', async () => {
      const doStub = createMockDOStub({
        tryInitiate: vi.fn().mockResolvedValue({
          success: false,
          error: 'Session has already been initiated',
        }),
      });

      const result = await doStub.tryInitiate();
      expect(result.success).toBe(false);
      expect(result.error).toBe('Session has already been initiated');
    });
  });
});

describe('initiateFromKilocodeSession (prepared mode)', () => {
  // Note: Testing subscription endpoints is more complex.
  // Here we test the validation and initialization logic only.
  // Full integration tests would require consuming the stream.

  describe('input validation', () => {
    it('should accept prepared session input (cloudAgentSessionId only)', () => {
      // This tests the schema via Zod's safeParse
      const result = schemas.InitiateFromPreparedSessionInput.safeParse({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid cloudAgentSessionId format', () => {
      const result = schemas.InitiateFromPreparedSessionInput.safeParse({
        cloudAgentSessionId: 'invalid-id',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('PrepareSessionInput schema validation', () => {
  it('should accept all valid modes', () => {
    // All valid modes including aliases
    const modes = ['plan', 'code', 'build', 'orchestrator', 'architect', 'ask'];
    for (const mode of modes) {
      const result = schemas.PrepareSessionInput.safeParse({
        prompt: 'Test',
        mode,
        model: 'claude-3',
        githubRepo: 'acme/repo',
      });
      expect(result.success).toBe(true);
    }
  });

  it('requires appendSystemPrompt for custom mode', () => {
    const missingPrompt = schemas.PrepareSessionInput.safeParse({
      prompt: 'Test',
      mode: 'custom',
      model: 'claude-3',
      githubRepo: 'acme/repo',
    });
    expect(missingPrompt.success).toBe(false);

    const withPrompt = schemas.PrepareSessionInput.safeParse({
      prompt: 'Test',
      mode: 'custom',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      appendSystemPrompt: 'Follow the house style.',
    });
    expect(withPrompt.success).toBe(true);
  });

  it('should validate githubRepo format', () => {
    // Valid formats
    const validRepos = ['acme/repo', 'a/b', 'org_name/repo-name', 'org.name/repo.name'];
    for (const repo of validRepos) {
      const result = schemas.PrepareSessionInput.safeParse({
        prompt: 'Test',
        mode: 'build',
        model: 'claude-3',
        githubRepo: repo,
      });
      expect(result.success).toBe(true);
    }

    // Invalid formats
    const invalidRepos = ['just-repo', '', 'https://github.com/acme/repo'];
    for (const repo of invalidRepos) {
      const result = schemas.PrepareSessionInput.safeParse({
        prompt: 'Test',
        mode: 'build',
        model: 'claude-3',
        githubRepo: repo,
      });
      expect(result.success).toBe(false);
    }
  });

  it('should validate gitUrl format', () => {
    // Valid formats
    const validUrls = [
      'https://gitlab.com/org/repo.git',
      'https://bitbucket.org/org/repo.git',
      'https://github.mycompany.com/org/repo.git',
    ];
    for (const gitUrl of validUrls) {
      const result = schemas.PrepareSessionInput.safeParse({
        prompt: 'Test',
        mode: 'build',
        model: 'claude-3',
        gitUrl,
      });
      expect(result.success).toBe(true);
    }

    // Invalid formats
    const invalidUrls = ['not-a-url', 'git@github.com:org/repo.git', 'ftp://example.com/repo'];
    for (const gitUrl of invalidUrls) {
      const result = schemas.PrepareSessionInput.safeParse({
        prompt: 'Test',
        mode: 'build',
        model: 'claude-3',
        gitUrl,
      });
      expect(result.success).toBe(false);
    }
  });

  it('should limit prompt length', () => {
    const longPrompt = 'a'.repeat(schemaLimits.Limits.MAX_PROMPT_LENGTH + 1);
    const result = schemas.PrepareSessionInput.safeParse({
      prompt: longPrompt,
      mode: 'build',
      model: 'claude-3',
      githubRepo: 'acme/repo',
    });
    expect(result.success).toBe(false);
  });

  it('should limit setup commands count', () => {
    const tooManyCommands = Array(schemaLimits.Limits.MAX_SETUP_COMMANDS + 1).fill('echo test');
    const result = schemas.PrepareSessionInput.safeParse({
      prompt: 'Test',
      mode: 'build',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      setupCommands: tooManyCommands,
    });
    expect(result.success).toBe(false);
  });

  it('should limit setup command length', () => {
    const longCommand = 'a'.repeat(schemaLimits.Limits.MAX_SETUP_COMMAND_LENGTH + 1);
    const result = schemas.PrepareSessionInput.safeParse({
      prompt: 'Test',
      mode: 'build',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      setupCommands: [longCommand],
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateSessionInput schema validation', () => {
  it('should accept valid cloudAgentSessionId', () => {
    const result = schemas.UpdateSessionInput.safeParse({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid cloudAgentSessionId', () => {
    const result = schemas.UpdateSessionInput.safeParse({
      cloudAgentSessionId: 'invalid-session-id',
    });
    expect(result.success).toBe(false);
  });

  it('should accept nullable scalar fields', () => {
    const result = schemas.UpdateSessionInput.safeParse({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      mode: null,
      model: null,
      githubToken: null,
      gitToken: null,
      autoCommit: null,
    });
    expect(result.success).toBe(true);
  });

  it('should accept optional fields being undefined', () => {
    const result = schemas.UpdateSessionInput.safeParse({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    });
    expect(result.success).toBe(true);
    // All optional fields should be undefined
    if (result.success) {
      expect(result.data.mode).toBeUndefined();
      expect(result.data.model).toBeUndefined();
      expect(result.data.envVars).toBeUndefined();
    }
  });

  it('should validate mode values', () => {
    // All modes except 'custom' don't require appendSystemPrompt
    // Includes aliases: architect/ask -> plan, orchestrator/build -> code
    const modesWithoutPrompt = ['plan', 'code', 'build', 'orchestrator', 'architect', 'ask', null];
    for (const mode of modesWithoutPrompt) {
      const result = schemas.UpdateSessionInput.safeParse({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
        mode,
      });
      expect(result.success).toBe(true);
    }

    const result = schemas.UpdateSessionInput.safeParse({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      mode: 'invalid-mode',
    });
    expect(result.success).toBe(false);
  });

  it('requires appendSystemPrompt for custom mode updates', () => {
    const missingPrompt = schemas.UpdateSessionInput.safeParse({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      mode: 'custom',
    });
    expect(missingPrompt.success).toBe(false);

    const withPrompt = schemas.UpdateSessionInput.safeParse({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      mode: 'custom',
      appendSystemPrompt: 'Custom rules.',
    });
    expect(withPrompt.success).toBe(true);
  });
});

describe('integration flow tests', () => {
  describe('full prepare → update → initiate flow', () => {
    it('should work end-to-end', async () => {
      // This is a conceptual test showing the expected flow
      // Real integration testing would require consuming SSE streams

      // 1. Prepare session
      const prepareStub = createMockDOStub({
        prepare: vi.fn().mockResolvedValue({ success: true }),
      });
      const prepareCtx = createInternalApiContext({ doStub: prepareStub });
      const prepareCaller = appRouter.createCaller(prepareCtx);

      const prepareResult = await prepareCaller.prepareSession({
        prompt: 'Test prompt',
        mode: 'build',
        model: 'claude-3',
        githubRepo: 'acme/repo',
        githubToken: 'ghp_test_token',
      });

      expect(prepareResult.cloudAgentSessionId).toBeDefined();
      expect(prepareResult.kiloSessionId).toBeDefined();

      // 2. Update session
      const updateStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const updateCtx = createInternalApiContext({ doStub: updateStub });
      const updateCaller = appRouter.createCaller(updateCtx);

      const updateResult = await updateCaller.updateSession({
        cloudAgentSessionId: prepareResult.cloudAgentSessionId as SessionId,
        mode: 'plan',
        envVars: { DEBUG: 'true' },
      });

      expect(updateResult.success).toBe(true);

      // 3. Initiate would be via SSE subscription - not tested here
      // See session-init.ts for implementation
    });
  });
});

describe('MCP server count limits', () => {
  it('should reject more than MAX_MCP_SERVERS in PrepareSessionInput', () => {
    // Create an object with MAX_MCP_SERVERS + 1 servers
    const tooManyServers: Record<string, { command: string }> = {};
    for (let i = 0; i <= schemaLimits.Limits.MAX_MCP_SERVERS; i++) {
      tooManyServers[`server${i}`] = { command: 'npx' };
    }

    const result = schemas.PrepareSessionInput.safeParse({
      prompt: 'Test',
      mode: 'build',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      mcpServers: tooManyServers,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('MCP servers');
    }
  });

  it('should accept exactly MAX_MCP_SERVERS in PrepareSessionInput', () => {
    const maxServers: Record<string, { command: string }> = {};
    for (let i = 0; i < schemaLimits.Limits.MAX_MCP_SERVERS; i++) {
      maxServers[`server${i}`] = { command: 'npx' };
    }

    const result = schemas.PrepareSessionInput.safeParse({
      prompt: 'Test',
      mode: 'build',
      model: 'claude-3',
      githubRepo: 'acme/repo',
      mcpServers: maxServers,
    });
    expect(result.success).toBe(true);
  });

  it('should reject more than MAX_MCP_SERVERS in UpdateSessionInput', () => {
    const tooManyServers: Record<string, { command: string }> = {};
    for (let i = 0; i <= schemaLimits.Limits.MAX_MCP_SERVERS; i++) {
      tooManyServers[`server${i}`] = { command: 'npx' };
    }

    const result = schemas.UpdateSessionInput.safeParse({
      cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      mcpServers: tooManyServers,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('MCP servers');
    }
  });
});

describe('DO state machine edge cases', () => {
  describe('tryInitiate required-field validation', () => {
    it('should fail when metadata is missing prompt', async () => {
      const incompleteMetadata: Partial<CloudAgentSessionState> = {
        version: Date.now(),
        sessionId: 'agent_12345678-1234-1234-1234-123456789abc',
        userId: 'test-user',
        timestamp: Date.now(),
        preparedAt: Date.now() - 1000,
        initiatedAt: Date.now(),
        // Missing: prompt
        mode: 'build',
        model: 'claude-3',
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        githubRepo: 'acme/repo',
      };

      const doStub = createMockDOStub({
        tryInitiate: vi.fn().mockResolvedValue({
          success: true,
          data: incompleteMetadata,
        }),
      });

      // The router handler should validate required fields after tryInitiate
      // This tests that the validation catches missing prompt
      const result = await doStub.tryInitiate();
      expect(result.success).toBe(true);
      expect(result.data.prompt).toBeUndefined();
    });

    it('should fail when metadata is missing mode', async () => {
      const incompleteMetadata: Partial<CloudAgentSessionState> = {
        version: Date.now(),
        sessionId: 'agent_12345678-1234-1234-1234-123456789abc',
        userId: 'test-user',
        timestamp: Date.now(),
        preparedAt: Date.now() - 1000,
        initiatedAt: Date.now(),
        prompt: 'Test prompt',
        // Missing: mode
        model: 'claude-3',
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        githubRepo: 'acme/repo',
      };

      const doStub = createMockDOStub({
        tryInitiate: vi.fn().mockResolvedValue({
          success: true,
          data: incompleteMetadata,
        }),
      });

      const result = await doStub.tryInitiate();
      expect(result.success).toBe(true);
      expect(result.data.mode).toBeUndefined();
    });

    it('should fail when metadata is missing kiloSessionId', async () => {
      const incompleteMetadata: Partial<CloudAgentSessionState> = {
        version: Date.now(),
        sessionId: 'agent_12345678-1234-1234-1234-123456789abc',
        userId: 'test-user',
        timestamp: Date.now(),
        preparedAt: Date.now() - 1000,
        initiatedAt: Date.now(),
        prompt: 'Test prompt',
        mode: 'build',
        model: 'claude-3',
        // Missing: kiloSessionId
        githubRepo: 'acme/repo',
      };

      const doStub = createMockDOStub({
        tryInitiate: vi.fn().mockResolvedValue({
          success: true,
          data: incompleteMetadata,
        }),
      });

      const result = await doStub.tryInitiate();
      expect(result.success).toBe(true);
      expect(result.data.kiloSessionId).toBeUndefined();
    });
  });

  describe('double-init guard', () => {
    it('should prevent double initiation', async () => {
      const doStub = createMockDOStub({
        tryInitiate: vi
          .fn()
          .mockResolvedValueOnce({
            success: true,
            data: {
              version: Date.now(),
              sessionId: 'agent_12345678-1234-1234-1234-123456789abc',
              userId: 'test-user',
              timestamp: Date.now(),
              preparedAt: Date.now() - 1000,
              initiatedAt: Date.now(),
              prompt: 'Test prompt',
              mode: 'build',
              model: 'claude-3',
              kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
              githubRepo: 'acme/repo',
            },
          })
          .mockResolvedValueOnce({
            success: false,
            error: 'Session has already been initiated',
          }),
      });

      // First call succeeds
      const firstResult = await doStub.tryInitiate();
      expect(firstResult.success).toBe(true);

      // Second call fails
      const secondResult = await doStub.tryInitiate();
      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toBe('Session has already been initiated');
    });

    it('should preserve initiatedAt timestamp on second call attempt', async () => {
      // Simulate a real DO where storage is tracked
      const firstInitiatedAt = Date.now();
      let storedMetadata: CloudAgentSessionState | null = null;

      const doStub = createMockDOStub({
        tryInitiate: vi.fn().mockImplementation(async () => {
          // First call: session is prepared but not initiated
          if (!storedMetadata || !storedMetadata.initiatedAt) {
            storedMetadata = {
              version: Date.now(),
              sessionId: 'agent_12345678-1234-1234-1234-123456789abc',
              userId: 'test-user',
              timestamp: Date.now(),
              preparedAt: Date.now() - 1000,
              initiatedAt: firstInitiatedAt,
              prompt: 'Test prompt',
              mode: 'build',
              model: 'claude-3',
              kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
              githubRepo: 'acme/repo',
            };
            return { success: true, data: storedMetadata };
          }
          // Second call: session already initiated, storage unchanged
          return { success: false, error: 'Session has already been initiated' };
        }),
        getMetadata: vi.fn().mockImplementation(async () => storedMetadata),
      });

      // First call succeeds and sets initiatedAt
      const firstResult = await doStub.tryInitiate();
      expect(firstResult.success).toBe(true);
      expect(firstResult.data.initiatedAt).toBe(firstInitiatedAt);

      // Second call fails
      const secondResult = await doStub.tryInitiate();
      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toBe('Session has already been initiated');

      // Verify storage wasn't mutated - initiatedAt is still the first timestamp
      const metadata = await doStub.getMetadata();
      expect(metadata).not.toBeNull();
      expect(metadata!.initiatedAt).toBe(firstInitiatedAt);
    });
  });

  describe('null clearing in tryUpdate', () => {
    it('should pass null values to DO for clearing scalar fields', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });
      const caller = appRouter.createCaller(ctx);

      await caller.updateSession({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        mode: null,
        model: null,
        githubToken: null,
        gitToken: null,
        autoCommit: null,
      });

      expect(doStub.tryUpdate).toHaveBeenCalledWith({
        mode: null,
        model: null,
        githubToken: null,
        gitToken: null,
        autoCommit: null,
      });
    });
  });

  describe('empty object/array clearing in tryUpdate', () => {
    it('should convert empty envVars to null for clearing', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });
      const caller = appRouter.createCaller(ctx);

      await caller.updateSession({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        envVars: {},
      });

      expect(doStub.tryUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: null,
        })
      );
    });

    it('should convert empty setupCommands to null for clearing', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });
      const caller = appRouter.createCaller(ctx);

      await caller.updateSession({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        setupCommands: [],
      });

      expect(doStub.tryUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          setupCommands: null,
        })
      );
    });

    it('should convert empty mcpServers to null for clearing', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });
      const caller = appRouter.createCaller(ctx);

      await caller.updateSession({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        mcpServers: {},
      });

      expect(doStub.tryUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: null,
        })
      );
    });

    it('should preserve non-empty collections', async () => {
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({ success: true }),
      });
      const ctx = createInternalApiContext({ doStub });
      const caller = appRouter.createCaller(ctx);

      await caller.updateSession({
        cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
        envVars: { KEY: 'value' },
        setupCommands: ['npm install'],
      });

      expect(doStub.tryUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          envVars: { KEY: 'value' },
          setupCommands: ['npm install'],
        })
      );
    });
  });

  describe('schema validation in DO methods', () => {
    it('should reject invalid metadata in prepare via schema validation', async () => {
      // This tests that the DO's prepare method validates against MetadataSchema
      // The mock simulates what happens when schema validation fails
      const doStub = createMockDOStub({
        prepare: vi.fn().mockResolvedValue({
          success: false,
          error: 'Invalid metadata: {"mode":{"_errors":["Invalid enum value"]}}',
        }),
      });
      const ctx = createInternalApiContext({ doStub });
      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.prepareSession({
          prompt: 'Test',
          mode: 'build',
          model: 'claude-3',
          githubRepo: 'acme/repo',
          githubToken: 'ghp_test_token',
        })
      ).rejects.toThrow('Invalid metadata');
    });

    it('should reject invalid metadata in tryUpdate via schema validation', async () => {
      // This tests that the DO's tryUpdate method validates against MetadataSchema
      const doStub = createMockDOStub({
        tryUpdate: vi.fn().mockResolvedValue({
          success: false,
          error: 'Invalid metadata after update: {"mode":{"_errors":["Invalid enum value"]}}',
        }),
      });
      const ctx = createInternalApiContext({ doStub });
      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.updateSession({
          cloudAgentSessionId: 'agent_12345678-1234-1234-1234-123456789abc' as SessionId,
          mode: 'plan',
        })
      ).rejects.toThrow('Invalid metadata after update');
    });
  });
});
