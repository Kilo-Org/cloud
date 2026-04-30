import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type { PreparationInput } from './schemas.js';

const fakeSession = {
  exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
};

const fakeSandbox = {
  writeFile: vi.fn().mockResolvedValue(undefined),
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
  SessionService: class SessionService {
    buildContext = vi.fn((options: Record<string, unknown>) => ({
      ...options,
      branchName: `session/${String(options.sessionId)}`,
    }));

    getOrCreateSession = vi.fn().mockResolvedValue(fakeSession);
  },
}));

vi.mock('../kilo/wrapper-client.js', () => ({
  WrapperClient: {
    ensureWrapper: vi.fn().mockResolvedValue({ sessionId: 'ses_wrapper_123' }),
  },
}));

import { cloneGitHubRepo, cloneGitRepo } from '../workspace.js';
import { executePreparationSteps } from './async-preparation.js';

describe('executePreparationSteps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips managed GitLab token resolution when caller already resolved it', async () => {
    const getGitLabToken = vi.fn();
    const env = {
      Sandbox: {} as Env['Sandbox'],
      SandboxSmall: {} as Env['SandboxSmall'],
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

  it('returns the resolved GitHub App token used for preparation', async () => {
    const env = {
      Sandbox: {} as Env['Sandbox'],
      SandboxSmall: {} as Env['SandboxSmall'],
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
});
