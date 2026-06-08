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
  updateGitAuthor: vi.fn().mockResolvedValue(undefined),
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
  resolveCloudAgentGitHubAuthForRepo: vi.fn(),
  resolveManagedGitLabToken: vi.fn(),
}));
const devcontainerMocks = vi.hoisted(() => ({
  bringUpDevContainer: vi.fn(),
  detectDevContainer: vi.fn(),
}));
const portMocks = vi.hoisted(() => ({
  randomPort: vi.fn(() => 4173),
}));
const attachmentMocks = vi.hoisted(() => ({
  buildSignedPromptAttachments: vi.fn().mockResolvedValue([]),
}));

vi.mock('./services/git-token-service-client.js', () => tokenMocks);
vi.mock('./kilo/devcontainer.js', async importActual => ({
  ...(await importActual<typeof DevContainerModule>()),
  bringUpDevContainer: devcontainerMocks.bringUpDevContainer,
  detectDevContainer: devcontainerMocks.detectDevContainer,
}));
vi.mock('./kilo/ports.js', () => portMocks);
vi.mock('./execution/attachment-prompt-parts.js', () => attachmentMocks);

import {
  SessionService,
  buildCommandGuardBashPermissions,
  fetchSessionMetadata,
  getCommandGuardPolicy,
} from './session-service.js';
import type { CloudAgentSessionState, PersistenceEnv } from './persistence/types.js';
import { parseSessionMetadata } from './persistence/session-metadata.js';
import type { ExecutionSession, SandboxInstance, SessionId } from './types.js';
import type { FencedWrapperDispatchRequest } from './execution/types.js';
import {
  SandboxCapacityInspectionError,
  WorkspaceCapacityAdmissionRejectedError,
} from './workspace-errors.js';

type MockExecutionSession = ExecutionSession & {
  exec: ReturnType<typeof vi.fn>;
  gitCheckout: ReturnType<typeof vi.fn>;
};

describe('code-review command guard policy', () => {
  it('allows required review publication and remote refresh commands while denying repository mutation', () => {
    const policy = getCommandGuardPolicy('code-review');
    if (!policy) throw new Error('Expected code-review command guard policy');

    const bashPermissions = buildCommandGuardBashPermissions(policy);

    expect(bashPermissions['glab']).toBeUndefined();
    expect(bashPermissions['glab *']).toBeUndefined();
    expect(bashPermissions['gh']).toBeUndefined();
    expect(bashPermissions['gh *']).toBeUndefined();

    expect(bashPermissions['glab mr diff']).toBe('allow');
    expect(bashPermissions['glab mr diff *']).toBe('allow');
    expect(bashPermissions['glab api --method POST *merge_requests/*/notes*']).toBe('allow');
    expect(bashPermissions['glab api --method PUT *merge_requests/*/notes/*']).toBe('allow');
    expect(bashPermissions['glab api --method POST *merge_requests/*/discussions*']).toBe('allow');

    expect(bashPermissions['gh pr diff']).toBe('allow');
    expect(bashPermissions['gh api repos/*/issues/*/comments --input*']).toBe('allow');
    expect(bashPermissions['gh api repos/*/issues/comments/* -X PATCH*']).toBe('allow');
    expect(bashPermissions['gh api repos/*/pulls/*/reviews --input*']).toBe('allow');

    expect(bashPermissions['git']).toBe('allow');
    expect(bashPermissions['git *']).toBe('allow');
    expect(bashPermissions['git fetch']).toBe('allow');
    expect(bashPermissions['git fetch *']).toBe('allow');
    expect(bashPermissions['git pull']).toBe('allow');
    expect(bashPermissions['git pull *']).toBe('allow');
    expect(bashPermissions['git push']).toBe('deny');
    expect(bashPermissions['git push *']).toBe('deny');
    expect(bashPermissions['git commit']).toBe('deny');
    expect(bashPermissions['git commit *']).toBe('deny');
    expect(bashPermissions['glab mr merge']).toBe('deny');
    expect(bashPermissions['glab mr merge *']).toBe('deny');
    expect(bashPermissions['glab auth']).toBe('deny');
    expect(bashPermissions['glab auth *']).toBe('deny');
  });
});

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

type TestSandbox = SandboxInstance & {
  createSessionMock: ReturnType<typeof vi.fn>;
};

function createSandbox(
  session: ExecutionSession,
  repoExists = false,
  writeFile = vi.fn().mockResolvedValue(undefined)
): TestSandbox {
  const createSessionMock = vi.fn().mockResolvedValue(session);
  return {
    createSession: createSessionMock,
    createSessionMock,
    writeFile,
    mkdir: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn(async (command: string) => {
      if (command.includes('test -d') && command.includes('.git')) {
        return { exitCode: repoExists ? 0 : 1, stdout: repoExists ? 'exists\n' : '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
  } as unknown as TestSandbox;
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
      getCloudAgentAuthForRepo: vi.fn().mockResolvedValue({
        success: true,
        githubToken: 'resolved-gh-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
      }),
      getGitLabToken: vi.fn().mockResolvedValue({
        success: true,
        token: 'resolved-gitlab-token',
        instanceUrl: 'https://gitlab.com',
        glabIsOAuth2: true,
      }),
    },
    NOTIFICATIONS: {} as unknown as PersistenceEnv['NOTIFICATIONS'],
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

function createGitLabCodeReviewMetadata(): CloudAgentSessionState {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'agent_test',
      userId: 'user_test',
      createdOnPlatform: 'code-review',
    },
    auth: {
      kilocodeToken: 'kilo-token',
      kiloSessionId: 'kilo-session',
    },
    repository: {
      type: 'gitlab',
      url: 'https://gitlab.com/acme/repo.git',
      platform: 'gitlab',
    },
    agent: { mode: 'code', model: 'kilo/test-model' },
    lifecycle: { version: 1, timestamp: 1 },
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
    workspaceMocks.updateGitAuthor.mockResolvedValue(undefined);
    workspaceMocks.updateGitRemoteToken.mockResolvedValue(undefined);
    tokenMocks.resolveCloudAgentGitHubAuthForRepo.mockResolvedValue({
      success: true,
      value: {
        githubToken: 'resolved-gh-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
      },
    });
    tokenMocks.resolveManagedGitLabToken.mockResolvedValue({
      success: true,
      token: 'resolved-gitlab-token',
      glabIsOAuth2: true,
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

    expect(workspaceMocks.checkDiskAndCleanBeforeSetup).toHaveBeenCalledWith(
      sandbox,
      undefined,
      'user_test',
      'agent_test',
      { inspectContainers: false }
    );
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

  it('types ENOSPC during the cold devcontainer probe before provisioning', async () => {
    const session = createSession(false);
    const sandbox = createSandbox(session);
    (sandbox.exec as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'ENOSPC: no space left on device',
    });
    const metadata = {
      ...createMetadata(),
      workspace: {
        sandboxId: 'dind-abcdef' as const,
        devcontainerRequested: true,
      },
    } satisfies CloudAgentSessionState;

    await expect(
      new SessionService().prepareWorkspace({
        sandbox,
        sandboxId: 'dind-abcdef',
        userId: 'user_test',
        sessionId: 'agent_test' as SessionId,
        env: createEnv(),
        metadata,
        kilocodeModel: 'test-model',
      })
    ).rejects.toBeInstanceOf(SandboxCapacityInspectionError);

    expect(workspaceMocks.setupWorkspace).not.toHaveBeenCalled();
    expect(sandbox.createSessionMock).not.toHaveBeenCalled();
  });

  it('rejects cold devcontainer preparation before workspace or runtime provisioning when admission fails', async () => {
    const session = createSession(false);
    const sandbox = createSandbox(session);
    const metadata = {
      ...createMetadata(),
      workspace: {
        sandboxId: 'dind-abcdef' as const,
        devcontainerRequested: true,
      },
    } satisfies CloudAgentSessionState;
    const rejection = new WorkspaceCapacityAdmissionRejectedError({
      availableMB: 512,
      thresholdMB: 2048,
      cleaned: 0,
      skipped: 1,
    });
    workspaceMocks.checkDiskAndCleanBeforeSetup.mockRejectedValueOnce(rejection);

    await expect(
      new SessionService().prepareWorkspace({
        sandbox,
        sandboxId: 'dind-abcdef',
        userId: 'user_test',
        sessionId: 'agent_test' as SessionId,
        env: createEnv(),
        metadata,
        kilocodeModel: 'test-model',
      })
    ).rejects.toBe(rejection);

    expect(workspaceMocks.checkDiskAndCleanBeforeSetup).toHaveBeenCalledWith(
      sandbox,
      undefined,
      'user_test',
      'agent_test',
      { inspectContainers: true }
    );
    expect(workspaceMocks.setupWorkspace).not.toHaveBeenCalled();
    expect(sandbox.createSessionMock).not.toHaveBeenCalled();
    expect(devcontainerMocks.bringUpDevContainer).not.toHaveBeenCalled();
  });

  it('keeps requested devcontainer cleanup fail-closed when the sandbox ID is not DIND', async () => {
    const session = createSession(false);
    const sandbox = createSandbox(session);
    const metadata = {
      ...createMetadata(),
      workspace: {
        sandboxId: 'usr-abcdef' as const,
        devcontainerRequested: true,
      },
    } satisfies CloudAgentSessionState;
    const rejection = new WorkspaceCapacityAdmissionRejectedError({
      availableMB: 512,
      thresholdMB: 2048,
      cleaned: 0,
      skipped: 1,
    });
    workspaceMocks.checkDiskAndCleanBeforeSetup.mockRejectedValueOnce(rejection);

    await expect(
      new SessionService().prepareWorkspace({
        sandbox,
        sandboxId: 'usr-abcdef',
        userId: 'user_test',
        sessionId: 'agent_test' as SessionId,
        env: createEnv(),
        metadata,
        kilocodeModel: 'test-model',
      })
    ).rejects.toBe(rejection);

    expect(workspaceMocks.checkDiskAndCleanBeforeSetup).toHaveBeenCalledWith(
      sandbox,
      undefined,
      'user_test',
      'agent_test',
      { inspectContainers: true }
    );
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
    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        GIT_TOKEN_SERVICE: expect.any(Object),
      }),
      {
        githubRepo: 'acme/repo',
        userId: 'user_test',
        orgId: undefined,
        allowUserAuthorization: false,
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
    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
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
    const getTokenMock = vi.fn().mockResolvedValue('legacy-installation-token');
    const env = createEnv();
    env.GIT_TOKEN_SERVICE = {
      ...env.GIT_TOKEN_SERVICE,
      getToken: getTokenMock,
    } as PersistenceEnv['GIT_TOKEN_SERVICE'];
    tokenMocks.resolveCloudAgentGitHubAuthForRepo.mockResolvedValueOnce({
      success: true,
      value: {
        githubToken: 'installation-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
      },
    });
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
    expect(getTokenMock).not.toHaveBeenCalled();
    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).toHaveBeenCalled();
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

  it('refreshes a warm GitLab code-review remote with the generically resolved project token', async () => {
    const session = createSession(true);
    const sandbox = createSandbox(session, true);
    tokenMocks.resolveManagedGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'resolved-project-token',
      glabIsOAuth2: false,
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'usr-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata: createGitLabCodeReviewMetadata(),
      kilocodeModel: 'test-model',
    });

    expect(tokenMocks.resolveManagedGitLabToken).toHaveBeenCalledWith(expect.any(Object), {
      userId: 'user_test',
      orgId: undefined,
      repositoryUrl: 'https://gitlab.com/acme/repo.git',
      createdOnPlatform: 'code-review',
    });
    expect(workspaceMocks.updateGitRemoteToken).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://gitlab.com/acme/repo.git',
      'resolved-project-token',
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
    tokenMocks.resolveCloudAgentGitHubAuthForRepo.mockResolvedValue({
      success: true,
      value: {
        githubToken: 'resolved-gh-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
      },
    });
    tokenMocks.resolveManagedGitLabToken.mockResolvedValue({
      success: true,
      token: 'resolved-gitlab-token',
      glabIsOAuth2: true,
    });
    devcontainerMocks.detectDevContainer.mockResolvedValue(null);
    devcontainerMocks.bringUpDevContainer.mockReset();
    portMocks.randomPort.mockReturnValue(4173);
    attachmentMocks.buildSignedPromptAttachments.mockResolvedValue([]);
  });

  async function buildPromptWrapperRequests(
    metadata: CloudAgentSessionState,
    configureEnv?: (env: PersistenceEnv) => void
  ) {
    const service = new SessionService();
    const env = createEnv();
    env.WORKER_URL = 'https://cloud-agent.example.com';
    configureEnv?.(env);

    return service.buildWrapperSessionReadyAndPromptRequests({
      env,
      plan: {
        scope: {
          sessionId: 'agent_test',
          userId: 'user_test',
        },
        turn: {
          type: 'prompt',
          messageId: 'msg_018f1e2d3c4bGitLabEnvAAAA',
          prompt: 'Do the work',
        },
        agent: {
          mode: 'code',
          model: 'test-model',
        },
        workspace: {
          sandboxId: 'usr-abcdef',
          metadata,
        },
        wrapper: {
          fence: {
            wrapperRunId: 'wr_gitlab_env',
            wrapperGeneration: 2,
            wrapperConnectionId: 'conn_gitlab_env',
          },
        },
      } satisfies FencedWrapperDispatchRequest,
    });
  }

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

  it('materializes workspace setup and prompt delivery without using provider token overrides for ingest auth', async () => {
    const service = new SessionService();
    const env = createEnv();
    env.WORKER_URL = 'https://cloud-agent.example.com';
    env.KILOCODE_TOKEN_OVERRIDE = 'provider-override-token';
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
    expect(result.readyRequest.materialized.env.KILOCODE_TOKEN).toBe('provider-override-token');
    expect(JSON.parse(result.readyRequest.materialized.env.KILO_AUTH_CONTENT)).toEqual({
      kilo: { type: 'api', key: 'kilo-token' },
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('resolved-gitlab-token');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.com');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBe('true');
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

  it('allowlists only the active session attachment directory for Kilo file access', async () => {
    const result = await buildPromptWrapperRequests(createMetadata());
    const config: unknown = JSON.parse(result.readyRequest.materialized.env.KILO_CONFIG_CONTENT);

    expect(config).toMatchObject({
      permission: {
        external_directory: {
          '*': 'deny',
          '/tmp/agent_test/**': 'allow',
          '/tmp/attachments/agent_test/**': 'allow',
        },
      },
    });
    expect(config).not.toMatchObject({
      permission: { external_directory: { '/tmp/attachments/**': 'allow' } },
    });
  });

  it('passes canonical document attachments through signed wrapper prompt construction', async () => {
    const service = new SessionService();
    const env = createEnv();
    env.WORKER_URL = 'https://cloud-agent.example.com';
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
    };
    const signedAttachments = [
      {
        filename: attachments.files[0],
        mime: 'application/pdf',
        signedUrl: 'https://r2.example.com/document.pdf',
        localPath: '/tmp/attachments/agent_test/document.pdf',
      },
    ];
    attachmentMocks.buildSignedPromptAttachments.mockResolvedValueOnce(signedAttachments);

    const result = await service.buildWrapperSessionReadyAndPromptRequests({
      env,
      plan: {
        scope: { sessionId: 'agent_test', userId: 'user_test' },
        turn: {
          type: 'prompt',
          messageId: 'msg_018f1e2d3c4bDocumentPayload',
          prompt: 'Read the document',
          attachments,
        },
        agent: { mode: 'code', model: 'test-model' },
        workspace: { sandboxId: 'usr-abcdef', metadata: createMetadata() },
        wrapper: {
          fence: {
            wrapperRunId: 'wr_attachment',
            wrapperGeneration: 1,
            wrapperConnectionId: 'conn_attachment',
          },
        },
      } satisfies FencedWrapperDispatchRequest,
    });

    expect(attachmentMocks.buildSignedPromptAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ env, userId: 'user_test', sessionId: 'agent_test', attachments })
    );
    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') throw new Error('Expected prompt delivery request');
    expect(result.promptRequest.message.attachments).toEqual(signedAttachments);
  });

  it('uses selected user GitHub auth for the remote, author, and managed GH_TOKEN', async () => {
    tokenMocks.resolveCloudAgentGitHubAuthForRepo.mockResolvedValueOnce({
      success: true,
      value: {
        githubToken: 'selected-user-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'user',
        gitAuthor: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
        commitCoAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
      },
    });
    const metadata = createMetadata({
      githubRepo: 'acme/repo',
      gitUrl: undefined,
      gitToken: undefined,
      platform: 'github',
      createdOnPlatform: 'cloud-agent-web',
    });
    const result = await buildPromptWrapperRequests(metadata);

    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).toHaveBeenCalledWith(expect.any(Object), {
      githubRepo: 'acme/repo',
      userId: 'user_test',
      orgId: undefined,
      allowUserAuthorization: true,
    });
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'github',
      token: 'selected-user-token',
      gitAuthor: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
    });
    expect(result.readyRequest.materialized.env.GH_TOKEN).toBe('selected-user-token');
    if (result.type !== 'prompt') throw new Error('Expected prompt delivery request');
    expect(result.promptRequest.finalization?.commitCoAuthor).toEqual({
      name: 'kiloconnect[bot]',
      email: 'bot@example.com',
    });
  });

  it('requests user GitHub auth eligibility for Slack bot sessions', async () => {
    const metadata = createMetadata({
      githubRepo: 'acme/repo',
      gitUrl: undefined,
      gitToken: undefined,
      platform: 'github',
      createdOnPlatform: 'slack',
    });
    await buildPromptWrapperRequests(metadata);

    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).toHaveBeenCalledWith(expect.any(Object), {
      githubRepo: 'acme/repo',
      userId: 'user_test',
      orgId: undefined,
      allowUserAuthorization: true,
    });
  });

  it.each([undefined, 'code-review', 'discord', 'github'])(
    'requests installation-only GitHub auth for %s-origin sessions',
    async createdOnPlatform => {
      await buildPromptWrapperRequests(
        createMetadata({
          githubRepo: 'acme/repo',
          gitUrl: undefined,
          gitToken: undefined,
          platform: 'github',
          createdOnPlatform,
        })
      );

      expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).toHaveBeenCalledWith(
        expect.any(Object),
        {
          githubRepo: 'acme/repo',
          userId: 'user_test',
          orgId: undefined,
          allowUserAuthorization: false,
        }
      );
    }
  );

  it('reconstructs installation author identity during legacy token-service fallback', async () => {
    tokenMocks.resolveCloudAgentGitHubAuthForRepo.mockResolvedValueOnce({
      success: true,
      value: {
        githubToken: 'legacy-installation-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
      },
    });
    const result = await buildPromptWrapperRequests(
      createMetadata({
        githubRepo: 'acme/repo',
        gitUrl: undefined,
        gitToken: undefined,
        platform: 'github',
      }),
      env => {
        env.GITHUB_APP_SLUG = 'kiloconnect-development';
        env.GITHUB_APP_BOT_USER_ID = '242397087';
      }
    );

    expect(result.readyRequest.repo).toMatchObject({
      kind: 'github',
      token: 'legacy-installation-token',
      gitAuthor: {
        name: 'kiloconnect-development[bot]',
        email: '242397087+kiloconnect-development[bot]@users.noreply.github.com',
      },
    });
  });

  it('preserves an explicit profile GH_TOKEN over selected user authorization', async () => {
    tokenMocks.resolveCloudAgentGitHubAuthForRepo.mockResolvedValueOnce({
      success: true,
      value: {
        githubToken: 'selected-user-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'user',
        gitAuthor: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
        commitCoAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
      },
    });
    const result = await buildPromptWrapperRequests(
      createMetadata({
        githubRepo: 'acme/repo',
        gitUrl: undefined,
        gitToken: undefined,
        platform: 'github',
        createdOnPlatform: 'cloud-agent-web',
        envVars: { GH_TOKEN: 'explicit-profile-token' },
      })
    );

    expect(result.readyRequest.materialized.env.GH_TOKEN).toBe('explicit-profile-token');
  });

  it('materializes OAuth bearer mode with a self-managed GitLab host', async () => {
    const result = await buildPromptWrapperRequests(
      createMetadata({
        gitUrl: 'https://gitlab.example.com:8443/acme/repo.git',
        platform: 'gitlab',
      })
    );

    expect(result.ready).toMatchObject({
      gitToken: 'resolved-gitlab-token',
      gitlabTokenManaged: true,
    });
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'git',
      url: 'https://gitlab.example.com:8443/acme/repo.git',
      token: 'resolved-gitlab-token',
      platform: 'gitlab',
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('resolved-gitlab-token');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.example.com:8443');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBe('true');
  });

  it('preserves an explicit profile GLAB_IS_OAUTH2 value when injecting a managed GitLab token', async () => {
    const result = await buildPromptWrapperRequests(
      createMetadata({
        envVars: {
          GLAB_IS_OAUTH2: 'false',
        },
      })
    );

    expect(result.ready).toMatchObject({
      gitToken: 'resolved-gitlab-token',
      gitlabTokenManaged: true,
    });
    expect(result.readyRequest.repo).toMatchObject({
      token: 'resolved-gitlab-token',
      platform: 'gitlab',
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('resolved-gitlab-token');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.com');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBe('false');
  });

  it('materializes generic review-origin GitLab project tokens with OAuth mode disabled', async () => {
    tokenMocks.resolveManagedGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'resolved-project-token',
      glabIsOAuth2: false,
    });
    const result = await buildPromptWrapperRequests(createGitLabCodeReviewMetadata());

    expect(tokenMocks.resolveManagedGitLabToken).toHaveBeenCalledWith(expect.any(Object), {
      userId: 'user_test',
      orgId: undefined,
      repositoryUrl: 'https://gitlab.com/acme/repo.git',
      createdOnPlatform: 'code-review',
    });
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'git',
      token: 'resolved-project-token',
      platform: 'gitlab',
      refreshRemote: true,
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('resolved-project-token');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBe('false');
  });

  it('does not allow profile GitLab credentials to replace a resolved project token', async () => {
    tokenMocks.resolveManagedGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'resolved-project-token',
      glabIsOAuth2: false,
    });
    const metadata = {
      ...createGitLabCodeReviewMetadata(),
      profile: {
        envVars: {
          GITLAB_TOKEN: 'configured-human-token',
          GLAB_IS_OAUTH2: 'true',
          GITLAB_HOST: 'untrusted.example.com',
        },
      },
    } satisfies CloudAgentSessionState;

    const result = await buildPromptWrapperRequests(metadata);

    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('resolved-project-token');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBe('false');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.com');
  });

  it.each([
    [
      'no_project_token',
      'GitLab token lookup failed (no_project_token). No GitLab project access token is configured for this repository. Reconfigure or reinstall the GitLab code-review bot for the project.',
    ],
    [
      'ambiguous_integration',
      'GitLab token lookup failed (ambiguous_integration). Multiple GitLab integrations or project tokens match this repository. Remove duplicate GitLab integrations or reconfigure the GitLab code-review integration.',
    ],
    [
      'no_matching_integration',
      'GitLab token lookup failed (no_matching_integration). No authorized GitLab integration matches this repository. Connect the GitLab account or organization that has access to the repository.',
    ],
    [
      'project_lookup_failed',
      'GitLab token lookup failed (project_lookup_failed). The connected GitLab integration cannot read this project. Grant repository access, then reconnect GitLab if required.',
    ],
  ])(
    'reports actionable review-origin GitLab token lookup failure for %s without using a human-token fallback',
    async (reason, expectedMessage) => {
      const metadata = createGitLabCodeReviewMetadata();
      if (!metadata.repository || metadata.repository.type !== 'gitlab') {
        throw new Error('Expected GitLab code-review metadata');
      }
      const metadataWithFallbackToken = {
        ...metadata,
        repository: {
          ...metadata.repository,
          token: 'configured-human-token',
        },
      } satisfies CloudAgentSessionState;

      tokenMocks.resolveManagedGitLabToken.mockResolvedValueOnce({
        success: false,
        reason,
      });

      await expect(buildPromptWrapperRequests(metadataWithFallbackToken)).rejects.toThrow(
        expectedMessage
      );
      expect(tokenMocks.resolveManagedGitLabToken).toHaveBeenCalledOnce();
    }
  );

  it('keeps reconnect guidance for GitLab OAuth-token lifecycle failures', async () => {
    tokenMocks.resolveManagedGitLabToken.mockResolvedValueOnce({
      success: false,
      reason: 'token_refresh_failed',
    });

    await expect(buildPromptWrapperRequests(createGitLabCodeReviewMetadata())).rejects.toThrow(
      'GitLab token lookup failed (token_refresh_failed). Please reconnect your GitLab account.'
    );
    expect(tokenMocks.resolveManagedGitLabToken).toHaveBeenCalledOnce();
  });

  it('does not use OAuth bearer mode for inferred legacy GitLab tokens', async () => {
    const result = await buildPromptWrapperRequests(
      createMetadata({
        gitUrl: 'https://gitlab.com/acme/repo.git',
        gitToken: 'generic-git-token',
        platform: undefined,
        gitlabTokenManaged: undefined,
      })
    );

    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    expect(result.ready).toMatchObject({
      gitToken: 'generic-git-token',
      gitlabTokenManaged: undefined,
    });
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'git',
      url: 'https://gitlab.com/acme/repo.git',
      token: 'generic-git-token',
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('generic-git-token');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.com');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBeUndefined();
  });
});

describe('SessionService session-ingest compatibility', () => {
  it('creates a visible session without projecting reporting milestones', async () => {
    const env = createEnv();
    const service = new SessionService();

    await service.createCliSessionViaSessionIngest(
      'ses_12345678901234567890123456',
      'agent_12345678-1234-1234-1234-123456789abc',
      'user_test',
      env,
      undefined,
      'cloud-agent'
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(env.SESSION_INGEST.createSessionForCloudAgent).toHaveBeenCalledWith(
      expect.not.objectContaining({ requireFullSessionReport: expect.anything() })
    );
  });
});

describe('fetchSessionMetadata', () => {
  it('returns parsed metadata from the session DO', async () => {
    const metadata = createMetadata();
    const env = createEnv(metadata);

    await expect(fetchSessionMetadata(env, 'user_test', 'agent_test')).resolves.toEqual(metadata);
  });
});
