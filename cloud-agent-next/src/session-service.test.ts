import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    mockEnv.SESSION_INGEST.exportSession = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ info: {}, messages: [] }));
  });

  const mockedSetupWorkspace = vi.mocked(mockSetupWorkspace);
  const mockedRestoreWorkspace = vi.mocked(mockRestoreWorkspace);

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
      exportSession: vi.fn(),
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
          KILOCODE_FEATURE: 'cloud-agent',
          OPENCODE_CONFIG_CONTENT: `{"permission":{"external_directory":{"*":"deny","/tmp/${sessionId}/**":"allow","/workspace/org/user/sessions/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
          KILO_CONFIG_CONTENT: `{"permission":{"external_directory":{"*":"deny","/tmp/${sessionId}/**":"allow","/workspace/org/user/sessions/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
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
    });

    it('does not restore session snapshot during initiate (no exportSession call)', async () => {
      const exportSessionMock = vi
        .fn()
        .mockResolvedValue(JSON.stringify({ info: {}, messages: [] }));
      const envWithIngest: PersistenceEnv = {
        ...mockEnv,
        SESSION_INGEST: {
          exportSession: exportSessionMock,
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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

      expect(exportSessionMock).not.toHaveBeenCalled();
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
          KILOCODE_FEATURE: 'cloud-agent',
          OPENCODE_CONFIG_CONTENT: `{"permission":{"external_directory":{"*":"deny","/tmp/${sessionId}/**":"allow","/workspace/org/user/sessions/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
          KILO_CONFIG_CONTENT: `{"permission":{"external_directory":{"*":"deny","/tmp/${sessionId}/**":"allow","/workspace/org/user/sessions/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
        },
        cwd: `/workspace/org/user/sessions/${sessionId}`,
      });
      // manageBranch should NOT be called when repo exists (warm start)
      expect(mockManageBranch).not.toHaveBeenCalled();
      expect(result.context.sessionId).toBe(sessionId);
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
        kiloSessionId: 'ses_test_kilo_session_id_0001',
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
      const kiloSessionId = 'ses_test_kilo_session_id_0001';
      const metadata = {
        version: 123456789,
        sessionId,
        orgId,
        userId,
        timestamp: 123456789,
        githubRepo: 'facebook/react',
        githubToken: 'test-token',
        kiloSessionId,
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
        kiloSessionId: 'ses_test_kilo_session_id_0001',
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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

    it('restores workspace then session snapshot when workspace is missing', async () => {
      const mockDOGetMetadata = vi.fn();
      const payload = JSON.stringify({ info: {}, messages: [] });
      const exportSessionMock = vi.fn().mockResolvedValue(payload);
      const envWithIngest: PersistenceEnv = {
        ...mockEnv,
        SESSION_INGEST: {
          exportSession: exportSessionMock,
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
      const sandboxWriteFile = vi.fn().mockResolvedValue(undefined);
      const sandbox = {
        createSession: vi.fn().mockResolvedValue(fakeSession),
        mkdir: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: sandboxWriteFile,
      } as unknown as SandboxInstance;

      const kiloSessionId = 'ses_test_kilo_session_id_0001';
      const metadata = {
        version: 123456789,
        sessionId,
        orgId,
        userId,
        timestamp: 123456789,
        githubRepo: 'facebook/react',
        githubToken: 'test-token',
        kiloSessionId,
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

      expect(exportSessionMock).toHaveBeenCalledWith({
        sessionId: kiloSessionId,
        kiloUserId: userId,
      });
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

      // Verify restoreWorkspace (git clone) ran before kilo import
      const kiloImportCallIndex = fakeSession.exec.mock.calls.findIndex(
        (args: string[]) => typeof args[0] === 'string' && args[0].includes('kilo import')
      );
      expect(kiloImportCallIndex).toBeGreaterThanOrEqual(0);
      const restoreWorkspaceOrder = mockedRestoreWorkspace.mock.invocationCallOrder[0];
      const kiloImportOrder = fakeSession.exec.mock.invocationCallOrder[kiloImportCallIndex];
      expect(restoreWorkspaceOrder).toBeLessThan(kiloImportOrder);

      // Verify writeAuthFile ran before kilo import so KiloSessions.bootstrap() can authenticate
      const authWriteCallIndex = sandboxWriteFile.mock.calls.findIndex(
        (args: string[]) => typeof args[0] === 'string' && args[0].includes('auth.json')
      );
      expect(authWriteCallIndex).toBeGreaterThanOrEqual(0);
      const authWriteOrder = sandboxWriteFile.mock.invocationCallOrder[authWriteCallIndex];
      expect(authWriteOrder).toBeLessThan(kiloImportOrder);
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
          KILOCODE_FEATURE: 'cloud-agent',
          OPENCODE_CONFIG_CONTENT: `{"permission":{"external_directory":{"*":"deny","/tmp/${sessionId}/**":"allow","/workspace/org/user/sessions/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
          KILO_CONFIG_CONTENT: `{"permission":{"external_directory":{"*":"deny","/tmp/${sessionId}/**":"allow","/workspace/org/user/sessions/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
        }) as unknown,
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
          KILOCODE_FEATURE: 'cloud-agent',
          OPENCODE_CONFIG_CONTENT: `{"permission":{"external_directory":{"*":"deny","/tmp/${sessionId}/**":"allow","/workspace/org/user/sessions/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
          KILO_CONFIG_CONTENT: `{"permission":{"external_directory":{"*":"deny","/tmp/${sessionId}/**":"allow","/workspace/org/user/sessions/${sessionId}/**":"allow"}},"provider":{"kilo":{"options":{"apiKey":"token","kilocodeToken":"token","kilocodeOrganizationId":"org"}}},"model":"kilo/test-model"}`,
        },
        cwd: `/workspace/org/user/sessions/${sessionId}`,
      });
    });
  });

  describe('Question Tool Permission for Non-Interactive Platforms', () => {
    const setupForPlatformTest = () => {
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
      return { sandbox, sandboxCreateSession };
    };

    const getConfigContent = (sandboxCreateSession: ReturnType<typeof vi.fn>) => {
      const callArgs = sandboxCreateSession.mock.calls[0][0] as { env: Record<string, string> };
      return JSON.parse(callArgs.env.KILO_CONFIG_CONTENT) as {
        permission: { question?: string; external_directory?: Record<string, string> };
      };
    };

    it.each([undefined, 'cloud-agent', 'app-builder'])(
      'should NOT include question:deny for interactive platform %s',
      async createdOnPlatform => {
        const { sandbox, sandboxCreateSession } = setupForPlatformTest();
        const sessionId: SessionId = 'agent_interactive_test';
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
          createdOnPlatform,
        });

        const config = getConfigContent(sandboxCreateSession);
        expect(config.permission).not.toHaveProperty('question');
      }
    );

    it.each(['slack', 'security-agent', 'webhook', 'code-review', 'auto-triage', 'autofix'])(
      'should include question:deny for non-interactive platform %s',
      async createdOnPlatform => {
        const { sandbox, sandboxCreateSession } = setupForPlatformTest();
        const sessionId: SessionId = 'agent_noninteractive_test';
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
          createdOnPlatform,
        });

        const config = getConfigContent(sandboxCreateSession);
        expect(config.permission.question).toBe('deny');
      }
    );

    it('should include read-only command guard policy for code-review sessions', async () => {
      const { sandbox, sandboxCreateSession } = setupForPlatformTest();
      const sessionId: SessionId = 'agent_code_review_policy_test';
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
        createdOnPlatform: 'code-review',
      });

      const callArgs = sandboxCreateSession.mock.calls[0][0] as { env: Record<string, string> };
      const configContent = JSON.parse(callArgs.env.KILO_CONFIG_CONTENT) as {
        permission?: {
          bash?: Record<string, string>;
          edit?: string;
          read?: string;
        };
      };

      // Denied commands use "cmd *" glob pattern format
      expect(configContent.permission?.bash?.['git commit *']).toBe('deny');
      expect(configContent.permission?.bash?.['gh pr merge *']).toBe('deny');
      expect(configContent.permission?.edit).toBe('deny');
      expect(configContent.permission?.read).toBe('allow');
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
          }) as unknown,
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
          }) as unknown,
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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

      const callArgs = sandboxCreateSession.mock.calls[0][0] as { env: Record<string, string> };
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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

      const callArgs = sandboxCreateSession.mock.calls[0][0] as { env: Record<string, string> };
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
      const callArgs = sandboxCreateSession.mock.calls[0][0] as { env: Record<string, string> };
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
        kiloSessionId: 'ses_test_kilo_session_id_0001',
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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
        exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
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

  describe('MCP Config in KILO_CONFIG_CONTENT', () => {
    it('should include MCP servers in KILO_CONFIG_CONTENT env var', async () => {
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
      const sessionId: SessionId = 'agent_mcp_test';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const mcpServers = {
        puppeteer: {
          type: 'local' as const,
          command: ['npx', '-y', '@modelcontextprotocol/server-puppeteer'],
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

      const callArgs = sandboxCreateSession.mock.calls[0][0] as { env: Record<string, string> };
      const configContent = JSON.parse(callArgs.env.KILO_CONFIG_CONTENT) as {
        mcp: Record<string, unknown>;
      };
      expect(configContent.mcp).toBeDefined();
      expect(configContent.mcp.puppeteer).toEqual({
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-puppeteer'],
      });
    });

    it('should not include mcp key when mcpServers is empty', async () => {
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

      const callArgs = sandboxCreateSession.mock.calls[0][0] as { env: Record<string, string> };
      const configContent = JSON.parse(callArgs.env.KILO_CONFIG_CONTENT) as {
        mcp?: Record<string, unknown>;
      };
      expect(configContent.mcp).toBeUndefined();
    });

    it('should pass local and remote MCP configs directly to KILO_CONFIG_CONTENT', async () => {
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
      const sessionId: SessionId = 'agent_mcp_json';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const mcpServers = {
        'server-1': {
          type: 'local' as const,
          command: ['node', 'server.js'],
          environment: { FOO: 'bar' },
        },
        'server-2': {
          type: 'remote' as const,
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer tok' },
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

      const callArgs = sandboxCreateSession.mock.calls[0][0] as { env: Record<string, string> };
      const configContent = JSON.parse(callArgs.env.KILO_CONFIG_CONTENT) as {
        mcp: Record<string, unknown>;
      };
      // MCP configs are passed through directly — no conversion
      expect(configContent.mcp['server-1']).toEqual({
        type: 'local',
        command: ['node', 'server.js'],
        environment: { FOO: 'bar' },
      });
      expect(configContent.mcp['server-2']).toEqual({
        type: 'remote',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer tok' },
      });
    });

    it('should pass enabled and timeout fields directly', async () => {
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
      const sessionId: SessionId = 'agent_mcp_fields';
      mockedSetupWorkspace.mockResolvedValue({
        workspacePath: `/workspace/org/user/sessions/${sessionId}`,
        sessionHome: `/home/${sessionId}`,
      });

      const service = new SessionService();
      const mcpServers = {
        'disabled-server': {
          type: 'local' as const,
          command: ['test'],
          enabled: false,
          timeout: 30000,
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

      const callArgs = sandboxCreateSession.mock.calls[0][0] as { env: Record<string, string> };
      const configContent = JSON.parse(callArgs.env.KILO_CONFIG_CONTENT) as {
        mcp: Record<string, unknown>;
      };
      expect(configContent.mcp['disabled-server']).toEqual({
        type: 'local',
        command: ['test'],
        enabled: false,
        timeout: 30000,
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
        test: { type: 'local' as const, command: ['test-server'] },
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
          mcpServers: {
            test: { type: 'local', command: ['test-server'] },
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
        mcpServers: { github: { type: 'local' as const, command: ['mcp-github'] } },
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
        mcpServers: { server1: { type: 'local' as const, command: ['test'] } },
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
      expect(savedMetadata?.mcpServers?.server1).toEqual({ type: 'local', command: ['test'] });
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
        kiloSessionId: 'ses_test_kilo_session_id_0001',
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

    it('should include MCP config in KILO_CONFIG_CONTENT on resume', async () => {
      const metadata = {
        version: 123456789,
        sessionId: 'agent_resume_mcp',
        orgId: 'org',
        userId: 'user',
        timestamp: 123456789,
        githubRepo: 'acme/repo',
        kiloSessionId: 'ses_test_kilo_session_id_0001',
        mcpServers: {
          puppeteer: {
            type: 'local' as const,
            command: ['npx', '-y', '@modelcontextprotocol/server-puppeteer'],
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
        sessionId: 'agent_resume_mcp',
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: testEnv,
      });

      // Verify MCP config is passed through directly in KILO_CONFIG_CONTENT
      const callArgs = sandboxCreateSession.mock.calls[0][0] as { env: Record<string, string> };
      const configContent = JSON.parse(callArgs.env.KILO_CONFIG_CONTENT) as {
        mcp: Record<string, unknown>;
      };
      expect(configContent.mcp).toBeDefined();
      expect(configContent.mcp.puppeteer).toEqual({
        type: 'local',
        command: ['npx', '-y', '@modelcontextprotocol/server-puppeteer'],
      });
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
        }) as unknown,
        cwd: expect.any(String) as unknown,
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
        mcpServers: { test: { type: 'local' as const, command: ['test-server'] } },
        kiloSessionId: 'ses_test_kilo_session_id_0001',
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
        sessionId: 'agent_resume_all',
        kilocodeToken: 'token',
        kilocodeModel: 'test-model',
        env: testEnv,
      });

      // Verify envVars restored
      expect(sandboxCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ API_KEY: 'test' }) as unknown,
        })
      );

      // Verify setup commands re-run (because repo didn't exist, triggering reclone)
      expect(fakeSession.exec).toHaveBeenCalledWith('npm install', expect.any(Object) as unknown);

      // Verify MCP config passed through directly in KILO_CONFIG_CONTENT
      const callArgs = sandboxCreateSession.mock.calls[0][0] as { env: Record<string, string> };
      const configContent = JSON.parse(callArgs.env.KILO_CONFIG_CONTENT) as {
        mcp: Record<string, unknown>;
      };
      expect(configContent.mcp).toBeDefined();
      expect(configContent.mcp.test).toEqual({
        type: 'local',
        command: ['test-server'],
      });
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
      expect(result.processesFound).toBe(true);
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
      expect(result.processesFound).toBe(true);
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
      expect(result.processesFound).toBe(true);
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
      expect(result.processesFound).toBe(true);
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
      expect(result.processesFound).toBe(false);
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
      expect(result.processesFound).toBe(true);
      expect(result.message).toContain('killed 2 process(es)');
      expect(result.message).toContain('1 failed');
      expect(mockKillProcess).toHaveBeenCalledTimes(3);
    });
  });

  describe('initiateFromKiloSession', () => {
    it('should setup workspace and clone repo without creating session branch', async () => {
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
    });

    it('should save kiloSessionId in metadata', async () => {
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

    it('should run setup commands after clone', async () => {
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
        mode: 'code',
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
          mode: 'code',
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
    it('uses manageBranch when prepared session has upstreamBranch', async () => {
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
        mode: 'code',
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
        mode: 'code',
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
