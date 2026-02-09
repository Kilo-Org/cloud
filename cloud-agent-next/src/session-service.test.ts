import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

vi.mock('./workspace.js', () => {
  const setupWorkspace = vi.fn();
  const cloneGitHubRepo = vi.fn();
  const cloneGitRepo = vi.fn();
  const manageBranch = vi.fn();
  const restoreWorkspace = vi.fn();
  const checkDiskSpace = vi.fn().mockResolvedValue({ availableMB: 5000, totalMB: 10000 });

  return {
    setupWorkspace,
    cloneGitHubRepo,
    cloneGitRepo,
    manageBranch,
    restoreWorkspace,
    checkDiskSpace,
    getSessionHomePath: (sessionId: string) => `/home/${sessionId}`,
    getSessionWorkspacePath: (orgId: string, userId: string, sessionId: string) =>
      `/workspace/${orgId}/${userId}/sessions/${sessionId}`,
    getKilocodeCliDir: (sessionHome: string) => `${sessionHome}/.kilocode/cli`,
    getKilocodeTasksDir: (sessionHome: string) => `${sessionHome}/.kilocode/cli/global/tasks`,
    getKilocodeLogsDir: (sessionHome: string) => `${sessionHome}/.kilocode/cli/logs`,
  };
});

const streamKilocodeExecutionMock = vi.hoisted(() => vi.fn());
vi.mock('./streaming.js', () => ({
  streamKilocodeExecution: streamKilocodeExecutionMock,
}));

import {
  setupWorkspace as mockSetupWorkspace,
  cloneGitHubRepo as mockCloneGitHubRepo,
  manageBranch as mockManageBranch,
  restoreWorkspace as mockRestoreWorkspace,
} from './workspace.js';
import { InvalidSessionMetadataError, SessionService } from './session-service.js';
import type { SandboxInstance, SessionId, SessionContext, ExecutionSession } from './types.js';
import type { PersistenceEnv, CloudAgentSessionState } from './persistence/types.js';

describe('SessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.SESSION_INGEST.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ info: {}, messages: [] })),
    }) as unknown as PersistenceEnv['SESSION_INGEST']['fetch'];
  });

  const mockedSetupWorkspace = vi.mocked(mockSetupWorkspace);

  // Mock environment for tests
  const mockEnv: PersistenceEnv = {
    Sandbox: {} as unknown as PersistenceEnv['Sandbox'],
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn().mockReturnValue('mock-id' as unknown as DurableObjectId),
      get: vi.fn().mockReturnValue({
        getMetadata: vi.fn().mockResolvedValue({
          version: 12345,
          sessionId: 'test',
          orgId: 'org',
          userId: 'user',
          timestamp: 12345,
        }),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as PersistenceEnv['CLOUD_AGENT_SESSION'],
    NEXTAUTH_SECRET: 'mock-secret',
    SESSION_INGEST: {
      fetch: vi.fn(),
    } as unknown as PersistenceEnv['SESSION_INGEST'],
  };

  const createMetadataEnv = (
    overrides?: Partial<{
      getMetadata: ReturnType<typeof vi.fn>;
      updateMetadata: ReturnType<typeof vi.fn>;
      updateUpstreamBranch: ReturnType<typeof vi.fn>;
      deleteSession: ReturnType<typeof vi.fn>;
    }>
  ) => {
    const metadataStub = {
      getMetadata: vi.fn().mockResolvedValue(null),
      updateMetadata: vi.fn().mockResolvedValue(undefined),
      updateUpstreamBranch: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as ReturnType<PersistenceEnv['CLOUD_AGENT_SESSION']['get']>;

    const env: PersistenceEnv = {
      ...mockEnv,
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'mock-do-id' as unknown as DurableObjectId),
        get: vi.fn().mockReturnValue(metadataStub),
      } as unknown as PersistenceEnv['CLOUD_AGENT_SESSION'],
    };

    return { env, metadataStub };
  };

  describe('initiate', () => {
    it('provisions workspace, clones repo, and creates session branch directly', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_test_123';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const result = await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
      });

      expect(mockSetupWorkspace).toHaveBeenCalledWith(sandbox, 'user', 'org', sessionId);
      expect(sandboxCreateSession).toHaveBeenCalledWith({
        name: sessionId,
        env: {
          HOME: `/home/${sessionId}`,
          SESSION_ID: sessionId,
          SESSION_HOME: `/home/${sessionId}`,
          KILOCODE_TOKEN: 'token',
          KILOCODE_ORGANIZATION_ID: 'org',
          KILO_PLATFORM: 'cloud-agent',
          OPENCODE_CONFIG_CONTENT: `{"permission":{"external_directory":{"/tmp/attachments/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
          KILO_CONFIG_CONTENT: `{"permission":{"external_directory":{"/tmp/attachments/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
        },
        cwd: `/workspace/org/user/sessions/${sessionId}`,
      });
      expect(mockCloneGitHubRepo).toHaveBeenCalledWith(
        fakeSession,
        `/workspace/org/user/sessions/${sessionId}`,
        'acme/repo',
        undefined,
        { GITHUB_APP_SLUG: undefined, GITHUB_APP_BOT_USER_ID: undefined },
        undefined
      );
      // For session branches, manageBranch should NOT be called
      expect(mockManageBranch).not.toHaveBeenCalled();
      // Instead, session.exec should be called with git checkout -b
      expect(fakeSession.exec).toHaveBeenCalledWith(
        expect.stringContaining(`git checkout -b 'session/${sessionId}'`)
      );
      expect(result.context.sessionId).toBe(sessionId);
      expect(result.streamKilocodeExec).toBeDefined();
    });

    it('does not restore session snapshot during initiate (no fetch)', async () => {
      const payload = JSON.stringify({ info: {}, messages: [] });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(payload),
      });
      const envWithIngest: PersistenceEnv = {
        ...mockEnv,
        SESSION_INGEST: {
          fetch: fetchMock,
        } as unknown as PersistenceEnv['SESSION_INGEST'],
      };

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_restore_test_skip';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: envWithIngest,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(fakeSession.writeFile).not.toHaveBeenCalled();
      expect(fakeSession.exec).not.toHaveBeenCalledWith(
        `kilo import "/tmp/kilo-session-export-${sessionId}.json"`
      );
      expect(fakeSession.deleteFile).not.toHaveBeenCalledWith(
        `/tmp/kilo-session-export-${sessionId}.json`
      );
    });

    it('uses manageBranch for upstream branches during initiate', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_test_456';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const upstreamBranch = 'feature/my-branch';
      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
        upstreamBranch,
      });

      // For upstream branches, manageBranch SHOULD be called
      expect(mockManageBranch).toHaveBeenCalledWith(
        fakeSession,
        `/workspace/org/user/sessions/${sessionId}`,
        upstreamBranch,
        true
      );
      // git checkout -b should NOT be called directly
      expect(fakeSession.exec).not.toHaveBeenCalledWith(expect.stringContaining('git checkout -b'));
    });
  });

  describe('resume', () => {
    it('resumes existing session (warm start)', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, stdout: 'exists' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const service = new SessionService();
      const sessionId: SessionId = 'agent_test_456';
      const result = await service.resume({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: mockEnv,
      });

      expect(sandboxCreateSession).toHaveBeenCalledWith({
        name: sessionId,
        env: {
          HOME: `/home/${sessionId}`,
          SESSION_ID: sessionId,
          SESSION_HOME: `/home/${sessionId}`,
          KILOCODE_TOKEN: 'token',
          KILOCODE_ORGANIZATION_ID: 'org',
          KILO_PLATFORM: 'cloud-agent',
          OPENCODE_CONFIG_CONTENT: `{"permission":{"external_directory":{"/tmp/attachments/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
          KILO_CONFIG_CONTENT: `{"permission":{"external_directory":{"/tmp/attachments/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
        },
        cwd: `/workspace/org/user/sessions/${sessionId}`,
      });
      // manageBranch should NOT be called when repo exists (warm start)
      expect(mockManageBranch).not.toHaveBeenCalled();
      expect(result.context.sessionId).toBe(sessionId);
      expect(result.streamKilocodeExec).toBeDefined();
    });
  });

  describe('streamKilocodeExec first-execution handling', () => {
    const noopStream = async function* () {};

    it('passes isFirstExecution=true only on first initiate call', async () => {
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_first_call';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const result = await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
      });

      // Consume the generators to trigger the underlying streamKilocodeExecution calls
      for await (const _ of result.streamKilocodeExec('code', 'prompt-1')) {
        // noop - just consume
      }
      for await (const _ of result.streamKilocodeExec('code', 'prompt-2', {
        sessionId: 'custom-session',
      })) {
        // noop - just consume
      }

      expect(streamKilocodeExecutionMock).toHaveBeenNthCalledWith(
        1,
        sandbox,
        fakeSession,
        expect.objectContaining({ sessionId }),
        'code',
        'prompt-1',
        { isFirstExecution: true, kiloSessionId: undefined },
        mockEnv
      );
      expect(streamKilocodeExecutionMock).toHaveBeenNthCalledWith(
        2,
        sandbox,
        fakeSession,
        expect.objectContaining({ sessionId }),
        'code',
        'prompt-2',
        { sessionId: 'custom-session', isFirstExecution: false, kiloSessionId: undefined },
        mockEnv
      );
    });

    it('always passes isFirstExecution=false when resuming', async () => {
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: 'exists' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_resume_first_flag';

      const service = new SessionService();
      const result = await service.resume({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: mockEnv,
      });

      result.streamKilocodeExec('code', 'prompt');

      expect(streamKilocodeExecutionMock).toHaveBeenCalledWith(
        sandbox,
        fakeSession,
        expect.objectContaining({ sessionId }),
        'code',
        'prompt',
        expect.objectContaining({ isFirstExecution: false, kiloSessionId: undefined }),
        mockEnv
      );
    });

    it('passes kiloSessionId from metadata when resuming', async () => {
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      const kiloSessionId = '123e4567-e89b-12d3-a456-426614174000';
      const { env: metadataEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue({
          version: 12345,
          sessionId: 'agent_resume_kilo',
          orgId: 'org',
          userId: 'user',
          timestamp: 12345,
          kiloSessionId,
        }),
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: 'exists' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;

      const service = new SessionService();
      const result = await service.resume({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId: 'agent_resume_kilo',
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: metadataEnv,
      });

      result.streamKilocodeExec('code', 'prompt');

      expect(streamKilocodeExecutionMock).toHaveBeenCalledWith(
        sandbox,
        fakeSession,
        expect.objectContaining({ sessionId: 'agent_resume_kilo' }),
        'code',
        'prompt',
        expect.objectContaining({ isFirstExecution: false, kiloSessionId }),
        metadataEnv
      );
    });

    it('captures and reuses kiloSessionId from session_created event', async () => {
      const capturedKiloSessionId = '123e4567-e89b-12d3-a456-426614174000';

      // Mock stream that emits session_created event
      const mockStreamWithSessionCreated = async function* () {
        yield {
          streamEventType: 'kilocode',
          payload: {
            event: 'session_created',
            sessionId: capturedKiloSessionId,
          },
        };
      };

      streamKilocodeExecutionMock.mockReturnValue(mockStreamWithSessionCreated());

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_capture_test';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const result = await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
      });

      // First call - should not have kiloSessionId
      for await (const _ of result.streamKilocodeExec('code', 'prompt-1')) {
        // noop - consumes stream and captures sessionId
      }

      // Second call - should reuse captured kiloSessionId
      streamKilocodeExecutionMock.mockReturnValue(noopStream());
      for await (const _ of result.streamKilocodeExec('code', 'prompt-2')) {
        // noop
      }

      // Verify first call had no kiloSessionId
      expect(streamKilocodeExecutionMock).toHaveBeenNthCalledWith(
        1,
        sandbox,
        fakeSession,
        expect.objectContaining({ sessionId }),
        'code',
        'prompt-1',
        { isFirstExecution: true, kiloSessionId: undefined },
        mockEnv
      );

      // Verify second call reused captured kiloSessionId
      expect(streamKilocodeExecutionMock).toHaveBeenNthCalledWith(
        2,
        sandbox,
        fakeSession,
        expect.objectContaining({ sessionId }),
        'code',
        'prompt-2',
        { isFirstExecution: false, kiloSessionId: capturedKiloSessionId },
        mockEnv
      );
    });
  });

  describe('resume with conditional reclone', () => {
    const sessionId: SessionId = 'agent_test_789';
    const orgId = 'org123';
    const userId = 'user456';

    it('should reclone repository when workspace is missing and metadata exists', async () => {
      const fakeSession = {
        exec: vi
          .fn()
          .mockResolvedValueOnce({ success: true, exitCode: 1, stdout: '', stderr: '' }) // repo check fails
          .mockResolvedValue({ success: true, exitCode: 0 }), // subsequent calls succeed
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;

      const mockDOGetMetadata = vi.fn();
      const testEnv = {
        ...mockEnv,
        CLOUD_AGENT_SESSION: {
          idFromName: vi.fn(() => 'mock-do-id' as unknown as DurableObjectId),
          get: vi.fn(() => ({
            getMetadata: mockDOGetMetadata,
            updateMetadata: vi.fn().mockResolvedValue(undefined),
            deleteSession: vi.fn().mockResolvedValue(undefined),
          })),
        } as unknown as PersistenceEnv['CLOUD_AGENT_SESSION'],
      };

      // Mock: DO returns metadata with repo info
      const metadata = {
        version: 123456789,
        sessionId,
        orgId,
        userId,
        timestamp: 123456789,
        githubRepo: 'facebook/react',
        githubToken: 'test-token',
      };
      mockDOGetMetadata.mockResolvedValue(metadata);

      const service = new SessionService();
      const result = await service.resume({
        sandbox,
        sandboxId: `${orgId}__${userId}`,
        orgId,
        userId,
        sessionId,
        kilocodeToken: 'test-token',
        kilocodeModel: 'test-model',
        env: testEnv,
      });

      // Verify restoreWorkspace was called with correct options
      expect(mockRestoreWorkspace).toHaveBeenCalledWith(
        fakeSession,
        `/workspace/${orgId}/${userId}/sessions/${sessionId}`,
        `session/${sessionId}`,
        expect.objectContaining({
          githubRepo: 'facebook/react',
          githubToken: 'test-token',
        })
      );

      // Verify context includes repo info
      expect(result.context.githubRepo).toBe('facebook/react');
      expect(result.context.githubToken).toBe('test-token');
    });

    it('should use fresh githubToken from request instead of stale metadata token during reclone', async () => {
      const fakeSession = {
        exec: vi
          .fn()
          .mockResolvedValueOnce({ success: true, exitCode: 1, stdout: '', stderr: '' }) // repo check fails
          .mockResolvedValue({ success: true, exitCode: 0 }), // subsequent calls succeed
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;

      const mockDOGetMetadata = vi.fn();
      const testEnv = {
        ...mockEnv,
        CLOUD_AGENT_SESSION: {
          idFromName: vi.fn(() => 'mock-do-id' as unknown as DurableObjectId),
          get: vi.fn(() => ({
            getMetadata: mockDOGetMetadata,
            updateMetadata: vi.fn().mockResolvedValue(undefined),
            deleteSession: vi.fn().mockResolvedValue(undefined),
          })),
        } as unknown as PersistenceEnv['CLOUD_AGENT_SESSION'],
      };

      // Mock: DO returns metadata with STALE token
      const metadata = {
        version: 123456789,
        sessionId,
        orgId,
        userId,
        timestamp: 123456789,
        githubRepo: 'facebook/react',
        githubToken: 'stale-token-from-metadata',
      };
      mockDOGetMetadata.mockResolvedValue(metadata);

      const service = new SessionService();
      const freshToken = 'fresh-token-from-request';
      await service.resume({
        sandbox,
        sandboxId: `${orgId}__${userId}`,
        orgId,
        userId,
        sessionId,
        kilocodeToken: 'test-token',
        kilocodeModel: 'test-model',
        env: testEnv,
        // Pass fresh token from request
        githubToken: freshToken,
      });

      // Verify restoreWorkspace was called with FRESH token, not stale metadata token
      expect(mockRestoreWorkspace).toHaveBeenCalledWith(
        fakeSession,
        `/workspace/${orgId}/${userId}/sessions/${sessionId}`,
        `session/${sessionId}`,
        expect.objectContaining({
          githubRepo: 'facebook/react',
          githubToken: freshToken, // Should use fresh token, not 'stale-token-from-metadata'
        })
      );
    });

    it('should fall back to metadata token when no fresh token provided during reclone', async () => {
      const fakeSession = {
        exec: vi
          .fn()
          .mockResolvedValueOnce({ success: true, exitCode: 1, stdout: '', stderr: '' }) // repo check fails
          .mockResolvedValue({ success: true, exitCode: 0 }), // subsequent calls succeed
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;

      const mockDOGetMetadata = vi.fn();
      const testEnv = {
        ...mockEnv,
        CLOUD_AGENT_SESSION: {
          idFromName: vi.fn(() => 'mock-do-id' as unknown as DurableObjectId),
          get: vi.fn(() => ({
            getMetadata: mockDOGetMetadata,
            updateMetadata: vi.fn().mockResolvedValue(undefined),
            deleteSession: vi.fn().mockResolvedValue(undefined),
          })),
        } as unknown as PersistenceEnv['CLOUD_AGENT_SESSION'],
      };

      // Mock: DO returns metadata with token
      const metadata = {
        version: 123456789,
        sessionId,
        orgId,
        userId,
        timestamp: 123456789,
        githubRepo: 'facebook/react',
        githubToken: 'metadata-token',
      };
      mockDOGetMetadata.mockResolvedValue(metadata);

      const service = new SessionService();
      await service.resume({
        sandbox,
        sandboxId: `${orgId}__${userId}`,
        orgId,
        userId,
        sessionId,
        kilocodeToken: 'test-token',
        kilocodeModel: 'test-model',
        env: testEnv,
        // No fresh token provided
      });

      // Verify restoreWorkspace was called with metadata token as fallback
      expect(mockRestoreWorkspace).toHaveBeenCalledWith(
        fakeSession,
        `/workspace/${orgId}/${userId}/sessions/${sessionId}`,
        `session/${sessionId}`,
        expect.objectContaining({
          githubRepo: 'facebook/react',
          githubToken: 'metadata-token', // Should fall back to metadata token
        })
      );
    });

    it('should throw error when workspace is missing and no metadata exists', async () => {
      const mockDOGetMetadata = vi.fn();
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 1, stdout: '', stderr: '' }),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;

      const testEnv = {
        ...mockEnv,
        CLOUD_AGENT_SESSION: {
          idFromName: vi.fn(() => 'mock-do-id' as unknown as DurableObjectId),
          get: vi.fn(() => ({
            getMetadata: mockDOGetMetadata,
            updateMetadata: vi.fn().mockResolvedValue(undefined),
            deleteSession: vi.fn().mockResolvedValue(undefined),
          })),
        } as unknown as PersistenceEnv['CLOUD_AGENT_SESSION'],
      };

      // Mock: DO returns null
      mockDOGetMetadata.mockResolvedValue(null);

      const service = new SessionService();
      await expect(
        service.resume({
          sandbox,
          sandboxId: `${orgId}__${userId}`,
          orgId,
          userId,
          sessionId,
          kilocodeToken: 'test-token',
          kilocodeModel: 'test-model',
          env: testEnv,
        })
      ).rejects.toThrow('workspace is missing and metadata could not be retrieved');
    });

    it('restores session snapshot before reclone when workspace is missing', async () => {
      const mockDOGetMetadata = vi.fn();
      const payload = JSON.stringify({ info: {}, messages: [] });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(payload),
      });
      const envWithIngest: PersistenceEnv = {
        ...mockEnv,
        SESSION_INGEST: {
          fetch: fetchMock,
        } as unknown as PersistenceEnv['SESSION_INGEST'],
        CLOUD_AGENT_SESSION: {
          idFromName: vi.fn(() => 'mock-do-id' as unknown as DurableObjectId),
          get: vi.fn(() => ({
            getMetadata: mockDOGetMetadata,
            updateMetadata: vi.fn().mockResolvedValue(undefined),
            deleteSession: vi.fn().mockResolvedValue(undefined),
          })),
        } as unknown as PersistenceEnv['CLOUD_AGENT_SESSION'],
      };
      const fakeSession = {
        exec: vi
          .fn()
          .mockResolvedValueOnce({ success: true, exitCode: 1, stdout: '', stderr: '' })
          .mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;

      const metadata = {
        version: 123456789,
        sessionId,
        orgId,
        userId,
        timestamp: 123456789,
        githubRepo: 'facebook/react',
        githubToken: 'test-token',
      };
      mockDOGetMetadata.mockResolvedValue(metadata);

      const service = new SessionService();
      const result = await service.resume({
        sandbox,
        sandboxId: `${orgId}__${userId}`,
        orgId,
        userId,
        sessionId,
        kilocodeToken: 'test-token',
        kilocodeModel: 'test-model',
        env: envWithIngest,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        `https://session-ingest/api/session/${sessionId}/export`,
        {
          headers: {
            Authorization: 'Bearer test-token',
          },
        }
      );
      expect(fakeSession.writeFile).toHaveBeenCalledWith(
        `/tmp/kilo-session-export-${sessionId}.json`,
        payload
      );
      expect(fakeSession.exec).toHaveBeenCalledWith(
        `kilo import "/tmp/kilo-session-export-${sessionId}.json"`
      );
      expect(fakeSession.deleteFile).toHaveBeenCalledWith(
        `/tmp/kilo-session-export-${sessionId}.json`
      );
      expect(result.context.githubRepo).toBe('facebook/react');
      expect(result.context.githubToken).toBe('test-token');
    });
  });

  describe('Environment Variable Injection', () => {
    it('should inject envVars into session environment', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_envtest_123';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const envVars = {
        API_KEY: 'test-key-123',
        DATABASE_URL: 'postgres://localhost:5432/test',
        NODE_ENV: 'development',
      };

      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
        envVars,
      });

      expect(sandboxCreateSession).toHaveBeenCalledWith({
        name: sessionId,
        env: {
          HOME: `/home/${sessionId}`,
          SESSION_ID: sessionId,
          SESSION_HOME: `/home/${sessionId}`,
          KILOCODE_TOKEN: 'token',
          KILOCODE_ORGANIZATION_ID: 'org',
          KILO_PLATFORM: 'cloud-agent',
          OPENCODE_CONFIG_CONTENT: `{"permission":{"external_directory":{"/tmp/attachments/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
          KILO_CONFIG_CONTENT: `{"permission":{"external_directory":{"/tmp/attachments/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
          API_KEY: 'test-key-123',
          DATABASE_URL: 'postgres://localhost:5432/test',
          NODE_ENV: 'development',
        },
        cwd: `/workspace/org/user/sessions/${sessionId}`,
      });
    });

    it('should handle special characters in env var values', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_special_chars';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const envVars = {
        PASSWORD: 'p@ssw0rd!#$%',
        JSON_CONFIG: '{"key":"value with spaces"}',
        PATH_WITH_COLON: '/usr/bin:/usr/local/bin',
      };

      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
        envVars,
      });

      expect(sandboxCreateSession).toHaveBeenCalledWith({
        name: sessionId,
        env: expect.objectContaining({
          PASSWORD: 'p@ssw0rd!#$%',
          JSON_CONFIG: '{"key":"value with spaces"}',
          PATH_WITH_COLON: '/usr/bin:/usr/local/bin',
        }),
        cwd: `/workspace/org/user/sessions/${sessionId}`,
      });
    });

    it('should work without envVars (optional)', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_no_env';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
        // No envVars provided
      });

      expect(sandboxCreateSession).toHaveBeenCalledWith({
        name: sessionId,
        env: {
          HOME: `/home/${sessionId}`,
          SESSION_ID: sessionId,
          SESSION_HOME: `/home/${sessionId}`,
          KILOCODE_TOKEN: 'token',
          KILOCODE_ORGANIZATION_ID: 'org',
          KILO_PLATFORM: 'cloud-agent',
          OPENCODE_CONFIG_CONTENT: `{"permission":{"external_directory":{"/tmp/attachments/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
          KILO_CONFIG_CONTENT: `{"permission":{"external_directory":{"/tmp/attachments/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
        },
        cwd: `/workspace/org/user/sessions/${sessionId}`,
      });
    });
  });

  describe('GH_TOKEN Auto-Setting', () => {
    it('should set GH_TOKEN from githubToken when provided', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_gh_token_test';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const githubToken = 'ghp_test123';

      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        githubToken,
        env: mockEnv,
      });

      expect(sandboxCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            GH_TOKEN: 'ghp_test123',
          }),
        })
      );
    });

    it('should NOT overwrite user-provided GH_TOKEN', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_gh_token_override';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const githubToken = 'ghp_auto_token';
      const userProvidedToken = 'ghp_user_token';

      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        githubToken,
        envVars: {
          GH_TOKEN: userProvidedToken,
        },
        env: mockEnv,
      });

      // Should use user-provided value, not githubToken
      expect(sandboxCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            GH_TOKEN: userProvidedToken,
          }),
        })
      );
    });

    it('should NOT set GH_TOKEN when githubToken is not provided', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_no_gh_token';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();

      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        // No githubToken provided
        env: mockEnv,
      });

      const callArgs = sandboxCreateSession.mock.calls[0][0];
      expect(callArgs.env).not.toHaveProperty('GH_TOKEN');
    });

    it('should NOT set GH_TOKEN when githubToken is empty string', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_empty_gh_token';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();

      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        githubToken: '', // Empty string
        env: mockEnv,
      });

      const callArgs = sandboxCreateSession.mock.calls[0][0];
      expect(callArgs.env).not.toHaveProperty('GH_TOKEN');
    });

    it('should NOT set GH_TOKEN when gitUrl is used even if githubToken is provided', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_giturl_with_ghtoken';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();

      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        gitUrl: 'https://gitlab.com/acme/repo.git', // Using gitUrl, NOT githubRepo
        githubToken: 'ghp_should_be_ignored', // githubToken provided but should be ignored
        env: mockEnv,
      });

      // Should NOT set GH_TOKEN because this is not a GitHub repo (no githubRepo)
      const callArgs = sandboxCreateSession.mock.calls[0][0];
      expect(callArgs.env).not.toHaveProperty('GH_TOKEN');
    });
  });

  describe('Setup Commands Execution', () => {
    it('should continue executing commands when one fails during resume (lenient)', async () => {
      const metadata = {
        version: 123456789,
        sessionId: 'agent_setup_test',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'acme/repo',
        setupCommands: ['npm install', 'npm run build', 'npm test'],
      };

      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(metadata),
      });

      const execResults = [
        { success: true, exitCode: 0, stdout: '' }, // repo check - repo doesn't exist
        { success: true, exitCode: 0, stdout: '' }, // kilo import succeeds
        { success: true, exitCode: 0, stdout: 'command 1 ok', stderr: '' }, // npm install
        { success: false, exitCode: 1, stdout: '', stderr: 'command 2 failed' }, // npm run build fails
        { success: true, exitCode: 0, stdout: 'command 3 ok', stderr: '' }, // npm test
      ];

      const fakeSession = {
        exec: vi
          .fn()
          .mockResolvedValueOnce(execResults[0])
          .mockResolvedValueOnce(execResults[1])
          .mockResolvedValueOnce(execResults[2])
          .mockResolvedValueOnce(execResults[3])
          .mockResolvedValueOnce(execResults[4]),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;

      const service = new SessionService();
      const sessionId: SessionId = 'agent_setup_test';

      // Should not throw even though middle command fails during resume (lenient mode)
      await service.resume({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: testEnv,
      });

      // All three setup commands should be executed (after the initial repo check)
      expect(fakeSession.exec).toHaveBeenCalledTimes(5); // 1 repo check + 1 import + 3 setup commands
      expect(fakeSession.exec).toHaveBeenNthCalledWith(3, 'npm install', {
        cwd: `/workspace/org/user/sessions/${sessionId}`,
        timeout: 120000,
      });
      expect(fakeSession.exec).toHaveBeenNthCalledWith(4, 'npm run build', {
        cwd: `/workspace/org/user/sessions/${sessionId}`,
        timeout: 120000,
      });
      expect(fakeSession.exec).toHaveBeenNthCalledWith(5, 'npm test', {
        cwd: `/workspace/org/user/sessions/${sessionId}`,
        timeout: 120000,
      });
    });

    it('should throw immediately when command fails during initiate (fail-fast)', async () => {
      const setupCommands = [
        'npm install', // succeeds
        'npm install -g fake-package', // fails - should throw here
        'echo "never runs"', // should not execute
      ];

      const fakeSession = {
        exec: vi
          .fn()
          .mockResolvedValueOnce({ exitCode: 0, stdout: 'installed', stderr: '' }) // git checkout -b succeeds
          .mockResolvedValueOnce({ exitCode: 0, stdout: 'installed', stderr: '' }) // npm install succeeds
          .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'ERR! 404 Not Found' }), // npm install -g fails
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_failfast_test';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();

      // Should throw when second command fails
      await expect(
        service.initiate({
          sandbox,
          sandboxId: 'org__user',
          orgId: 'org',
          userId: 'user',
          sessionId,
          kilocodeToken: 'token',
          kilocodeModel: 'test-model',
          githubRepo: 'acme/repo',
          env: mockEnv,
          setupCommands,
        })
      ).rejects.toMatchObject({
        name: 'SetupCommandFailedError',
        command: 'npm install -g fake-package',
        exitCode: 1,
        stderr: 'ERR! 404 Not Found',
      });

      // Verify only three calls: git checkout -b + first setup command + second setup command that failed
      expect(fakeSession.exec).toHaveBeenCalledTimes(3);
    });

    it('should run commands with 2-minute timeout', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_timeout_test';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
        setupCommands: ['long-running-command'],
      });

      expect(fakeSession.exec).toHaveBeenCalledWith('long-running-command', {
        cwd: `/workspace/org/user/sessions/${sessionId}`,
        timeout: 120000, // 2 minutes in milliseconds
      });
    });

    it('should execute commands in workspace directory', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_cwd_test';
      const workspacePath = `/workspace/org/user/sessions/${sessionId}`;
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
        setupCommands: ['pwd', 'ls -la'],
      });

      expect(fakeSession.exec).toHaveBeenCalledWith('pwd', {
        cwd: workspacePath,
        timeout: 120000,
      });
      expect(fakeSession.exec).toHaveBeenCalledWith('ls -la', {
        cwd: workspacePath,
        timeout: 120000,
      });
    });

    it('should handle empty setupCommands array gracefully', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_empty_commands';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
        setupCommands: [], // Empty array
      });

      // exec should only be called once for git checkout -b, not for setup commands
      expect(fakeSession.exec).toHaveBeenCalledTimes(1);
      expect(fakeSession.exec).toHaveBeenCalledWith(expect.stringContaining('git checkout -b'));
    });
  });

  describe('MCP Settings File Writing', () => {
    it('should create directory and write file to correct path', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxExec = vi.fn().mockResolvedValue({ exitCode: 0 });
      const sandboxWriteFile = vi.fn().mockResolvedValue(undefined);
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: sandboxExec,
        writeFile: sandboxWriteFile,
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_mcp_test';
      const sessionHome = `/home/${sessionId}`;
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome,
      });

      const service = new SessionService();
      const mcpServers = {
        puppeteer: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-puppeteer'],
        },
      };

      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
        mcpServers,
      });

      // Verify directory creation
      expect(sandboxExec).toHaveBeenCalledWith(
        `mkdir -p ${sessionHome}/.kilocode/cli/global/settings`
      );

      // Verify file write
      expect(sandboxWriteFile).toHaveBeenCalledWith(
        `${sessionHome}/.kilocode/cli/global/settings/mcp_settings.json`,
        expect.stringContaining('"mcpServers"')
      );
    });

    it('should handle empty mcpServers gracefully', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxExec = vi.fn().mockResolvedValue({ exitCode: 0 });
      const sandboxWriteFile = vi.fn().mockResolvedValue(undefined);
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: sandboxExec,
        writeFile: sandboxWriteFile,
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_empty_mcp';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
        mcpServers: {}, // Empty object
      });

      // Should not attempt to write MCP settings
      expect(sandboxWriteFile).not.toHaveBeenCalledWith(
        expect.stringContaining('mcp_settings.json'),
        expect.anything()
      );
    });

    it('should write valid JSON with correct structure', async () => {
      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxExec = vi.fn().mockResolvedValue({ exitCode: 0 });
      const sandboxWriteFile = vi.fn().mockResolvedValue(undefined);
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: sandboxExec,
        writeFile: sandboxWriteFile,
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_mcp_json';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const mcpServers = {
        'server-1': {
          type: 'stdio' as const,
          command: 'node',
          args: ['server.js'],
        },
        'server-2': {
          type: 'sse' as const,
          url: 'https://example.com/mcp',
        },
      };

      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: mockEnv,
        mcpServers,
      });

      const writtenContent = sandboxWriteFile.mock.calls[0]?.[1] as string;
      expect(writtenContent).toBeDefined();

      // Should be valid JSON
      const parsed = JSON.parse(writtenContent);
      expect(parsed).toHaveProperty('mcpServers');
      expect(parsed.mcpServers).toHaveProperty('server-1');
      expect(parsed.mcpServers).toHaveProperty('server-2');
      expect(parsed.mcpServers['server-1']).toMatchObject({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
      });
      expect(parsed.mcpServers['server-2']).toMatchObject({
        type: 'sse',
        url: 'https://example.com/mcp',
      });
    });
  });

  describe('Metadata Persistence', () => {
    it('should save metadata including envVars, setupCommands, and mcpServers', async () => {
      const updateMetadata = vi.fn().mockResolvedValue(undefined);
      const { env: testEnv } = createMetadataEnv({
        updateMetadata,
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_metadata_save';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const envVars = { API_KEY: 'test-123' };
      const setupCommands = ['npm install', 'npm build'];
      const mcpServers = {
        test: { command: 'test-server' },
      };

      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: testEnv,
        envVars,
        setupCommands,
        mcpServers,
      });

      // Verify metadata was saved
      expect(updateMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          orgId: 'org',
          userId: 'user',
          githubRepo: 'acme/repo',
          envVars: { API_KEY: 'test-123' },
          setupCommands: ['npm install', 'npm build'],
          // MCPServerConfigSchema adds defaults for type, timeout, alwaysAllow, disabledTools
          mcpServers: {
            test: expect.objectContaining({ command: 'test-server' }),
          },
        })
      );
    });

    it('should load metadata with all fields correctly', async () => {
      const metadata = {
        version: 123456789,
        sessionId: 'agent_metadata_load',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'facebook/react',
        githubToken: 'test-token',
        envVars: { DATABASE_URL: 'postgres://localhost' },
        setupCommands: ['pnpm install'],
        mcpServers: { github: { command: 'mcp-github' } },
      };

      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(metadata),
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: 'exists' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;

      const service = new SessionService();
      const result = await service.resume({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId: 'agent_metadata_load',
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: testEnv,
      });

      // Verify metadata was loaded and applied to context
      expect(result.context.githubRepo).toBe('facebook/react');
      expect(result.context.githubToken).toBe('test-token');
      expect(result.context.envVars).toEqual({ DATABASE_URL: 'postgres://localhost' });
    });

    it('should round-trip metadata (save then load returns same data)', async () => {
      let savedMetadata: CloudAgentSessionState | undefined;
      const getMetadata = vi.fn().mockImplementation(async () => savedMetadata ?? null);
      const updateMetadata = vi.fn().mockImplementation(async (data: CloudAgentSessionState) => {
        savedMetadata = data;
      });

      const { env: testEnv } = createMetadataEnv({
        getMetadata,
        updateMetadata,
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: 'exists' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_roundtrip';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const originalData = {
        envVars: { KEY1: 'value1', KEY2: 'value2' },
        setupCommands: ['command1', 'command2'],
        mcpServers: { server1: { command: 'test' } },
      };

      const service = new SessionService();

      // Save
      await service.initiate({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        githubRepo: 'acme/repo',
        env: testEnv,
        ...originalData,
      });

      // Load
      const result = await service.resume({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: testEnv,
      });

      // Verify round-trip
      expect(result.context.envVars).toEqual(originalData.envVars);
      expect(savedMetadata).toBeDefined();
      expect(savedMetadata?.setupCommands).toEqual(originalData.setupCommands);
      // MCPServerConfigSchema adds defaults for type, timeout, alwaysAllow, disabledTools
      expect(savedMetadata?.mcpServers?.server1).toMatchObject({ command: 'test' });
    });
  });

  describe('Invalid Metadata Handling', () => {
    it('throws when Durable Object returns invalid metadata during resume', async () => {
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue({ invalid: true }),
      });

      const sandbox = {
        mkdir: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;

      const service = new SessionService();
      await expect(
        service.resume({
          sandbox,
          sandboxId: 'org__user',
          orgId: 'org',
          userId: 'user',
          sessionId: 'agent_invalid',
          kilocodeToken: 'token',
          kilocodeModel: 'test-model',
          env: testEnv,
        })
      ).rejects.toBeInstanceOf(InvalidSessionMetadataError);
    });

    it('throws when fetching sandbox id encounters invalid metadata', async () => {
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue({ invalid: true }),
      });

      const service = new SessionService();
      await expect(
        service.getSandboxIdForSession(testEnv, 'user', 'agent_invalid' as SessionId)
      ).rejects.toBeInstanceOf(InvalidSessionMetadataError);
    });
  });

  describe('Resume Flow with Setup Commands and MCP Settings', () => {
    it('should re-run setup commands from metadata on resume', async () => {
      const metadata = {
        version: 123456789,
        sessionId: 'agent_resume_setup',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'acme/repo',
        setupCommands: ['npm install', 'npm run build'],
      };

      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(metadata),
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: '' }), // repo doesn't exist
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;

      const service = new SessionService();
      await service.resume({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId: 'agent_resume_setup',
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: testEnv,
      });

      // Verify setup commands were re-run (because repo didn't exist, triggering reclone)
      expect(fakeSession.exec).toHaveBeenCalledWith('npm install', expect.any(Object));
      expect(fakeSession.exec).toHaveBeenCalledWith('npm run build', expect.any(Object));
    });

    it('should re-write MCP settings from metadata on resume', async () => {
      const metadata = {
        version: 123456789,
        sessionId: 'agent_resume_mcp',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'acme/repo',
        mcpServers: {
          puppeteer: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-puppeteer'],
          },
        },
      };

      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(metadata),
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: '' }), // repo doesn't exist
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxExec = vi.fn().mockResolvedValue({ exitCode: 0 });
      const sandboxWriteFile = vi.fn().mockResolvedValue(undefined);
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: sandboxExec,
        writeFile: sandboxWriteFile,
      } as unknown as SandboxInstance;

      const service = new SessionService();
      await service.resume({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId: 'agent_resume_mcp',
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: testEnv,
      });

      // Verify MCP settings were re-written (because repo didn't exist, triggering reclone)
      expect(sandboxWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('mcp_settings.json'),
        expect.stringContaining('puppeteer')
      );
    });

    it('should restore envVars to context on resume', async () => {
      const metadata = {
        version: 123456789,
        sessionId: 'agent_resume_env',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'acme/repo',
        envVars: {
          API_KEY: 'restored-key',
          DATABASE_URL: 'postgres://restored',
        },
      };

      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(metadata),
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: 'exists' }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;

      const service = new SessionService();
      await service.resume({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId: 'agent_resume_env',
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: testEnv,
      });

      // Verify envVars were restored when creating session
      expect(sandboxCreateSession).toHaveBeenCalledWith({
        name: 'agent_resume_env',
        env: expect.objectContaining({
          API_KEY: 'restored-key',
          DATABASE_URL: 'postgres://restored',
        }),
        cwd: expect.any(String),
      });
    });

    it('should handle resume with all features combined', async () => {
      const metadata = {
        version: 123456789,
        sessionId: 'agent_resume_all',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'acme/repo',
        envVars: { API_KEY: 'test' },
        setupCommands: ['npm install'],
        mcpServers: { test: { command: 'test-server' } },
      };

      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(metadata),
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0, stdout: '' }), // repo doesn't exist
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandboxExec = vi.fn().mockResolvedValue({ exitCode: 0 });
      const sandboxWriteFile = vi.fn().mockResolvedValue(undefined);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: sandboxExec,
        writeFile: sandboxWriteFile,
      } as unknown as SandboxInstance;

      const service = new SessionService();
      await service.resume({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId: 'agent_resume_all',
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: testEnv,
      });

      // Verify envVars restored
      expect(sandboxCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ API_KEY: 'test' }),
        })
      );

      // Verify setup commands re-run (because repo didn't exist, triggering reclone)
      expect(fakeSession.exec).toHaveBeenCalledWith('npm install', expect.any(Object));

      // Verify MCP settings re-written (because repo didn't exist, triggering reclone)
      expect(sandboxWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('mcp_settings.json'),
        expect.any(String)
      );
    });
  });

  describe('Bot Isolation and Personal Account Support', () => {
    describe('getSandboxIdForSession with botId', () => {
      it('should reconstruct sandboxId with bot prefix when metadata contains botId', async () => {
        const service = new SessionService();
        const userId = 'user-456';
        const sessionId: SessionId = 'agent_test-session';

        const mockMetadata = {
          orgId: 'org-123',
          userId,
          botId: 'reviewer',
          sessionId,
          version: 123,
          timestamp: Date.now(),
        };

        mockEnv.CLOUD_AGENT_SESSION.get = vi.fn(() => ({
          getMetadata: vi.fn().mockResolvedValue(mockMetadata),
        })) as unknown as typeof mockEnv.CLOUD_AGENT_SESSION.get;

        const sandboxId = await service.getSandboxIdForSession(mockEnv, userId, sessionId);

        expect(sandboxId).toMatch(/^bot-[0-9a-f]{48}$/);
        expect(sandboxId.length).toBe(52);
      });

      it('should reconstruct sandboxId with org prefix when metadata has no botId', async () => {
        const service = new SessionService();
        const userId = 'user-456';
        const sessionId: SessionId = 'agent_test-session';

        const mockMetadata = {
          orgId: 'org-123',
          userId,
          sessionId,
          version: 123,
          timestamp: Date.now(),
        };

        mockEnv.CLOUD_AGENT_SESSION.get = vi.fn(() => ({
          getMetadata: vi.fn().mockResolvedValue(mockMetadata),
        })) as unknown as typeof mockEnv.CLOUD_AGENT_SESSION.get;

        const sandboxId = await service.getSandboxIdForSession(mockEnv, userId, sessionId);

        expect(sandboxId).toMatch(/^org-[0-9a-f]{48}$/);
        expect(sandboxId.length).toBe(52);
      });

      it('should reconstruct sandboxId with usr prefix for personal accounts', async () => {
        const service = new SessionService();
        const userId = 'abc-123';
        const sessionId: SessionId = 'agent_test-session';

        const mockMetadata = {
          orgId: undefined,
          userId,
          sessionId,
          version: 123,
          timestamp: Date.now(),
        };

        mockEnv.CLOUD_AGENT_SESSION.get = vi.fn(() => ({
          getMetadata: vi.fn().mockResolvedValue(mockMetadata),
        })) as unknown as typeof mockEnv.CLOUD_AGENT_SESSION.get;

        const sandboxId = await service.getSandboxIdForSession(mockEnv, userId, sessionId);

        expect(sandboxId).toMatch(/^usr-[0-9a-f]{48}$/);
        expect(sandboxId.length).toBe(52);
      });

      it('should reconstruct sandboxId with ubt prefix for personal bot', async () => {
        const service = new SessionService();
        const userId = 'abc-123';
        const sessionId: SessionId = 'agent_test-session';

        const mockMetadata = {
          orgId: undefined,
          userId,
          botId: 'reviewer',
          sessionId,
          version: 123,
          timestamp: Date.now(),
        };

        mockEnv.CLOUD_AGENT_SESSION.get = vi.fn(() => ({
          getMetadata: vi.fn().mockResolvedValue(mockMetadata),
        })) as unknown as typeof mockEnv.CLOUD_AGENT_SESSION.get;

        const sandboxId = await service.getSandboxIdForSession(mockEnv, userId, sessionId);

        expect(sandboxId).toMatch(/^ubt-[0-9a-f]{48}$/);
        expect(sandboxId.length).toBe(52);
      });
    });
  });

  describe('interrupt', () => {
    it('should kill processes matching the workspace path', async () => {
      const sessionId: SessionId = 'agent_interrupt_test';
      const workspacePath = `/workspace/org/user/sessions/${sessionId}`;

      const sessionContext = {
        sessionId,
        workspacePath,
        sandboxId: 'org__user',
        sessionHome: `/home/${sessionId}`,
        branchName: `session/${sessionId}`,
        userId: 'user',
        orgId: 'org',
      } as SessionContext;

      // Mock processes with matching workspace path
      const mockProcesses = [
        {
          id: 'proc1',
          status: 'running',
          command: `kilocode exec --workspace=${workspacePath} --mode code`,
        },
        {
          id: 'proc2',
          status: 'running',
          command: `kilocode exec --workspace=${workspacePath} --mode architect`,
        },
      ];

      const mockKillProcess = vi.fn().mockResolvedValue(undefined);
      const mockSession = {
        killProcess: mockKillProcess,
      } as unknown as ExecutionSession;

      const mockSandbox = {
        listProcesses: vi.fn().mockResolvedValue(mockProcesses),
      } as unknown as SandboxInstance;

      const result = await SessionService.interrupt(mockSandbox, mockSession, sessionContext);

      expect(result.success).toBe(true);
      expect(result.killedProcessIds).toEqual(['proc1', 'proc2']);
      expect(result.failedProcessIds).toEqual([]);
      expect(mockKillProcess).toHaveBeenCalledTimes(2);
      expect(mockKillProcess).toHaveBeenCalledWith('proc1', 'SIGTERM');
      expect(mockKillProcess).toHaveBeenCalledWith('proc2', 'SIGTERM');
    });

    it('should NOT kill processes from other workspaces', async () => {
      const sessionId: SessionId = 'agent_my_session';
      const workspacePath = `/workspace/org/user/sessions/${sessionId}`;

      const sessionContext = {
        sessionId,
        workspacePath,
        sandboxId: 'org__user',
        sessionHome: `/home/${sessionId}`,
        branchName: `session/${sessionId}`,
        userId: 'user',
        orgId: 'org',
      } as SessionContext;

      const mockProcesses = [
        {
          id: 'proc1',
          status: 'running',
          command: `kilocode exec --workspace=${workspacePath} --mode code`,
        },
        {
          id: 'proc2',
          status: 'running',
          command:
            'kilocode exec --workspace=/workspace/org/other/sessions/other_session --mode code',
        },
        {
          id: 'proc3',
          status: 'running',
          command: 'kilocode exec --workspace=/different/path --mode architect',
        },
      ];

      const mockKillProcess = vi.fn().mockResolvedValue(undefined);
      const mockSession = {
        killProcess: mockKillProcess,
      } as unknown as ExecutionSession;

      const mockSandbox = {
        listProcesses: vi.fn().mockResolvedValue(mockProcesses),
      } as unknown as SandboxInstance;

      const result = await SessionService.interrupt(mockSandbox, mockSession, sessionContext);

      // Should only kill proc1 (the one matching our workspace)
      expect(result.success).toBe(true);
      expect(result.killedProcessIds).toEqual(['proc1']);
      expect(result.failedProcessIds).toEqual([]);
      expect(mockKillProcess).toHaveBeenCalledTimes(1);
      expect(mockKillProcess).toHaveBeenCalledWith('proc1', 'SIGTERM');
    });

    it('should only kill running processes', async () => {
      const sessionId: SessionId = 'agent_running_test';
      const workspacePath = `/workspace/org/user/sessions/${sessionId}`;

      const sessionContext = {
        sessionId,
        workspacePath,
        sandboxId: 'org__user',
        sessionHome: `/home/${sessionId}`,
        branchName: `session/${sessionId}`,
        userId: 'user',
        orgId: 'org',
      } as SessionContext;

      const mockProcesses = [
        {
          id: 'proc1',
          status: 'running',
          command: `kilocode exec --workspace=${workspacePath} --mode code`,
        },
        {
          id: 'proc2',
          status: 'stopped',
          command: `kilocode exec --workspace=${workspacePath} --mode code`,
        },
        {
          id: 'proc3',
          status: 'exited',
          command: `kilocode exec --workspace=${workspacePath} --mode architect`,
        },
      ];

      const mockKillProcess = vi.fn().mockResolvedValue(undefined);
      const mockSession = {
        killProcess: mockKillProcess,
      } as unknown as ExecutionSession;

      const mockSandbox = {
        listProcesses: vi.fn().mockResolvedValue(mockProcesses),
      } as unknown as SandboxInstance;

      const result = await SessionService.interrupt(mockSandbox, mockSession, sessionContext);

      // Should only kill proc1 (status='running')
      expect(result.success).toBe(true);
      expect(result.killedProcessIds).toEqual(['proc1']);
      expect(result.failedProcessIds).toEqual([]);
      expect(mockKillProcess).toHaveBeenCalledTimes(1);
      expect(mockKillProcess).toHaveBeenCalledWith('proc1', 'SIGTERM');
    });

    it('should only kill kilocode processes', async () => {
      const sessionId: SessionId = 'agent_process_filter';
      const workspacePath = `/workspace/org/user/sessions/${sessionId}`;

      const sessionContext = {
        sessionId,
        workspacePath,
        sandboxId: 'org__user',
        sessionHome: `/home/${sessionId}`,
        branchName: `session/${sessionId}`,
        userId: 'user',
        orgId: 'org',
      } as SessionContext;

      const mockProcesses = [
        {
          id: 'proc1',
          status: 'running',
          command: `kilocode exec --workspace=${workspacePath} --mode code`,
        },
        {
          id: 'proc2',
          status: 'running',
          command: `node server.js --workspace=${workspacePath}`,
        },
        {
          id: 'proc3',
          status: 'running',
          command: `bash --workspace=${workspacePath}`,
        },
        {
          id: 'proc4',
          status: 'running',
          command: `/usr/bin/python3 app.py --workspace=${workspacePath}`,
        },
      ];

      const mockKillProcess = vi.fn().mockResolvedValue(undefined);
      const mockSession = {
        killProcess: mockKillProcess,
      } as unknown as ExecutionSession;

      const mockSandbox = {
        listProcesses: vi.fn().mockResolvedValue(mockProcesses),
      } as unknown as SandboxInstance;

      const result = await SessionService.interrupt(mockSandbox, mockSession, sessionContext);

      // Should only kill proc1 (contains 'kilocode')
      expect(result.success).toBe(true);
      expect(result.killedProcessIds).toEqual(['proc1']);
      expect(result.failedProcessIds).toEqual([]);
      expect(mockKillProcess).toHaveBeenCalledTimes(1);
      expect(mockKillProcess).toHaveBeenCalledWith('proc1', 'SIGTERM');
    });

    it('should return success=true when no processes found', async () => {
      const sessionId: SessionId = 'agent_no_procs';
      const workspacePath = `/workspace/org/user/sessions/${sessionId}`;

      const sessionContext = {
        sessionId,
        workspacePath,
        sandboxId: 'org__user',
        sessionHome: `/home/${sessionId}`,
        branchName: `session/${sessionId}`,
        userId: 'user',
        orgId: 'org',
      } as SessionContext;

      const mockProcesses: never[] = [];

      const mockKillProcess = vi.fn();
      const mockSession = {
        killProcess: mockKillProcess,
      } as unknown as ExecutionSession;

      const mockSandbox = {
        listProcesses: vi.fn().mockResolvedValue(mockProcesses),
      } as unknown as SandboxInstance;

      const result = await SessionService.interrupt(mockSandbox, mockSession, sessionContext);

      expect(result.success).toBe(true);
      expect(result.killedProcessIds).toEqual([]);
      expect(result.failedProcessIds).toEqual([]);
      expect(result.message).toContain('No running kilocode processes found');
      expect(mockKillProcess).not.toHaveBeenCalled();
    });

    it('should handle partial kill failures gracefully', async () => {
      const sessionId: SessionId = 'agent_partial_fail';
      const workspacePath = `/workspace/org/user/sessions/${sessionId}`;

      const sessionContext = {
        sessionId,
        workspacePath,
        sandboxId: 'org__user',
        sessionHome: `/home/${sessionId}`,
        branchName: `session/${sessionId}`,
        userId: 'user',
        orgId: 'org',
      } as SessionContext;

      const mockProcesses = [
        {
          id: 'proc1',
          status: 'running',
          command: `kilocode exec --workspace=${workspacePath} --mode code`,
        },
        {
          id: 'proc2',
          status: 'running',
          command: `kilocode exec --workspace=${workspacePath} --mode architect`,
        },
        {
          id: 'proc3',
          status: 'running',
          command: `kilocode exec --workspace=${workspacePath} --mode debug`,
        },
      ];

      // Mock killProcess to succeed for proc1, fail for proc2, succeed for proc3
      const mockKillProcess = vi
        .fn()
        .mockResolvedValueOnce(undefined) // proc1 succeeds
        .mockRejectedValueOnce(new Error('Permission denied')) // proc2 fails
        .mockResolvedValueOnce(undefined); // proc3 succeeds

      const mockSession = {
        killProcess: mockKillProcess,
      } as unknown as ExecutionSession;

      const mockSandbox = {
        listProcesses: vi.fn().mockResolvedValue(mockProcesses),
      } as unknown as SandboxInstance;

      const result = await SessionService.interrupt(mockSandbox, mockSession, sessionContext);

      expect(result.success).toBe(true); // success because at least one was killed
      expect(result.killedProcessIds).toEqual(['proc1', 'proc3']);
      expect(result.failedProcessIds).toEqual(['proc2']);
      expect(result.message).toContain('killed 2 process(es)');
      expect(result.message).toContain('1 failed');
      expect(mockKillProcess).toHaveBeenCalledTimes(3);
    });
  });

  describe('initiateFromKiloSession', () => {
    const noopStream = async function* () {};

    it('should setup workspace and clone repo without creating session branch', async () => {
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      const { env: testEnv } = createMetadataEnv({
        updateMetadata: vi.fn().mockResolvedValue(undefined),
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandboxCreateSession = vi.fn().mockResolvedValue(fakeSession);
      const sandbox = {
        createSession: sandboxCreateSession,
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_kilo_session_test';
      const kiloSessionId = '123e4567-e89b-12d3-a456-426614174000';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const result = await service.initiateFromKiloSession({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        kiloSessionId,
        githubRepo: 'acme/repo',
        env: testEnv,
      });

      // Should setup workspace
      expect(mockSetupWorkspace).toHaveBeenCalledWith(sandbox, 'user', 'org', sessionId);

      // Should clone repo
      expect(mockCloneGitHubRepo).toHaveBeenCalledWith(
        fakeSession,
        `/workspace/org/user/sessions/${sessionId}`,
        'acme/repo',
        undefined,
        { GITHUB_APP_SLUG: undefined, GITHUB_APP_BOT_USER_ID: undefined }
      );

      // Should NOT create session branch (kilo session manages its own branch)
      expect(fakeSession.exec).not.toHaveBeenCalledWith(expect.stringContaining('git checkout -b'));
      expect(mockManageBranch).not.toHaveBeenCalled();

      expect(result.context.sessionId).toBe(sessionId);
      expect(result.streamKilocodeExec).toBeDefined();
    });

    it('should save kiloSessionId in metadata', async () => {
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      const updateMetadata = vi.fn().mockResolvedValue(undefined);
      const { env: testEnv } = createMetadataEnv({
        updateMetadata,
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_kilo_metadata_test';
      const kiloSessionId = '123e4567-e89b-12d3-a456-426614174000';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiateFromKiloSession({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        kiloSessionId,
        githubRepo: 'acme/repo',
        env: testEnv,
      });

      // Verify metadata was saved with kiloSessionId
      expect(updateMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          kiloSessionId,
          githubRepo: 'acme/repo',
        })
      );
    });

    it('should pass isFirstExecution=false since resuming existing kilo session', async () => {
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      const { env: testEnv } = createMetadataEnv({
        updateMetadata: vi.fn().mockResolvedValue(undefined),
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_first_exec_false';
      const kiloSessionId = '123e4567-e89b-12d3-a456-426614174000';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const result = await service.initiateFromKiloSession({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        kiloSessionId,
        githubRepo: 'acme/repo',
        env: testEnv,
      });

      // Consume the generator
      for await (const _ of result.streamKilocodeExec('code', 'test prompt')) {
        // noop
      }

      // Verify isFirstExecution=false and kiloSessionId is passed
      expect(streamKilocodeExecutionMock).toHaveBeenCalledWith(
        sandbox,
        fakeSession,
        expect.objectContaining({ sessionId }),
        'code',
        'test prompt',
        expect.objectContaining({ isFirstExecution: false, kiloSessionId }),
        testEnv
      );
    });

    it('should run setup commands after clone', async () => {
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      const { env: testEnv } = createMetadataEnv({
        updateMetadata: vi.fn().mockResolvedValue(undefined),
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_kilo_setup_test';
      const kiloSessionId = '123e4567-e89b-12d3-a456-426614174000';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiateFromKiloSession({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        kiloSessionId,
        githubRepo: 'acme/repo',
        env: testEnv,
        setupCommands: ['npm install', 'npm run build'],
      });

      // Verify setup commands were run
      expect(fakeSession.exec).toHaveBeenCalledWith('npm install', expect.any(Object));
      expect(fakeSession.exec).toHaveBeenCalledWith('npm run build', expect.any(Object));
    });
  });

  describe('linkKiloSessionInBackend', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should use correct tRPC wire format with request body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { data: { success: true } } }),
      });
      global.fetch = mockFetch;

      const envWithBackendUrl: PersistenceEnv = {
        ...mockEnv,
        KILOCODE_BACKEND_BASE_URL: 'https://test.kilo.ai',
      };

      const service = new SessionService();
      // Access private method
      await service['linkKiloSessionInBackend'](
        'kilo-session-123',
        'agent-session-456',
        'auth-token',
        envWithBackendUrl
      );

      // Verify the request uses POST with body (not query string)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.kilo.ai/api/trpc/cliSessions.linkCloudAgent',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer auth-token',
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            kilo_session_id: 'kilo-session-123',
            cloud_agent_session_id: 'agent-session-456',
          }),
        })
      );
    });

    it('should use default backend URL when not provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { data: { success: true } } }),
      });
      global.fetch = mockFetch;

      const service = new SessionService();
      await service['linkKiloSessionInBackend'](
        'kilo-session-123',
        'agent-session-456',
        'auth-token',
        mockEnv // No KILOCODE_BACKEND_URL
      );

      const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('https://api.kilo.ai');
    });

    it('should throw error when backend returns non-200', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found'),
      });

      const service = new SessionService();
      await expect(
        service['linkKiloSessionInBackend'](
          'kilo-session-123',
          'agent-session-456',
          'auth-token',
          mockEnv
        )
      ).rejects.toThrow('Failed to link sessions: 404');
    });

    it('should throw error when backend does not confirm success', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { data: { success: false } } }),
      });

      const service = new SessionService();
      await expect(
        service['linkKiloSessionInBackend'](
          'kilo-session-123',
          'agent-session-456',
          'auth-token',
          mockEnv
        )
      ).rejects.toThrow('Backend did not confirm successful link');
    });

    it('should throw error when response format is unexpected', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ unexpected: 'format' }),
      });

      const service = new SessionService();
      await expect(
        service['linkKiloSessionInBackend'](
          'kilo-session-123',
          'agent-session-456',
          'auth-token',
          mockEnv
        )
      ).rejects.toThrow('Backend did not confirm successful link');
    });
  });

  describe('captureAndStoreBranch', () => {
    it('should capture current branch and update metadata', async () => {
      const updateUpstreamBranch = vi.fn().mockResolvedValue(undefined);
      const existingMetadata = {
        version: 123456789,
        sessionId: 'agent_branch_capture',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'acme/repo',
      };
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(existingMetadata),
        updateUpstreamBranch,
      });

      const mockExec = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: 'feature/my-branch\n',
        stderr: '',
      });
      const fakeSession = {
        exec: mockExec,
      } as unknown as ExecutionSession;

      const context: SessionContext = {
        sessionId: 'agent_branch_capture' as SessionId,
        workspacePath: '/workspace/org/user/sessions/agent_branch_capture',
        sandboxId: 'org__user',
        sessionHome: '/home/agent_branch_capture',
        branchName: 'session/agent_branch_capture',
        userId: 'user',
        orgId: 'org',
      };

      const service = new SessionService();
      await service['captureAndStoreBranch'](fakeSession, context, testEnv);

      // Verify git branch command was executed
      expect(mockExec).toHaveBeenCalledWith(
        'cd /workspace/org/user/sessions/agent_branch_capture && git branch --show-current'
      );

      // Verify updateUpstreamBranch was called with the captured branch
      expect(updateUpstreamBranch).toHaveBeenCalledWith('feature/my-branch');
    });

    it('should handle git command failure gracefully', async () => {
      const updateMetadata = vi.fn().mockResolvedValue(undefined);
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(null),
        updateMetadata,
      });

      const mockExec = vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'fatal: not a git repository',
      });
      const fakeSession = {
        exec: mockExec,
      } as unknown as ExecutionSession;

      const context: SessionContext = {
        sessionId: 'agent_branch_fail' as SessionId,
        workspacePath: '/workspace/org/user/sessions/agent_branch_fail',
        sandboxId: 'org__user',
        sessionHome: '/home/agent_branch_fail',
        branchName: 'session/agent_branch_fail',
        userId: 'user',
        orgId: 'org',
      };

      const service = new SessionService();
      // Should not throw, just log warning
      await service['captureAndStoreBranch'](fakeSession, context, testEnv);

      // Should not update metadata when git command fails
      expect(updateMetadata).not.toHaveBeenCalled();
    });

    it('should handle empty branch name gracefully', async () => {
      const updateMetadata = vi.fn().mockResolvedValue(undefined);
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(null),
        updateMetadata,
      });

      const mockExec = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '   \n', // Whitespace only
        stderr: '',
      });
      const fakeSession = {
        exec: mockExec,
      } as unknown as ExecutionSession;

      const context: SessionContext = {
        sessionId: 'agent_empty_branch' as SessionId,
        workspacePath: '/workspace/org/user/sessions/agent_empty_branch',
        sandboxId: 'org__user',
        sessionHome: '/home/agent_empty_branch',
        branchName: 'session/agent_empty_branch',
        userId: 'user',
        orgId: 'org',
      };

      const service = new SessionService();
      await service['captureAndStoreBranch'](fakeSession, context, testEnv);

      // Should not update metadata when branch name is empty
      expect(updateMetadata).not.toHaveBeenCalled();
    });

    it('should handle exec throwing an error gracefully', async () => {
      const updateMetadata = vi.fn().mockResolvedValue(undefined);
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(null),
        updateMetadata,
      });

      const mockExec = vi.fn().mockRejectedValue(new Error('Connection lost'));
      const fakeSession = {
        exec: mockExec,
      } as unknown as ExecutionSession;

      const context: SessionContext = {
        sessionId: 'agent_exec_error' as SessionId,
        workspacePath: '/workspace/org/user/sessions/agent_exec_error',
        sandboxId: 'org__user',
        sessionHome: '/home/agent_exec_error',
        branchName: 'session/agent_exec_error',
        userId: 'user',
        orgId: 'org',
      };

      const service = new SessionService();
      // Should not throw, just log warning
      await service['captureAndStoreBranch'](fakeSession, context, testEnv);

      // Should not update metadata when exec throws
      expect(updateMetadata).not.toHaveBeenCalled();
    });
  });

  describe('saveSessionMetadata preserves prepared session fields', () => {
    it('should preserve preparedAt, initiatedAt, prompt, mode, model, autoCommit when existingMetadata is provided', async () => {
      const noopStream = async function* () {};
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      // Existing metadata with prepared session fields
      const existingMetadata: CloudAgentSessionState = {
        version: 123456789,
        sessionId: 'agent_preserve_test',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'acme/repo',
        // Prepared session fields that must be preserved
        preparedAt: 1700000000000,
        initiatedAt: 1700000001000,
        prompt: 'Original prompt from prepareSession',
        mode: 'build',
        model: 'claude-3-opus',
        autoCommit: true,
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
      };

      const updateMetadata = vi.fn().mockResolvedValue(undefined);
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(existingMetadata),
        updateMetadata,
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_preserve_test';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiateFromKiloSession({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        githubRepo: 'acme/repo',
        env: testEnv,
        // Pass existingMetadata to trigger the merge behavior
        existingMetadata,
      });

      // Verify updateMetadata was called with preserved fields
      expect(updateMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          // These fields should be preserved from existingMetadata
          preparedAt: 1700000000000,
          initiatedAt: 1700000001000,
          prompt: 'Original prompt from prepareSession',
          mode: 'build',
          model: 'claude-3-opus',
          autoCommit: true,
          // These fields should be updated
          sessionId,
          orgId: 'org',
          userId: 'user',
          githubRepo: 'acme/repo',
          kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        })
      );
    });

    it('should NOT have prepared fields when existingMetadata is not provided (legacy flow)', async () => {
      const noopStream = async function* () {};
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      const updateMetadata = vi.fn().mockResolvedValue(undefined);
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(null),
        updateMetadata,
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_legacy_test';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiateFromKiloSession({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        githubRepo: 'acme/repo',
        env: testEnv,
        // No existingMetadata - legacy flow
      });

      // Verify updateMetadata was called WITHOUT prepared fields
      const savedMetadata = updateMetadata.mock.calls[0]?.[0] as CloudAgentSessionState;
      expect(savedMetadata).toBeDefined();
      expect(savedMetadata.preparedAt).toBeUndefined();
      expect(savedMetadata.initiatedAt).toBeUndefined();
      expect(savedMetadata.prompt).toBeUndefined();
      expect(savedMetadata.mode).toBeUndefined();
      expect(savedMetadata.model).toBeUndefined();
      expect(savedMetadata.autoCommit).toBeUndefined();
    });
  });

  describe('isPreparedSession branch management logic', () => {
    const noopStream = async function* () {};

    it('uses manageBranch when prepared session has upstreamBranch', async () => {
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      // Existing metadata with preparedAt AND upstreamBranch
      const existingMetadata: CloudAgentSessionState = {
        version: 123456789,
        sessionId: 'agent_upstream_test',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'acme/repo',
        preparedAt: 1700000000000, // This makes isPreparedSession = true
        initiatedAt: 1700000001000,
        upstreamBranch: 'feature/my-branch', // This triggers manageBranch path
        prompt: 'Test prompt',
        mode: 'build',
        model: 'claude-3',
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
      };

      const updateMetadata = vi.fn().mockResolvedValue(undefined);
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(existingMetadata),
        updateMetadata,
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_upstream_test';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiateFromKiloSession({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        githubRepo: 'acme/repo',
        env: testEnv,
        existingMetadata,
      });

      // For prepared sessions with upstreamBranch, manageBranch SHOULD be called
      expect(mockManageBranch).toHaveBeenCalledWith(
        fakeSession,
        `/workspace/org/user/sessions/${sessionId}`,
        'feature/my-branch', // branchName = upstreamBranch when provided
        true
      );

      // git checkout -b should NOT be called directly
      expect(fakeSession.exec).not.toHaveBeenCalledWith(expect.stringContaining('git checkout -b'));
    });

    it('creates session branch directly when prepared session has no upstreamBranch', async () => {
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      // Existing metadata with preparedAt but NO upstreamBranch
      const existingMetadata: CloudAgentSessionState = {
        version: 123456789,
        sessionId: 'agent_session_branch_test',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'acme/repo',
        preparedAt: 1700000000000, // This makes isPreparedSession = true
        initiatedAt: 1700000001000,
        // NO upstreamBranch - should create session branch
        prompt: 'Test prompt',
        mode: 'build',
        model: 'claude-3',
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
      };

      const updateMetadata = vi.fn().mockResolvedValue(undefined);
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(existingMetadata),
        updateMetadata,
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_session_branch_test';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiateFromKiloSession({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        githubRepo: 'acme/repo',
        env: testEnv,
        existingMetadata,
      });

      // manageBranch should NOT be called (no upstreamBranch)
      expect(mockManageBranch).not.toHaveBeenCalled();

      // git checkout -b SHOULD be called to create session branch
      expect(fakeSession.exec).toHaveBeenCalledWith(
        expect.stringContaining(`git checkout -b 'session/${sessionId}'`)
      );
    });

    it('skips branch operations for legacy CLI resumes (no preparedAt)', async () => {
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      // NO existingMetadata passed - simulates legacy CLI resume where
      // preparedAt won't be set
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(null),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_legacy_cli_test';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiateFromKiloSession({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        githubRepo: 'acme/repo',
        env: testEnv,
        // NO existingMetadata - legacy flow
      });

      // manageBranch should NOT be called (CLI manages its own branch)
      expect(mockManageBranch).not.toHaveBeenCalled();

      // git checkout -b should NOT be called (CLI manages its own branch)
      expect(fakeSession.exec).not.toHaveBeenCalledWith(expect.stringContaining('git checkout -b'));
    });

    it('skips branch operations when existingMetadata has no preparedAt (explicit legacy)', async () => {
      streamKilocodeExecutionMock.mockReturnValue(noopStream());

      // existingMetadata WITHOUT preparedAt - this is a legacy session
      const legacyMetadata: CloudAgentSessionState = {
        version: 123456789,
        sessionId: 'agent_legacy_explicit_test',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'acme/repo',
        // NO preparedAt - makes isPreparedSession = false
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
      };

      const updateMetadata = vi.fn().mockResolvedValue(undefined);
      const { env: testEnv } = createMetadataEnv({
        getMetadata: vi.fn().mockResolvedValue(legacyMetadata),
        updateMetadata,
      });

      const fakeSession = {
        exec: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
        deleteFile: vi.fn().mockResolvedValue(undefined),
      };
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      } as unknown as SandboxInstance;
      const sessionId: SessionId = 'agent_legacy_explicit_test';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      await service.initiateFromKiloSession({
        sandbox,
        sandboxId: 'org__user',
        orgId: 'org',
        userId: 'user',
        sessionId,
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        kiloSessionId: '123e4567-e89b-12d3-a456-426614174000',
        githubRepo: 'acme/repo',
        env: testEnv,
        existingMetadata: legacyMetadata,
      });

      // manageBranch should NOT be called
      expect(mockManageBranch).not.toHaveBeenCalled();

      // git checkout -b should NOT be called (legacy CLI manages its own branch)
      expect(fakeSession.exec).not.toHaveBeenCalledWith(expect.stringContaining('git checkout -b'));
    });
  });
});
