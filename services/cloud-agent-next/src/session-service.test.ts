import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('./services/git-token-service-client.js', () => tokenMocks);

import { SessionService, fetchSessionMetadata } from './session-service.js';
import type { CloudAgentSessionState, PersistenceEnv } from './persistence/types.js';
import { parseSessionMetadata } from './persistence/session-metadata.js';
import type { ExecutionSession, SandboxInstance, SessionId } from './types.js';
import type { MessageDeliveryPlan } from './execution/types.js';

function createSession(repoExists = false): ExecutionSession {
  return {
    exec: vi.fn(async (command: string) => {
      if (command.includes('test -d') && command.includes('.git')) {
        return { exitCode: repoExists ? 0 : 1, stdout: repoExists ? 'exists\n' : '', stderr: '' };
      }
      if (command.includes('kilo-restore-session.js')) {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    gitCheckout: vi.fn().mockResolvedValue({ success: true, exitCode: 0 }),
  } as unknown as ExecutionSession;
}

function createSandbox(session: ExecutionSession, repoExists = false): SandboxInstance {
  return {
    createSession: vi.fn().mockResolvedValue(session),
    writeFile: vi.fn().mockResolvedValue(undefined),
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

  it('uses the warm fast path when .git exists and applies token overrides', async () => {
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
      tokenOverrides: { githubToken: 'new-gh-token' },
      kilocodeModel: 'test-model',
    });

    expect(workspaceMocks.cloneGitHubRepo).not.toHaveBeenCalled();
    expect(workspaceMocks.updateGitRemoteToken).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://github.com/acme/repo.git',
      'new-gh-token'
    );
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

  it('refreshes the warm fast path git remote with a fresh managed GitLab token', async () => {
    const session = createSession(true);
    const sandbox = createSandbox(session, true);
    const metadata = createMetadata({
      gitUrl: 'https://gitlab.com/acme/repo.git',
      gitToken: 'stale-gitlab-token',
      platform: 'gitlab',
      gitlabTokenManaged: true,
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

  it('does not rewrite the warm fast path git remote when the user-provided GitHub token is unchanged', async () => {
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

    expect(workspaceMocks.updateGitRemoteToken).not.toHaveBeenCalled();
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
      } satisfies MessageDeliveryPlan,
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
