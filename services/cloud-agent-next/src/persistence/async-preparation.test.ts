import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { buildRestoreCommand } from '../kilo/devcontainer.js';
import type { Env } from '../types.js';
import type { PreparationInput } from './schemas.js';

type RestoreCommandOptions = Parameters<typeof buildRestoreCommand>[0];

const {
  ensureWrapperMock,
  buildRestoreCommandMock,
  bringUpDevContainerMock,
  detectDevContainerMock,
} = vi.hoisted(() => ({
  ensureWrapperMock: vi.fn(),
  buildRestoreCommandMock: vi.fn().mockReturnValue('mocked-restore-cmd'),
  bringUpDevContainerMock: vi.fn(),
  detectDevContainerMock: vi.fn().mockResolvedValue(null),
}));

const fakeSession = {
  exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
};

const fakeSandbox = {
  writeFile: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(() => fakeSandbox),
}));

vi.mock('../workspace.js', () => ({
  checkDiskAndCleanBeforeSetup: vi.fn().mockResolvedValue(undefined),
  setupWorkspace: vi.fn().mockResolvedValue({
    workspacePath: '/workspace/test-org/test-user/sessions/agent_test',
    sessionHome: '/home/agent_test',
  }),
  cloneGitHubRepo: vi.fn().mockResolvedValue(undefined),
  cloneGitRepo: vi.fn().mockResolvedValue(undefined),
  manageBranch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../session-service.js', () => ({
  determineBranchName: vi.fn(
    (sessionId: string, upstreamBranch?: string) => upstreamBranch ?? `session/${sessionId}`
  ),
  runSetupCommands: vi.fn().mockResolvedValue(undefined),
  writeAuthFile: vi.fn().mockResolvedValue(undefined),
  writeGlobalRules: vi.fn().mockResolvedValue(undefined),
  writeRuntimeSkills: vi.fn().mockResolvedValue(undefined),
  SessionService: class SessionService {
    buildContext = vi.fn((options: Record<string, unknown>) => ({
      ...options,
      branchName: `session/${String(options.sessionId)}`,
    }));

    getOrCreateSession = vi.fn().mockResolvedValue(fakeSession);
    buildRuntimeEnv = vi.fn().mockReturnValue({
      SESSION_HOME: '/home/agent_test',
      KILO_SESSION_INGEST_URL: 'https://ingest.example',
    });
  },
}));

vi.mock('../kilo/wrapper-client.js', () => ({
  WrapperClient: {
    ensureWrapper: ensureWrapperMock,
  },
}));

vi.mock('../kilo/devcontainer.js', () => ({
  buildRestoreCommand: buildRestoreCommandMock,
  bringUpDevContainer: bringUpDevContainerMock,
  detectDevContainer: detectDevContainerMock,
  KILO_CLI_VERSION: '1.0.0',
}));

vi.mock('../kilo/wrapper-manager.js', () => ({
  findWrapperContainerForSession: vi.fn().mockResolvedValue(null),
}));

import { runSetupCommands } from '../session-service.js';
import { cloneGitHubRepo, cloneGitRepo } from '../workspace.js';
import { executePreparationSteps } from './async-preparation.js';

const wrapperResult = {
  client: {},
  sessionId: 'ses_wrapper_123',
};

describe('executePreparationSteps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeSession.exec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    fakeSandbox.destroy.mockResolvedValue(undefined);
    ensureWrapperMock.mockResolvedValue(wrapperResult);
  });

  it('skips managed GitLab token resolution when caller already resolved it', async () => {
    const getGitLabToken = vi.fn();
    const env = {
      Sandbox: {} as Env['Sandbox'],
      SandboxSmall: {} as Env['SandboxSmall'],
      SandboxDIND: {} as Env['SandboxDIND'],
      GIT_TOKEN_SERVICE: {
        getTokenForRepo: vi.fn(),
        getGitLabToken,
      },
      PER_SESSION_SANDBOX_ORG_IDS: '',
      GITHUB_APP_SLUG: 'kilo-connect',
      GITHUB_APP_BOT_USER_ID: '12345',
    } as unknown as Env;
    const emitProgress = vi.fn();
    const input = {
      sessionId: 'agent_test',
      userId: 'test-user',
      orgId: 'test-org',
      authToken: 'kilo-token',
      gitUrl: 'https://gitlab.com/acme/repo.git',
      gitToken: 'fast-path-gitlab-token',
      platform: 'gitlab',
      gitlabTokenManaged: true,
      prompt: 'Fix bug',
      mode: 'code',
      model: 'kilo/test-model',
      autoInitiate: true,
    } satisfies PreparationInput;

    const result = await executePreparationSteps(input, env, emitProgress);

    expect(getGitLabToken).not.toHaveBeenCalled();
    expect(result?.resolvedGitToken).toBe('fast-path-gitlab-token');
    expect(result?.gitlabTokenManaged).toBe(true);
    expect(cloneGitRepo).toHaveBeenCalledWith(
      fakeSession,
      '/workspace/test-org/test-user/sessions/agent_test',
      'https://gitlab.com/acme/repo.git',
      'fast-path-gitlab-token',
      undefined,
      undefined
    );
  });

  it('resolves managed GitLab token when caller did not provide one', async () => {
    const getGitLabToken = vi.fn().mockResolvedValue({
      success: true,
      token: 'alarm-resolved-gitlab-token',
    });
    const env = {
      Sandbox: {} as Env['Sandbox'],
      SandboxSmall: {} as Env['SandboxSmall'],
      SandboxDIND: {} as Env['SandboxDIND'],
      GIT_TOKEN_SERVICE: {
        getTokenForRepo: vi.fn(),
        getGitLabToken,
      },
      PER_SESSION_SANDBOX_ORG_IDS: '',
      GITHUB_APP_SLUG: 'kilo-connect',
      GITHUB_APP_BOT_USER_ID: '12345',
    } as unknown as Env;
    const emitProgress = vi.fn();
    const input = {
      sessionId: 'agent_test',
      userId: 'test-user',
      orgId: 'test-org',
      authToken: 'kilo-token',
      gitUrl: 'https://gitlab.com/acme/repo.git',
      platform: 'gitlab',
      prompt: 'Fix bug',
      mode: 'code',
      model: 'kilo/test-model',
      autoInitiate: false,
    } satisfies PreparationInput;

    const result = await executePreparationSteps(input, env, emitProgress);

    expect(getGitLabToken).toHaveBeenCalledOnce();
    expect(result?.resolvedGitToken).toBe('alarm-resolved-gitlab-token');
    expect(result?.gitlabTokenManaged).toBe(true);
  });

  it('does not auto-detect a devcontainer unless the caller opts in', async () => {
    fakeSession.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('.devcontainer')) {
        throw new Error('devcontainer detection should not run');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const env = {
      Sandbox: {} as Env['Sandbox'],
      SandboxSmall: {} as Env['SandboxSmall'],
      SandboxDIND: {} as Env['SandboxDIND'],
      GIT_TOKEN_SERVICE: {
        getTokenForRepo: vi.fn(),
      },
      PER_SESSION_SANDBOX_ORG_IDS: '',
      GITHUB_APP_SLUG: 'kilo-connect',
      GITHUB_APP_BOT_USER_ID: '12345',
    } as unknown as Env;
    const emitProgress = vi.fn();
    const input = {
      sessionId: 'agent_test',
      userId: 'test-user',
      orgId: 'test-org',
      authToken: 'kilo-token',
      githubRepo: 'acme/repo',
      githubToken: 'github-token',
      prompt: 'Fix bug',
      mode: 'code',
      model: 'kilo/test-model',
      autoInitiate: true,
    } satisfies PreparationInput;

    const result = await executePreparationSteps(input, env, emitProgress);

    expect(result?.devcontainer).toBeUndefined();
  });

  it('returns the resolved GitHub App token used for preparation', async () => {
    const env = {
      Sandbox: {} as Env['Sandbox'],
      SandboxSmall: {} as Env['SandboxSmall'],
      SandboxDIND: {} as Env['SandboxDIND'],
      GIT_TOKEN_SERVICE: {
        getTokenForRepo: vi.fn().mockResolvedValue({
          success: true,
          token: 'resolved-github-token',
          installationId: 'installation-123',
          appType: 'standard',
          accountLogin: 'acme',
        }),
      },
      PER_SESSION_SANDBOX_ORG_IDS: '',
      GITHUB_APP_SLUG: 'kilo-connect',
      GITHUB_APP_BOT_USER_ID: '12345',
    } as unknown as Env;
    const emitProgress = vi.fn();
    const input = {
      sessionId: 'agent_test',
      userId: 'test-user',
      orgId: 'test-org',
      authToken: 'kilo-token',
      githubRepo: 'acme/repo',
      prompt: 'Fix bug',
      mode: 'code',
      model: 'kilo/test-model',
      autoInitiate: false,
    } satisfies PreparationInput;

    const result = await executePreparationSteps(input, env, emitProgress);

    expect(result?.resolvedGithubToken).toBe('resolved-github-token');
    expect(result?.resolvedInstallationId).toBe('installation-123');
    expect(result?.resolvedGithubAppType).toBe('standard');
    expect(cloneGitHubRepo).toHaveBeenCalledWith(
      fakeSession,
      '/workspace/test-org/test-user/sessions/agent_test',
      'acme/repo',
      'resolved-github-token',
      { GITHUB_APP_SLUG: 'kilo-connect', GITHUB_APP_BOT_USER_ID: '12345' },
      undefined
    );
  });

  it('forwards runtimeEnv to buildRestoreCommand when importing a kilo session', async () => {
    const env = {
      Sandbox: {} as Env['Sandbox'],
      SandboxSmall: {} as Env['SandboxSmall'],
      SandboxDIND: {} as Env['SandboxDIND'],
      GIT_TOKEN_SERVICE: {
        getTokenForRepo: vi.fn(),
      },
      PER_SESSION_SANDBOX_ORG_IDS: '',
      GITHUB_APP_SLUG: 'kilo-connect',
      GITHUB_APP_BOT_USER_ID: '12345',
    } as unknown as Env;
    const emitProgress = vi.fn();
    const input = {
      sessionId: 'agent_test',
      userId: 'test-user',
      orgId: 'test-org',
      authToken: 'kilo-token',
      githubRepo: 'acme/repo',
      githubToken: 'github-token',
      kiloSessionId: 'kilo-123',
      prompt: 'Fix bug',
      mode: 'code',
      model: 'kilo/test-model',
      autoInitiate: false,
    } satisfies PreparationInput;

    await executePreparationSteps(input, env, emitProgress);

    const restoreCommandCall = buildRestoreCommandMock.mock.calls[0] as
      | [RestoreCommandOptions]
      | undefined;
    expect(restoreCommandCall).toBeDefined();
    if (!restoreCommandCall) return;

    const [restoreOptions] = restoreCommandCall;
    expect(restoreOptions.kiloSessionId).toBe('kilo-123');
    expect(restoreOptions.runtimeEnv).toMatchObject({
      SESSION_HOME: '/home/agent_test',
      KILO_SESSION_INGEST_URL: 'https://ingest.example',
    });
  });

  it('runs profile setup commands through the devcontainer handle', async () => {
    const env = {
      Sandbox: {} as Env['Sandbox'],
      SandboxSmall: {} as Env['SandboxSmall'],
      SandboxDIND: {} as Env['SandboxDIND'],
      GIT_TOKEN_SERVICE: {
        getTokenForRepo: vi.fn(),
      },
      PER_SESSION_SANDBOX_ORG_IDS: '',
      GITHUB_APP_SLUG: 'kilo-connect',
      GITHUB_APP_BOT_USER_ID: '12345',
    } as unknown as Env;
    const emitProgress = vi.fn();
    const devcontainer = {
      containerId: 'container-id',
      innerWorkspaceFolder: '/workspaces/test',
      workspacePath: '/workspace/test-org/test-user/sessions/agent_test',
      agentSessionId: 'agent_test',
      overrideConfigPath: '/tmp/devcontainer-override-agent_test/devcontainer.json',
      teardown: vi.fn(),
    };
    detectDevContainerMock.mockResolvedValueOnce({
      configPath: '.devcontainer/devcontainer.json',
    });
    bringUpDevContainerMock.mockResolvedValueOnce(devcontainer);
    const input = {
      sessionId: 'agent_test',
      userId: 'test-user',
      orgId: 'test-org',
      authToken: 'kilo-token',
      githubRepo: 'acme/repo',
      githubToken: 'github-token',
      setupCommands: ['pnpm install'],
      prompt: 'Fix bug',
      mode: 'code',
      model: 'kilo/test-model',
      autoInitiate: true,
      devcontainer: true,
    } satisfies PreparationInput;

    await executePreparationSteps(input, env, emitProgress);

    expect(runSetupCommands).toHaveBeenCalledWith(
      fakeSession,
      expect.objectContaining({
        workspacePath: '/workspace/test-org/test-user/sessions/agent_test',
      }),
      ['pnpm install'],
      true,
      {
        devcontainer,
        dockerEnv: { DOCKER_HOST: 'unix:///var/run/docker.sock' },
        runtimeEnv: {
          SESSION_HOME: '/home/agent_test',
          KILO_SESSION_INGEST_URL: 'https://ingest.example',
        },
      }
    );
    expect(emitProgress).toHaveBeenCalledWith('setup_commands', 'Running setup commands…');
  });

  it('tears down the devcontainer when session import fails after bring-up', async () => {
    const env = {
      Sandbox: {} as Env['Sandbox'],
      SandboxSmall: {} as Env['SandboxSmall'],
      SandboxDIND: {} as Env['SandboxDIND'],
      GIT_TOKEN_SERVICE: {
        getTokenForRepo: vi.fn(),
      },
      PER_SESSION_SANDBOX_ORG_IDS: '',
      GITHUB_APP_SLUG: 'kilo-connect',
      GITHUB_APP_BOT_USER_ID: '12345',
    } as unknown as Env;
    const emitProgress = vi.fn();
    const teardown = vi.fn().mockResolvedValue(undefined);
    detectDevContainerMock.mockResolvedValueOnce({
      configPath: '.devcontainer/devcontainer.json',
    });
    bringUpDevContainerMock.mockResolvedValueOnce({
      containerId: 'container-id',
      innerWorkspaceFolder: '/workspaces/test',
      workspacePath: '/workspace/test-org/test-user/sessions/agent_test',
      agentSessionId: 'agent_test',
      overrideConfigPath: '/tmp/devcontainer-override-agent_test/devcontainer.json',
      teardown,
    });
    fakeSession.exec.mockImplementation(async (command: string) => {
      if (command === 'mocked-restore-cmd') {
        return { exitCode: 7, stdout: 'restore failed', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const input = {
      sessionId: 'agent_test',
      userId: 'test-user',
      orgId: 'test-org',
      authToken: 'kilo-token',
      githubRepo: 'acme/repo',
      githubToken: 'github-token',
      kiloSessionId: 'kilo-123',
      prompt: 'Fix bug',
      mode: 'code',
      model: 'kilo/test-model',
      autoInitiate: true,
      devcontainer: true,
    } satisfies PreparationInput;

    const result = await executePreparationSteps(input, env, emitProgress);

    expect(result).toBeUndefined();
    expect(emitProgress).toHaveBeenCalledWith('failed', 'Session import failed (exit 7)');
    expect(teardown).toHaveBeenCalledOnce();
  });

  it('destroys the sandbox when preparation hits a sandbox 500', async () => {
    const env = {
      Sandbox: {} as Env['Sandbox'],
      SandboxSmall: {} as Env['SandboxSmall'],
      GIT_TOKEN_SERVICE: {
        getTokenForRepo: vi.fn(),
      },
      PER_SESSION_SANDBOX_ORG_IDS: '',
      GITHUB_APP_SLUG: 'kilo-connect',
      GITHUB_APP_BOT_USER_ID: '12345',
    } as unknown as Env;
    const emitProgress = vi.fn();
    const input = {
      sessionId: 'agent_test',
      userId: 'test-user',
      orgId: 'test-org',
      authToken: 'kilo-token',
      githubRepo: 'acme/repo',
      githubToken: 'github-token',
      prompt: 'Fix bug',
      mode: 'code',
      model: 'kilo/test-model',
      autoInitiate: false,
    } satisfies PreparationInput;
    const error = new Error('HTTP error! status: 500');
    Object.assign(error, { name: 'SandboxError' });
    ensureWrapperMock.mockRejectedValueOnce(error);

    await expect(executePreparationSteps(input, env, emitProgress)).rejects.toBe(error);

    expect(fakeSandbox.destroy).toHaveBeenCalledOnce();
  });
});
