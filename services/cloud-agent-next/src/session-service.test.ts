import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DevContainerModule from './kilo/devcontainer.js';

vi.mock('./logger.js', () => ({
  logger: {
    setTags: vi.fn(),
    withTags: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    withFields: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  WithLogTags: () => (_target: unknown, _propertyKey: string, descriptor: PropertyDescriptor) =>
    descriptor,
}));

const workspaceMocks = vi.hoisted(() => ({
  checkDiskAndCleanBeforeSetup: vi.fn().mockResolvedValue(undefined),
  cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
  cloneGitHubRepo: vi.fn().mockResolvedValue(undefined),
  cloneGitRepo: vi.fn().mockResolvedValue(undefined),
  manageBranch: vi.fn().mockResolvedValue('session/agent_test'),
  setupWorkspace: vi.fn().mockResolvedValue({
    workspacePath: '/workspace/user/sessions/agent_test',
    sessionHome: '/home/agent_test',
  }),
  updateGitRemoteToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./workspace.js', () => ({
  ...workspaceMocks,
  getSessionHomePath: (sessionId: string) => `/home/${sessionId}`,
  // Match the hardcoded `setupWorkspace` mock return so tests can assert on a
  // stable workspacePath; the shape stays representative of the real path.
  getSessionWorkspacePath: (_orgId: string | undefined, _userId: string, _sessionId: string) =>
    '/workspace/user/sessions/agent_test',
  GIT_COMMAND_TIMEOUT_MS: 120_000,
}));

const tokenMocks = vi.hoisted(() => ({
  resolveGitHubTokenForRepo: vi.fn(),
  resolveManagedGitLabToken: vi.fn(),
}));
const devcontainerMocks = vi.hoisted(() => ({
  bringUpDevContainer: vi.fn(),
  detectDevContainer: vi.fn(),
}));
const portMocks = vi.hoisted(() => ({
  randomPort: vi.fn(() => 4173),
}));

vi.mock('./services/git-token-service-client.js', () => tokenMocks);
vi.mock('./kilo/devcontainer.js', async importActual => ({
  ...(await importActual<typeof DevContainerModule>()),
  bringUpDevContainer: devcontainerMocks.bringUpDevContainer,
  detectDevContainer: devcontainerMocks.detectDevContainer,
}));
vi.mock('./kilo/ports.js', () => portMocks);

import { SessionService, fetchSessionMetadata } from './session-service.js';
import type { CloudAgentSessionState, PersistenceEnv } from './persistence/types.js';
import { parseSessionMetadata } from './persistence/session-metadata.js';
import type { ExecutionSession, SandboxInstance, SessionId } from './types.js';
import type { FencedWrapperDispatchRequest } from './execution/types.js';

type MockExecutionSession = ExecutionSession & {
  exec: ReturnType<typeof vi.fn>;
  gitCheckout: ReturnType<typeof vi.fn>;
};

function createSession(repoExists = false): MockExecutionSession {
  const exec = vi.fn(async (command: string) => {
    if (command.includes('test -d') && command.includes('.git')) {
      return { exitCode: repoExists ? 0 : 1, stdout: repoExists ? 'exists\n' : '', stderr: '' };
    }
    if (command.includes('kilo-restore-session.js')) {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const gitCheckout = vi.fn().mockResolvedValue({ success: true, exitCode: 0 });
  return { exec, gitCheckout } as unknown as MockExecutionSession;
}

function createSandbox(
  session: ExecutionSession,
  repoExists = false,
  writeFile = vi.fn().mockResolvedValue(undefined)
): SandboxInstance {
  return {
    createSession: vi.fn().mockResolvedValue(session),
    writeFile,
    mkdir: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn(async (command: string) => {
      if (command.includes('test -d') && command.includes('.git')) {
        return { exitCode: repoExists ? 0 : 1, stdout: repoExists ? 'exists\n' : '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
  } as unknown as SandboxInstance;
}

function createEnv(metadata?: CloudAgentSessionState | null): PersistenceEnv {
  return {
    Sandbox: {} as PersistenceEnv['Sandbox'],
    CLOUD_AGENT_SESSION: {
      idFromName: vi.fn(() => 'do-id' as unknown as DurableObjectId),
      get: vi.fn(() => ({
        getMetadata: vi.fn().mockResolvedValue(metadata ?? null),
        updateMetadata: vi.fn().mockResolvedValue(undefined),
      })),
    } as unknown as PersistenceEnv['CLOUD_AGENT_SESSION'],
    SESSION_INGEST: {
      fetch: vi.fn(),
      createSessionForCloudAgent: vi.fn().mockResolvedValue(undefined),
      deleteSessionForCloudAgent: vi.fn().mockResolvedValue(undefined),
    } as unknown as PersistenceEnv['SESSION_INGEST'],
    NEXTAUTH_SECRET: 'secret',
    INTERNAL_API_SECRET_PROD: {
      get: vi.fn().mockResolvedValue('internal-secret'),
    } as unknown as PersistenceEnv['INTERNAL_API_SECRET_PROD'],
    GIT_TOKEN_SERVICE: {
      getToken: vi.fn().mockResolvedValue('installation-token'),
      getTokenForRepo: vi.fn().mockResolvedValue({
        success: true,
        token: 'resolved-gh-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
      }),
      getGitLabToken: vi.fn().mockResolvedValue({
        success: true,
        token: 'resolved-gitlab-token',
        instanceUrl: 'https://gitlab.com',
      }),
    },
  } satisfies PersistenceEnv;
}

function createMetadata(overrides: Record<string, unknown> = {}): CloudAgentSessionState {
  return parseSessionMetadata({
    version: 1,
    sessionId: 'agent_test',
    userId: 'user_test',
    timestamp: 1,
    kilocodeToken: 'kilo-token',
    kiloSessionId: 'kilo-session',
    model: 'kilo/test-model',
    gitUrl: 'https://gitlab.com/acme/repo.git',
    gitToken: 'git-token',
    platform: 'gitlab',
    ...overrides,
  });
}

describe('SessionService.prepareWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceMocks.checkDiskAndCleanBeforeSetup.mockResolvedValue(undefined);
    workspaceMocks.cleanupWorkspace.mockResolvedValue(undefined);
    workspaceMocks.cloneGitHubRepo.mockResolvedValue(undefined);
    workspaceMocks.cloneGitRepo.mockResolvedValue(undefined);
    workspaceMocks.manageBranch.mockResolvedValue('session/agent_test');
    workspaceMocks.setupWorkspace.mockResolvedValue({
      workspacePath: '/workspace/user/sessions/agent_test',
      sessionHome: '/home/agent_test',
    });
    workspaceMocks.updateGitRemoteToken.mockResolvedValue(undefined);
    tokenMocks.resolveGitHubTokenForRepo.mockResolvedValue({
      success: true,
      value: {
        token: 'resolved-gh-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
      },
    });
    tokenMocks.resolveManagedGitLabToken.mockResolvedValue({
      success: true,
      token: 'resolved-gitlab-token',
    });
    devcontainerMocks.detectDevContainer.mockResolvedValue(null);
    devcontainerMocks.bringUpDevContainer.mockReset();
    portMocks.randomPort.mockReturnValue(4173);
  });

  it('prepares a cold workspace and returns ready metadata', async () => {
    const session = createSession(false);
    const sandbox = createSandbox(session);
    const metadata = createMetadata({ upstreamBranch: 'main', setupCommands: ['pnpm install'] });
    const progress = vi.fn();

    const result = await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'usr-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
      onProgress: progress,
    });

    expect(workspaceMocks.cloneGitRepo).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://gitlab.com/acme/repo.git',
      'resolved-gitlab-token',
      undefined,
      { platform: 'gitlab' }
    );
    expect(workspaceMocks.manageBranch).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'main',
      true
    );
    expect(progress).toHaveBeenCalledWith('kilo_session', 'Importing session…');
    expect(progress).toHaveBeenCalledWith('setup_commands', 'Running setup commands…');
    expect(result.ready).toMatchObject({
      workspacePath: '/workspace/user/sessions/agent_test',
      sandboxId: 'usr-abcdef',
      sessionHome: '/home/agent_test',
      branchName: 'main',
      kiloSessionId: 'kilo-session',
      gitToken: 'resolved-gitlab-token',
      gitlabTokenManaged: true,
    });
  });

  it('hydrates requested devcontainer metadata while preparing a cold DIND workspace', async () => {
    const session = createSession(false);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const sandbox = createSandbox(session, false, writeFile);
    const metadata = {
      ...createMetadata(),
      workspace: {
        sandboxId: 'dind-abcdef' as const,
        devcontainerRequested: true,
      },
    } satisfies CloudAgentSessionState;
    const devcontainerHandle = {
      containerId: 'container-dev',
      innerWorkspaceFolder: '/workspaces/repo',
      workspacePath: '/workspace/user/sessions/agent_test',
      agentSessionId: 'agent_test',
      overrideConfigPath: '/tmp/devcontainer-override-agent_test/devcontainer.json',
      teardown: vi.fn().mockResolvedValue(undefined),
    };
    devcontainerMocks.detectDevContainer.mockResolvedValue({
      configPath: '.devcontainer/devcontainer.json',
    });
    devcontainerMocks.bringUpDevContainer.mockResolvedValue(devcontainerHandle);

    const result = await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'dind-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(devcontainerMocks.detectDevContainer).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test'
    );
    expect(devcontainerMocks.bringUpDevContainer).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        workspacePath: '/workspace/user/sessions/agent_test',
        wrapperPort: 4173,
        configPath: '.devcontainer/devcontainer.json',
      })
    );
    expect(result.devcontainer).toBe(devcontainerHandle);
    expect(result.ready.devcontainer).toEqual({
      workspacePath: '/workspace/user/sessions/agent_test',
      innerWorkspaceFolder: '/workspaces/repo',
      wrapperPort: 4173,
      configPath: '.devcontainer/devcontainer.json',
    });
    expect(writeFile).toHaveBeenCalledWith(
      '/home/agent_test/tmp/kilo-empty-session-kilo-session.json',
      expect.any(String)
    );
    const bootstrapCall = session.exec.mock.calls.find(
      ([command]) => typeof command === 'string' && command.includes('kilo-restore-session.js')
    );
    expect(bootstrapCall?.[0]).toContain(
      '/home/agent_test/tmp/kilo-empty-session-kilo-session.json'
    );
  });

  it('reports the failing fresh-session bootstrap step', async () => {
    const session = createSession(false);
    session.exec.mockImplementation(async (command: string) => {
      if (command.includes('kilo-restore-session.js')) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            ok: false,
            step: 'diffs',
            error: 'failed to parse snapshot JSON',
            code: null,
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const sandbox = createSandbox(session);

    await expect(
      new SessionService().prepareWorkspace({
        sandbox,
        sandboxId: 'usr-abcdef',
        userId: 'user_test',
        sessionId: 'agent_test' as SessionId,
        env: createEnv(),
        metadata: createMetadata(),
        kilocodeModel: 'test-model',
      })
    ).rejects.toThrow(
      'Session bootstrap failed: exit 1, step=diffs, error=failed to parse snapshot JSON'
    );
  });

  it('restores devcontainer sessions with session-scoped Kilo XDG paths', async () => {
    const session = createSession(false);
    const sandbox = createSandbox(session);
    const metadata = {
      ...createMetadata({ preparedAt: 1 }),
      workspace: {
        sandboxId: 'dind-abcdef' as const,
        devcontainerRequested: true,
      },
    } satisfies CloudAgentSessionState;
    const devcontainerHandle = {
      containerId: 'container-dev',
      innerWorkspaceFolder: '/workspaces/repo',
      workspacePath: '/workspace/user/sessions/agent_test',
      agentSessionId: 'agent_test',
      overrideConfigPath: '/tmp/devcontainer-override-agent_test/devcontainer.json',
      teardown: vi.fn().mockResolvedValue(undefined),
    };
    devcontainerMocks.detectDevContainer.mockResolvedValue({
      configPath: '.devcontainer/devcontainer.json',
    });
    devcontainerMocks.bringUpDevContainer.mockResolvedValue(devcontainerHandle);

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'dind-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    const restoreCall = session.exec.mock.calls.find(
      ([command]) => typeof command === 'string' && command.includes('kilo-restore-session.js')
    );
    expect(restoreCall).toBeDefined();
    const restoreCommand = restoreCall?.[0];
    expect(restoreCommand).toContain('KILOCODE_TOKEN_FILE=');
    expect(restoreCommand).toContain('/home/agent_test/.local/share/kilo/session-restore-token');
    expect(restoreCommand).toContain('XDG_DATA_HOME=');
    expect(restoreCommand).toContain('/home/agent_test/.local/share');
    expect(restoreCommand).toContain('XDG_CONFIG_HOME=');
    expect(restoreCommand).toContain('/home/agent_test/.config');
    expect(restoreCommand).toContain('XDG_CACHE_HOME=');
    expect(restoreCommand).toContain('/home/agent_test/.cache');
    expect(restoreCommand).not.toContain('KILOCODE_TOKEN=');
  });

  it('refreshes the warm fast path GitHub remote with repo lookup token when legacy metadata stored a token', async () => {
    const session = createSession(true);
    const sandbox = createSandbox(session, true);
    const metadata = createMetadata({
      githubRepo: 'acme/repo',
      githubToken: 'old-gh-token',
      gitUrl: undefined,
      gitToken: undefined,
      platform: 'github',
      workspacePath: '/workspace/user/sessions/agent_test',
      sessionHome: '/home/agent_test',
      branchName: 'session/agent_test',
      sandboxId: 'usr-abcdef',
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'usr-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(workspaceMocks.cloneGitHubRepo).not.toHaveBeenCalled();
    expect(tokenMocks.resolveGitHubTokenForRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        GIT_TOKEN_SERVICE: expect.any(Object),
      }),
      {
        githubRepo: 'acme/repo',
        userId: 'user_test',
        orgId: undefined,
      }
    );
    expect(workspaceMocks.updateGitRemoteToken).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://github.com/acme/repo.git',
      'resolved-gh-token'
    );
  });

  it('uses stored generic git tokens without managed provider lookup', async () => {
    const session = createSession(false);
    const sandbox = createSandbox(session);
    const metadata = createMetadata({
      gitUrl: 'https://git.example.com/acme/repo.git',
      gitToken: 'generic-git-token',
      platform: undefined,
      gitlabTokenManaged: undefined,
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'usr-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(workspaceMocks.cloneGitRepo).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://git.example.com/acme/repo.git',
      'generic-git-token',
      undefined,
      { platform: undefined }
    );
    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    expect(tokenMocks.resolveGitHubTokenForRepo).not.toHaveBeenCalled();
  });

  it('restores persisted devcontainer runtime metadata on the warm fast path', async () => {
    const session = createSession(true);
    const sandbox = createSandbox(session, true);
    const metadata = createMetadata({
      workspacePath: '/workspace/user/sessions/agent_test',
      sessionHome: '/home/agent_test',
      branchName: 'session/agent_test',
      sandboxId: 'dind-abcdef',
      devcontainer: {
        workspacePath: '/workspace/user/sessions/agent_test',
        innerWorkspaceFolder: '/workspaces/repo',
        wrapperPort: 4173,
        configPath: '.devcontainer/devcontainer.json',
      },
    });
    const devcontainerHandle = {
      containerId: 'container-dev-warm',
      innerWorkspaceFolder: '/workspaces/repo',
      workspacePath: '/workspace/user/sessions/agent_test',
      agentSessionId: 'agent_test',
      overrideConfigPath: '/tmp/devcontainer-override-agent_test/devcontainer.json',
      teardown: vi.fn().mockResolvedValue(undefined),
    };
    devcontainerMocks.bringUpDevContainer.mockResolvedValue(devcontainerHandle);

    const result = await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'dind-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(devcontainerMocks.bringUpDevContainer).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        workspacePath: '/workspace/user/sessions/agent_test',
        wrapperPort: 4173,
      })
    );
    expect(result.devcontainer).toBe(devcontainerHandle);
    expect(result.ready.devcontainer).toEqual(metadata.devcontainer);
  });

  it('hydrates requested devcontainer metadata on the warm fast path when runtime metadata is missing', async () => {
    const session = createSession(true);
    const sandbox = createSandbox(session, true);
    const metadata = {
      ...createMetadata({
        workspacePath: '/workspace/user/sessions/agent_test',
        sessionHome: '/home/agent_test',
        branchName: 'session/agent_test',
        sandboxId: 'dind-abcdef',
      }),
      workspace: {
        sandboxId: 'dind-abcdef' as const,
        devcontainerRequested: true,
      },
    } satisfies CloudAgentSessionState;
    const devcontainerHandle = {
      containerId: 'container-dev-warm-detected',
      innerWorkspaceFolder: '/workspaces/repo',
      workspacePath: '/workspace/user/sessions/agent_test',
      agentSessionId: 'agent_test',
      overrideConfigPath: '/tmp/devcontainer-override-agent_test/devcontainer.json',
      teardown: vi.fn().mockResolvedValue(undefined),
    };
    devcontainerMocks.detectDevContainer.mockResolvedValue({
      configPath: '.devcontainer/devcontainer.json',
    });
    devcontainerMocks.bringUpDevContainer.mockResolvedValue(devcontainerHandle);

    const result = await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'dind-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(devcontainerMocks.detectDevContainer).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test'
    );
    expect(devcontainerMocks.bringUpDevContainer).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        workspacePath: '/workspace/user/sessions/agent_test',
        wrapperPort: 4173,
        configPath: '.devcontainer/devcontainer.json',
      })
    );
    expect(result.devcontainer).toBe(devcontainerHandle);
    expect(result.ready.devcontainer).toEqual({
      workspacePath: '/workspace/user/sessions/agent_test',
      innerWorkspaceFolder: '/workspaces/repo',
      wrapperPort: 4173,
      configPath: '.devcontainer/devcontainer.json',
    });
  });

  it('refreshes the warm fast path git remote with a fresh GitHub installation token', async () => {
    const session = createSession(true);
    const sandbox = createSandbox(session, true);
    const getTokenMock = vi.fn().mockResolvedValue('installation-token');
    const env = createEnv();
    env.GIT_TOKEN_SERVICE = {
      ...env.GIT_TOKEN_SERVICE,
      getToken: getTokenMock,
    } as PersistenceEnv['GIT_TOKEN_SERVICE'];
    const metadata = createMetadata({
      githubRepo: 'acme/repo',
      githubToken: 'stale-installation-token',
      githubInstallationId: '123',
      githubAppType: 'standard',
      gitUrl: undefined,
      gitToken: undefined,
      platform: 'github',
      workspacePath: '/workspace/user/sessions/agent_test',
      sessionHome: '/home/agent_test',
      branchName: 'session/agent_test',
      sandboxId: 'usr-abcdef',
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'usr-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env,
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(workspaceMocks.cloneGitHubRepo).not.toHaveBeenCalled();
    expect(getTokenMock).toHaveBeenCalledWith('123', 'standard');
    expect(workspaceMocks.updateGitRemoteToken).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://github.com/acme/repo.git',
      'installation-token'
    );
  });

  it('refreshes the warm fast path git remote with a fresh managed GitLab token even when legacy metadata opted out', async () => {
    const session = createSession(true);
    const sandbox = createSandbox(session, true);
    const metadata = createMetadata({
      gitUrl: 'https://gitlab.com/acme/repo.git',
      gitToken: 'stale-gitlab-token',
      platform: 'gitlab',
      gitlabTokenManaged: false,
      workspacePath: '/workspace/user/sessions/agent_test',
      sessionHome: '/home/agent_test',
      branchName: 'session/agent_test',
      sandboxId: 'usr-abcdef',
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'usr-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(workspaceMocks.cloneGitRepo).not.toHaveBeenCalled();
    expect(tokenMocks.resolveManagedGitLabToken).toHaveBeenCalled();
    expect(workspaceMocks.updateGitRemoteToken).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://gitlab.com/acme/repo.git',
      'resolved-gitlab-token',
      'gitlab'
    );
  });

  it('refreshes the warm fast path GitHub remote when repo lookup resolves a managed token', async () => {
    const session = createSession(true);
    const sandbox = createSandbox(session, true);
    const metadata = createMetadata({
      githubRepo: 'acme/repo',
      githubToken: 'user-supplied-token',
      githubInstallationId: undefined,
      gitUrl: undefined,
      gitToken: undefined,
      platform: 'github',
      workspacePath: '/workspace/user/sessions/agent_test',
      sessionHome: '/home/agent_test',
      branchName: 'session/agent_test',
      sandboxId: 'usr-abcdef',
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'usr-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(workspaceMocks.updateGitRemoteToken).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://github.com/acme/repo.git',
      'resolved-gh-token'
    );
  });

  it('throws when required metadata is missing', async () => {
    const metadata = createMetadata({ kilocodeToken: undefined });

    await expect(
      new SessionService().prepareWorkspace({
        sandbox: createSandbox(createSession()),
        sandboxId: 'usr-abcdef',
        userId: 'user_test',
        sessionId: 'agent_test' as SessionId,
        env: createEnv(),
        metadata,
      })
    ).rejects.toThrow('Missing kilocodeToken in session metadata');
  });
});

describe('SessionService.buildWrapperSessionReadyAndPromptRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tokenMocks.resolveGitHubTokenForRepo.mockResolvedValue({
      success: true,
      value: {
        token: 'resolved-gh-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
      },
    });
    tokenMocks.resolveManagedGitLabToken.mockResolvedValue({
      success: true,
      token: 'resolved-gitlab-token',
    });
    devcontainerMocks.detectDevContainer.mockResolvedValue(null);
    devcontainerMocks.bringUpDevContainer.mockReset();
    portMocks.randomPort.mockReturnValue(4173);
  });

  it('passes persisted devcontainer intent to the active wrapper readiness request', async () => {
    const service = new SessionService();
    const env = createEnv();
    env.WORKER_URL = 'https://cloud-agent.example.com';
    const metadata = {
      ...createMetadata(),
      workspace: {
        sandboxId: 'dind-abcdef' as const,
        devcontainerRequested: true,
      },
    } satisfies CloudAgentSessionState;

    const result = await service.buildWrapperSessionReadyAndPromptRequests({
      env,
      plan: {
        scope: {
          sessionId: 'agent_test',
          userId: 'user_test',
        },
        turn: {
          type: 'prompt',
          messageId: 'msg_018f1e2d3c4bDevReadyAbCdEF',
          prompt: 'Use the devcontainer runtime',
        },
        agent: {
          mode: 'code',
          model: 'test-model',
        },
        workspace: {
          sandboxId: 'dind-abcdef',
          metadata,
        },
        wrapper: {
          fence: {
            wrapperRunId: 'wr_devcontainer',
            wrapperGeneration: 2,
            wrapperConnectionId: 'conn_devcontainer',
          },
        },
      } satisfies FencedWrapperDispatchRequest,
    });

    expect(result.readyRequest.devcontainer).toEqual({ requested: true });
    expect(result.ready.devcontainer).toBeUndefined();
  });

  it('materializes workspace setup and prompt delivery into separate wrapper requests', async () => {
    const service = new SessionService();
    const env = createEnv();
    env.WORKER_URL = 'https://cloud-agent.example.com';
    const metadata = createMetadata({
      setupCommands: ['pnpm install'],
      envVars: { PUBLIC_VALUE: 'visible' },
      upstreamBranch: 'main',
    });

    const result = await service.buildWrapperSessionReadyAndPromptRequests({
      env,
      plan: {
        scope: {
          sessionId: 'agent_test',
          userId: 'user_test',
        },
        turn: {
          type: 'prompt',
          messageId: 'msg_018f1e2d3c4bPayloadTestAAAA',
          prompt: 'Do the work',
        },
        agent: {
          mode: 'code',
          model: 'test-model',
          variant: 'thinking',
        },
        finalization: {
          autoCommit: true,
          condenseOnComplete: false,
        },
        workspace: {
          sandboxId: 'usr-abcdef',
          metadata,
        },
        wrapper: {
          fence: {
            wrapperRunId: 'wr_test',
            wrapperGeneration: 2,
            wrapperConnectionId: 'conn_test',
          },
        },
      } satisfies FencedWrapperDispatchRequest,
    });

    expect(workspaceMocks.setupWorkspace).not.toHaveBeenCalled();
    expect(workspaceMocks.cloneGitRepo).not.toHaveBeenCalled();
    expect(result.ready).toMatchObject({
      workspacePath: '/workspace/user/sessions/agent_test',
      sandboxId: 'usr-abcdef',
      sessionHome: '/home/agent_test',
      branchName: 'main',
      kiloSessionId: 'kilo-session',
      gitToken: 'resolved-gitlab-token',
      gitlabTokenManaged: true,
    });
    expect(result.readyRequest).toMatchObject({
      agentSessionId: 'agent_test',
      userId: 'user_test',
      sandboxId: 'usr-abcdef',
      kiloSessionId: 'kilo-session',
      workspace: {
        workspacePath: '/workspace/user/sessions/agent_test',
        sessionHome: '/home/agent_test',
        branchName: 'main',
        upstreamBranch: 'main',
      },
      repo: {
        kind: 'git',
        url: 'https://gitlab.com/acme/repo.git',
        token: 'resolved-gitlab-token',
        platform: 'gitlab',
      },
      materialized: {
        setupCommands: ['pnpm install'],
      },
    });
    expect(result.readyRequest).not.toHaveProperty('prompt');
    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') throw new Error('Expected prompt delivery request');
    expect(result.promptRequest).not.toHaveProperty('workspace');
    expect(result.promptRequest).not.toHaveProperty('materialized');
    expect(result.readyRequest.materialized.env.PUBLIC_VALUE).toBe('visible');
    expect(result.readyRequest.materialized.env.KILOCODE_TOKEN).toBe('kilo-token');
    expect(result.readyRequest.session.workerAuthToken).toBe('kilo-token');
    expect(result.readyRequest.session.wrapperRunId).toBe('wr_test');
    expect(result.readyRequest).not.toHaveProperty('message');
    expect(result.readyRequest).not.toHaveProperty('agent');
    expect(result.readyRequest).not.toHaveProperty('finalization');
    expect(result.promptRequest).toMatchObject({
      message: {
        id: 'msg_018f1e2d3c4bPayloadTestAAAA',
        prompt: 'Do the work',
      },
      agent: {
        model: { modelID: 'test-model' },
        variant: 'thinking',
        mode: 'code',
      },
      finalization: {
        autoCommit: true,
        condenseOnComplete: false,
      },
    });
    expect(result.promptRequest).not.toHaveProperty('messageId');
    expect(result.promptRequest).not.toHaveProperty('prompt');
    expect(result.promptRequest).not.toHaveProperty('attachments');
    expect(result.promptRequest.session).toEqual(result.readyRequest.session);
  });
});

describe('fetchSessionMetadata', () => {
  it('returns parsed metadata from the session DO', async () => {
    const metadata = createMetadata();
    const env = createEnv(metadata);

    await expect(fetchSessionMetadata(env, 'user_test', 'agent_test')).resolves.toEqual(metadata);
  });
});
