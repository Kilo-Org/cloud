import { dirname, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DevContainerModule from './kilo/devcontainer.js';
import type * as GitTokenServiceClientModule from './services/git-token-service-client.js';
import { validateWrapperDispatchTicket } from './auth.js';
import { deriveKiloSandboxTargets } from './kilo/kilo-targets.js';

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
  updateGitRemoteUrl: vi.fn().mockResolvedValue(undefined),
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
  issueCloudAgentGitHubSessionCapability: vi.fn(),
  issueCloudAgentGitLabSessionCapability: vi.fn(),
  resolveCloudAgentGitHubAuthForRepo: vi.fn(),
  resolveManagedBitbucketToken: vi.fn(),
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

vi.mock('./services/git-token-service-client.js', async importActual => ({
  ...(await importActual<typeof GitTokenServiceClientModule>()),
  ...tokenMocks,
}));
vi.mock('./kilo/devcontainer.js', async importActual => ({
  ...(await importActual<typeof DevContainerModule>()),
  bringUpDevContainer: devcontainerMocks.bringUpDevContainer,
  detectDevContainer: devcontainerMocks.detectDevContainer,
}));
vi.mock('./kilo/ports.js', () => portMocks);
vi.mock('./execution/attachment-prompt-parts.js', () => attachmentMocks);

import {
  SessionService,
  bitbucketReviewInputPath,
  buildCommandGuardBashPermissions,
  fetchSessionMetadata,
  getCommandGuardPolicy,
  resolveCommandGuardBashPermission,
  writeGlobalRules,
} from './session-service.js';
import type { CloudAgentSessionState, PersistenceEnv } from './persistence/types.js';
import { parseSessionMetadata } from './persistence/session-metadata.js';
import type { ExecutionSession, SandboxId, SandboxInstance, SessionId } from './types.js';
import type { FencedWrapperDispatchRequest } from './execution/types.js';
import { buildCloudAgentRules } from './shared/cloud-agent-rules.js';
import { PNPM_STORE_DIR, PNPM_STORE_ENV_VAR } from './shared/runtime-environment.js';
import {
  SandboxCapacityInspectionError,
  WorkspaceCapacityAdmissionRejectedError,
} from './workspace-errors.js';

type MockExecutionSession = ExecutionSession & {
  exec: ReturnType<typeof vi.fn>;
  gitCheckout: ReturnType<typeof vi.fn>;
};

describe('SessionService.buildRuntimeEnv', () => {
  it('forces a stable pnpm store while preserving the session home', () => {
    const service = new SessionService();
    const context = service.buildContext({
      sandboxId: 'usr-test',
      userId: 'user_test',
      sessionId: 'agent_test',
      envVars: {
        [PNPM_STORE_ENV_VAR]: '/home/old-session/.local/share/pnpm/store/v11',
      },
    });

    const runtimeEnv = service.buildRuntimeEnv({
      context,
      env: createEnv(),
      kiloCapability: 'kilo-token',
    });

    expect(runtimeEnv.HOME).toBe('/home/agent_test');
    expect(runtimeEnv.SESSION_HOME).toBe('/home/agent_test');
    expect(runtimeEnv[PNPM_STORE_ENV_VAR]).toBe(PNPM_STORE_DIR);
  });
});

describe('code-review command guard policy', () => {
  it('allows required review publication and remote refresh commands while denying repository mutation', () => {
    const policy = getCommandGuardPolicy('code-review');
    if (!policy) throw new Error('Expected code-review command guard policy');

    const bashPermissions = buildCommandGuardBashPermissions(policy);

    expect(bashPermissions['glab']).toBeUndefined();
    expect(bashPermissions['glab *']).toBeUndefined();
    expect(bashPermissions['gh']).toBeUndefined();
    expect(bashPermissions['gh *']).toBeUndefined();
    expect(bashPermissions['gh api']).toBeUndefined();
    expect(bashPermissions['gh api *']).toBeUndefined();

    for (const textInspectionCommand of ['awk', 'rg']) {
      expect(bashPermissions[textInspectionCommand]).toBe('allow');
      expect(bashPermissions[`${textInspectionCommand} *`]).toBe('allow');
    }

    expect(bashPermissions['glab mr diff']).toBe('allow');
    expect(bashPermissions['glab mr diff *']).toBe('allow');
    expect(bashPermissions['glab api --method POST *merge_requests/*/notes*']).toBe('allow');
    expect(bashPermissions['glab api --method PUT *merge_requests/*/notes/*']).toBe('allow');
    expect(bashPermissions['glab api --method POST *merge_requests/*/discussions*']).toBe('allow');

    expect(bashPermissions['gh pr diff']).toBe('allow');
    expect(bashPermissions['gh api repos/*/pulls/*/reviews']).toBe('allow');
    expect(bashPermissions['gh api repos/*/pulls/*/reviews *']).toBe('allow');
    expect(bashPermissions['gh api repos/*/pulls/*/comments']).toBe('allow');
    expect(bashPermissions['gh api repos/*/pulls/*/comments *']).toBe('allow');
    expect(bashPermissions['gh api repos/*/issues/*/comments']).toBe('allow');
    expect(bashPermissions['gh api repos/*/issues/*/comments *']).toBe('allow');
    expect(bashPermissions['gh api repos/*/issues/*/comments --input*']).toBe('allow');
    expect(bashPermissions['gh api repos/*/issues/comments/* -X PATCH*']).toBe('allow');
    expect(bashPermissions['gh api repos/*/pulls/*/reviews --input*']).toBe('allow');

    for (const readOnlyGhApiCommand of [
      'gh api repos/*/pulls/*/reviews',
      'gh api repos/*/pulls/*/comments',
      'gh api repos/*/issues/*/comments',
    ]) {
      for (const mutationFlag of ['--method*', '-X*', '-f*', '-F*', '--field*', '--raw-field*']) {
        const deniedCommand = `${readOnlyGhApiCommand} ${mutationFlag}`;
        expect(bashPermissions[deniedCommand]).toBe('deny');
        expect(bashPermissions[`${deniedCommand} *`]).toBe('deny');
      }
    }
    expect(bashPermissions['gh api repos/*/pulls/*/comments --input*']).toBe('deny');
    expect(bashPermissions['gh api repos/*/pulls/*/comments --input* *']).toBe('deny');

    for (const riskyAwkCommand of ['awk * -i*', 'awk * --in-place*', 'awk *system(*']) {
      expect(bashPermissions[riskyAwkCommand]).toBe('deny');
      expect(bashPermissions[`${riskyAwkCommand} *`]).toBe('deny');
    }

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

  it('matches only purpose-built Bitbucket review commands and exact scratch redirection', () => {
    const reviewId = '123e4567-e89b-12d3-a456-426614174023';
    const inputPath = bitbucketReviewInputPath(reviewId);
    const policy = getCommandGuardPolicy('code-review', 'bitbucket', reviewId);
    if (!policy) throw new Error('Expected Bitbucket code-review command guard policy');

    const permissions = buildCommandGuardBashPermissions(policy);
    for (const command of [
      'bb',
      'bb help',
      'bb --help',
      'bb -h',
      'bb pr current',
      'bb pr create --title "Add safer widgets"',
      'bb pr create --title "Add safer widgets" --description "Ready for review"',
      'bb pr create --title "Add safer widgets" --destination main',
      'bb pr view 42',
      'bb pr diff 42',
      'bb pr diff 42 --name-only',
      'bb comments list 42',
      'bb comments create 42 --input -',
      'bb comments create-batch 42 --input -',
      'bb comments update 42 31 --input -',
      `bb comments create 42 --input - < ${inputPath}`,
      `bb comments create-batch 42 --input - < ${inputPath}`,
      `bb comments update 42 31 --input - < ${inputPath}`,
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('allow');
    }

    for (const command of [
      'env',
      'printenv BITBUCKET_TOKEN',
      'echo $BITBUCKET_TOKEN',
      'cat /proc/self/environ',
      'python -c "print(1)"',
      'node -e "console.log(1)"',
      'pnpm exec tsx script.ts',
      'curl https://api.bitbucket.org/2.0/user',
      './repository-script',
      'git status --short',
      'git rev-parse HEAD',
      'git diff --no-ext-diff --no-textconv',
      'git show --no-ext-diff --no-textconv --format=fuller --stat HEAD',
      'git config --get-regexp alias',
      'git fetch origin',
      'git diff',
      'bb help extra',
      'bb --debug pr view 42',
      'bb pr current extra',
      'bb pr create',
      'bb pr create --description "Ready for review"',
      'bb pr create --title "Add safer widgets" < /tmp/other.json',
      'bb comments create 42 --input - --workspace other',
      'bb comments create-batch 42 --input - --workspace other',
      'bb comments update 42 31 --input - extra',
      'bb comments create 42 --input - < /tmp/other.json',
      'bb comments create-batch 42 --input - < /tmp/other.json',
      `bb comments update 42 $COMMENT_ID --input - < ${inputPath}`,
      `bb comments update 42 31 --input - < ${inputPath}; env`,
      `bb pr diff 42 | bb comments create 42 --input - < ${inputPath}`,
      'bb pr diff 42 --workspace other',
      'bb pr diff 42 extra --name-only',
      'bb pr diff 42 --name-only extra',
      'bb pr diff $BITBUCKET_TOKEN --name-only',
      'bb pr view 42 && printenv',
      'bb pr view 42 extra',
      'bb comments create 42 43 --input -',
      'bb comments create-batch 42 43 --input -',
    ]) {
      expect(resolveCommandGuardBashPermission(permissions, command), command).toBe('deny');
    }
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
    Sandbox: {
      idFromName: vi.fn(() => 'sandbox-do-id' as unknown as DurableObjectId),
    } as unknown as PersistenceEnv['Sandbox'],
    SandboxContainment: {
      idFromName: vi.fn(() => 'containment-sandbox-do-id' as unknown as DurableObjectId),
    } as unknown as PersistenceEnv['SandboxContainment'],
    SandboxSmall: {
      idFromName: vi.fn(() => 'small-sandbox-do-id' as unknown as DurableObjectId),
    } as unknown as PersistenceEnv['SandboxSmall'],
    SandboxSmallContainment: {
      idFromName: vi.fn(() => 'containment-small-sandbox-do-id' as unknown as DurableObjectId),
    } as unknown as PersistenceEnv['SandboxSmallContainment'],
    SandboxDIND: {
      idFromName: vi.fn(() => 'dind-sandbox-do-id' as unknown as DurableObjectId),
    } as unknown as PersistenceEnv['SandboxDIND'],
    SandboxCodeReview: {
      idFromName: vi.fn(() => 'code-review-sandbox-do-id' as unknown as DurableObjectId),
    } as unknown as PersistenceEnv['SandboxCodeReview'],
    SandboxCodeReviewContainment: {
      idFromName: vi.fn(
        () => 'containment-code-review-sandbox-do-id' as unknown as DurableObjectId
      ),
    } as unknown as PersistenceEnv['SandboxCodeReviewContainment'],
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
      issueGitHubSessionCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: 'kgh2.default',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
      }),
      redeemGitHubSessionCapability: vi.fn(),
      getGitLabToken: vi.fn().mockResolvedValue({
        success: true,
        token: 'resolved-gitlab-token',
        instanceUrl: 'https://gitlab.com',
        glabIsOAuth2: true,
      }),
      issueGitLabSessionCapability: vi.fn(),
      redeemGitLabSessionCapability: vi.fn(),
      issueKiloSessionCapability: vi.fn().mockResolvedValue({
        success: true,
        capability: 'kka1.default',
      }),
      redeemKiloSessionCapability: vi.fn(),
    },
    MANAGED_SCM_CONTAINMENT_ORG_IDS: '*',
    NOTIFICATIONS: {} as unknown as PersistenceEnv['NOTIFICATIONS'],
  } satisfies PersistenceEnv;
}

function createMetadata(overrides: Record<string, unknown> = {}): CloudAgentSessionState {
  const metadata = parseSessionMetadata({
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
  const managedScmContainment =
    overrides.managedScmContainment === true ||
    (overrides.managedScmContainment !== false &&
      overrides.platform === 'github' &&
      !(typeof overrides.sandboxId === 'string' && overrides.sandboxId.startsWith('dind-')));
  return {
    ...metadata,
    workspace: { ...metadata.workspace, managedScmContainment },
  };
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
    workspace: { managedScmContainment: true },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function createBitbucketMetadata(
  isCodeReview: boolean,
  orgId: string | null = '123e4567-e89b-12d3-a456-426614174030'
): CloudAgentSessionState {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'agent_test',
      userId: 'user_test',
      ...(orgId ? { orgId } : {}),
      createdOnPlatform: isCodeReview ? 'code-review' : 'cloud-agent-web',
    },
    auth: {
      kilocodeToken: 'kilo-token',
      kiloSessionId: 'kilo-session',
    },
    repository: {
      type: 'bitbucket',
      url: 'https://bitbucket.org/acme-team/widgets.git',
      platform: 'bitbucket',
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      ...(isCodeReview ? { bitbucketIntegrationId: '123e4567-e89b-12d3-a456-426614174022' } : {}),
    },
    ...(isCodeReview
      ? {
          callback: {
            target: {
              url: 'https://kilo.example/api/internal/code-review-status/123e4567-e89b-12d3-a456-426614174023?attemptId=attempt-1',
            },
          },
        }
      : {}),
    profile: {
      envVars: {
        BITBUCKET_TOKEN: 'user-token',
        KILO_BITBUCKET_INTEGRATION_ID: 'user-integration',
        KILO_BITBUCKET_WORKSPACE_SLUG: 'user-workspace',
        KILO_BITBUCKET_WORKSPACE_UUID: '{00000000-0000-4000-8000-000000000000}',
        KILO_BITBUCKET_REPOSITORY_SLUG: 'user-repository',
        KILO_BITBUCKET_REPOSITORY_UUID: '{00000000-0000-4000-8000-000000000001}',
        PATH: '/user/bin',
      },
    },
    agent: { mode: 'code', model: 'kilo/test-model' },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

const BITBUCKET_SANDBOX_ID = 'ses-bitbucket' as SandboxId;

describe('SessionService.resolveWorkspaceTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tokenMocks.resolveManagedBitbucketToken.mockResolvedValue({
      success: true,
      token: 'opaque-workspace-token',
    });
  });

  it('fails closed for replayed Bitbucket metadata without an organization', async () => {
    await expect(
      new SessionService().resolveWorkspaceTokens(
        createEnv(),
        createBitbucketMetadata(false, null),
        BITBUCKET_SANDBOX_ID
      )
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      retryable: false,
      message: 'Bitbucket repositories require an organization',
    });
    expect(tokenMocks.resolveManagedBitbucketToken).not.toHaveBeenCalled();
  });

  it('re-resolves an organization token with exact persisted repository identity', async () => {
    const orgId = '123e4567-e89b-12d3-a456-426614174030';

    await expect(
      new SessionService().resolveWorkspaceTokens(
        createEnv(),
        createBitbucketMetadata(false, orgId),
        BITBUCKET_SANDBOX_ID
      )
    ).resolves.toMatchObject({
      gitToken: 'opaque-workspace-token',
      bitbucketTokenManaged: true,
    });
    expect(tokenMocks.resolveManagedBitbucketToken).toHaveBeenCalledWith(expect.any(Object), {
      userId: 'user_test',
      orgId,
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      repositoryUrl: 'https://bitbucket.org/acme-team/widgets.git',
    });
  });

  it('keeps temporary runtime token resolution failures retryable', async () => {
    tokenMocks.resolveManagedBitbucketToken.mockResolvedValue({
      success: false,
      reason: 'temporarily_unavailable',
    });

    await expect(
      new SessionService().resolveWorkspaceTokens(
        createEnv(),
        createBitbucketMetadata(false),
        BITBUCKET_SANDBOX_ID
      )
    ).rejects.toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      retryable: true,
      message: 'Bitbucket repository authorization failed (temporarily_unavailable).',
    });
  });

  it('keeps an unavailable token-service binding retryable during replay', async () => {
    tokenMocks.resolveManagedBitbucketToken.mockResolvedValue({
      success: false,
      reason: 'service_not_configured',
    });

    await expect(
      new SessionService().resolveWorkspaceTokens(
        createEnv(),
        createBitbucketMetadata(false),
        BITBUCKET_SANDBOX_ID
      )
    ).rejects.toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      retryable: true,
      message: 'Bitbucket repository authorization failed (service_not_configured).',
    });
  });
});

describe('writeGlobalRules', () => {
  it('writes the shared Cloud Agent rules for the session', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const sandbox = createSandbox(createSession(), false, writeFile);

    await writeGlobalRules(sandbox, '/home/agent_test', 'agent_test');

    expect(writeFile).toHaveBeenCalledWith(
      '/home/agent_test/.kilocode/rules/cloud-agent.md',
      buildCloudAgentRules('agent_test')
    );
  });
});

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
    workspaceMocks.updateGitRemoteUrl.mockResolvedValue(undefined);
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
    tokenMocks.issueCloudAgentGitHubSessionCapability.mockResolvedValue({
      success: true,
      value: {
        capability: 'kgh2.default',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
      },
    });
    tokenMocks.issueCloudAgentGitLabSessionCapability.mockResolvedValue({
      success: true,
      value: {
        capability: 'kgl2.default',
        instanceOrigin: 'https://gitlab.com',
        instanceHost: 'gitlab.com',
        projectPath: 'acme/repo',
        integrationId: 'integration_1',
        authType: 'oauth',
        identity: { accountId: '42', accountLogin: 'octocat' },
        glabIsOAuth2: true,
      },
    });
    tokenMocks.resolveManagedGitLabToken.mockResolvedValue({
      success: true,
      token: 'resolved-gitlab-token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: true,
    });
    tokenMocks.resolveManagedBitbucketToken.mockResolvedValue({
      success: true,
      token: 'fresh-bitbucket-token',
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
      sandboxId: 'ses-abcdef',
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
    expect(tokenMocks.resolveManagedGitLabToken).toHaveBeenCalled();
    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).not.toHaveBeenCalled();
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
      sandboxId: 'ses-abcdef',
      sessionHome: '/home/agent_test',
      branchName: 'main',
      kiloSessionId: 'kilo-session',
      gitToken: 'resolved-gitlab-token',
      gitlabTokenManaged: true,
    });
  });

  it('removes the managed Bitbucket token from origin after cold review branch setup', async () => {
    const session = createSession(false);
    const sandbox = createSandbox(session);
    const metadata = createBitbucketMetadata(true);

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'usr-abcdef',
      orgId: '123e4567-e89b-12d3-a456-426614174030',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    const workspacePath = '/workspace/user/sessions/agent_test';
    expect(workspaceMocks.updateGitRemoteUrl).toHaveBeenCalledWith(
      session,
      workspacePath,
      'https://bitbucket.org/acme-team/widgets.git'
    );
    expect(workspaceMocks.updateGitRemoteToken).not.toHaveBeenCalled();
    const branchCallIndex = session.exec.mock.calls.findIndex(
      ([command]) => typeof command === 'string' && command.includes('git checkout -b')
    );
    expect(branchCallIndex).toBeGreaterThanOrEqual(0);
    expect(session.exec.mock.invocationCallOrder[branchCallIndex]).toBeLessThan(
      workspaceMocks.updateGitRemoteUrl.mock.invocationCallOrder[0] ?? 0
    );
    const restoreCallIndex = session.exec.mock.calls.findIndex(
      ([command]) => typeof command === 'string' && command.includes('kilo-restore-session.js')
    );
    expect(restoreCallIndex).toBeGreaterThanOrEqual(0);
    expect(workspaceMocks.updateGitRemoteUrl.mock.invocationCallOrder[0]).toBeLessThan(
      session.exec.mock.invocationCallOrder[restoreCallIndex] ?? 0
    );
  });

  it('writes the opaque Kilo capability to the sandbox auth file, never the raw token', async () => {
    const session = createSession(false);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const sandbox = createSandbox(session, false, writeFile);
    const metadata = createMetadata({ managedScmContainment: true });
    const env = createEnv();
    const issueKiloSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      capability: 'kka1.workspace-issued',
    });
    if (!env.GIT_TOKEN_SERVICE) throw new Error('Expected GIT_TOKEN_SERVICE in test env');
    env.GIT_TOKEN_SERVICE.issueKiloSessionCapability = issueKiloSessionCapability;

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'ses-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env,
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(issueKiloSessionCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        userToken: 'kilo-token',
        outboundContainerId: 'containment-small-sandbox-do-id',
      })
    );
    const authFileCall = writeFile.mock.calls.find(
      ([path]) => path === '/home/agent_test/.local/share/kilo/auth.json'
    );
    expect(authFileCall).toBeDefined();
    const authFileContent = authFileCall?.[1] as string;
    expect(authFileContent).toContain('kka1.workspace-issued');
    expect(authFileContent).not.toContain('kilo-token');
    for (const [, content] of writeFile.mock.calls) {
      if (typeof content === 'string') {
        expect(content).not.toContain('kilo-token');
      }
    }
  });

  it('binds the restore-token file to the opaque Kilo capability for a standard devcontainer session, never the raw token', async () => {
    const session = createSession(false);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const sandbox = createSandbox(session, false, writeFile);
    const metadata = {
      ...createMetadata({ preparedAt: 1 }),
      workspace: {
        sandboxId: 'ses-abcdef' as const,
        devcontainerRequested: true,
        managedScmContainment: true,
      },
    } satisfies CloudAgentSessionState;
    const env = createEnv();
    const issueKiloSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      capability: 'kka1.restore-issued',
    });
    if (!env.GIT_TOKEN_SERVICE) throw new Error('Expected GIT_TOKEN_SERVICE in test env');
    env.GIT_TOKEN_SERVICE.issueKiloSessionCapability = issueKiloSessionCapability;
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
      sandboxId: 'ses-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env,
      metadata,
      kilocodeModel: 'test-model',
    });

    const restoreTokenCall = writeFile.mock.calls.find(
      ([path]) => path === '/home/agent_test/.local/share/kilo/session-restore-token'
    );
    expect(restoreTokenCall).toBeDefined();
    expect(restoreTokenCall?.[1]).toBe('kka1.restore-issued');
    const restoreCall = session.exec.mock.calls.find(
      ([command]) => typeof command === 'string' && command.includes('kilo-restore-session.js')
    );
    expect(restoreCall?.[0]).not.toContain('kilo-token');
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
        sandboxId: 'ses-abcdef' as const,
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
        sandboxId: 'ses-abcdef',
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
        sandboxId: 'ses-abcdef',
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

  it('replaces a warm Bitbucket review origin with the credential-free canonical URL', async () => {
    const session = createSession(true);
    const sandbox = createSandbox(session, true);
    const metadata = createBitbucketMetadata(true);

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'usr-abcdef',
      orgId: '123e4567-e89b-12d3-a456-426614174030',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(workspaceMocks.cloneGitRepo).not.toHaveBeenCalled();
    expect(workspaceMocks.updateGitRemoteToken).not.toHaveBeenCalled();
    expect(workspaceMocks.updateGitRemoteUrl).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://bitbucket.org/acme-team/widgets.git'
    );
  });

  it('refreshes prepared GitHub workspace metadata with a managed capability', async () => {
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
      sandboxId: 'ses-abcdef',
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'ses-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(workspaceMocks.cloneGitHubRepo).not.toHaveBeenCalled();
    expect(tokenMocks.issueCloudAgentGitHubSessionCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        GIT_TOKEN_SERVICE: expect.any(Object),
      }),
      {
        githubRepo: 'acme/repo',
        userId: 'user_test',
        outboundContainerId: 'containment-small-sandbox-do-id',
        orgId: undefined,
        allowUserAuthorization: false,
      }
    );
    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
    expect(workspaceMocks.updateGitRemoteToken).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://github.com/acme/repo.git',
      'kgh2.default'
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
      sandboxId: 'ses-abcdef',
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

  it('refreshes a prepared warm GitHub remote with a managed capability', async () => {
    const session = createSession(true);
    const sandbox = createSandbox(session, true);
    const getTokenMock = vi.fn().mockResolvedValue('legacy-installation-token');
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
      sandboxId: 'ses-abcdef',
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'ses-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env,
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(workspaceMocks.cloneGitHubRepo).not.toHaveBeenCalled();
    expect(getTokenMock).not.toHaveBeenCalled();
    expect(tokenMocks.issueCloudAgentGitHubSessionCapability).toHaveBeenCalled();
    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
    expect(workspaceMocks.updateGitRemoteToken).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://github.com/acme/repo.git',
      'kgh2.default'
    );
  });

  it('refreshes the warm fast path GitLab remote with direct managed authentication', async () => {
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
      sandboxId: 'ses-abcdef',
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'ses-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(workspaceMocks.cloneGitRepo).not.toHaveBeenCalled();
    expect(tokenMocks.resolveManagedGitLabToken).toHaveBeenCalled();
    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).not.toHaveBeenCalled();
    expect(workspaceMocks.updateGitRemoteToken).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://gitlab.com/acme/repo.git',
      'resolved-gitlab-token',
      'gitlab'
    );
  });

  it('refreshes a warm GitLab code-review remote with a contained project capability', async () => {
    const session = createSession(true);
    const sandbox = createSandbox(session, true);
    tokenMocks.issueCloudAgentGitLabSessionCapability.mockResolvedValueOnce({
      success: true,
      value: {
        capability: 'kgl2.project',
        gitUrl: 'https://gitlab.com/acme/repo.git',
        instanceOrigin: 'https://gitlab.com',
        instanceHost: 'gitlab.com',
        projectPath: 'acme/repo',
        integrationId: 'project_token_1',
        authType: 'pat',
        identity: { accountId: null, accountLogin: null },
        glabIsOAuth2: false,
      },
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'ses-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata: createGitLabCodeReviewMetadata(),
      kilocodeModel: 'test-model',
    });

    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalledWith(
      expect.any(Object),
      {
        gitUrl: 'https://gitlab.com/acme/repo.git',
        userId: 'user_test',
        outboundContainerId: 'containment-small-sandbox-do-id',
        orgId: undefined,
        createdOnPlatform: 'code-review',
      }
    );
    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    expect(workspaceMocks.updateGitRemoteToken).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://gitlab.com/acme/repo.git',
      'kgl2.project',
      'gitlab'
    );
  });

  it('refreshes a prepared warm GitHub remote through managed capability authentication', async () => {
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
      sandboxId: 'ses-abcdef',
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'ses-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(tokenMocks.issueCloudAgentGitHubSessionCapability).toHaveBeenCalled();
    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
    expect(workspaceMocks.updateGitRemoteToken).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'https://github.com/acme/repo.git',
      'kgh2.default'
    );
  });

  it('uses direct GitHub authentication for requested devcontainer preparation', async () => {
    const session = createSession(false);
    const sandbox = createSandbox(session);
    const metadata = {
      ...createMetadata({
        githubRepo: 'acme/repo',
        gitUrl: undefined,
        gitToken: undefined,
        platform: 'github',
      }),
      workspace: {
        sandboxId: 'dind-abcdef' as const,
        devcontainerRequested: true,
      },
    } satisfies CloudAgentSessionState;
    devcontainerMocks.detectDevContainer.mockResolvedValue({
      configPath: '.devcontainer/devcontainer.json',
    });
    devcontainerMocks.bringUpDevContainer.mockResolvedValue({
      containerId: 'container-dev',
      innerWorkspaceFolder: '/workspaces/repo',
      workspacePath: '/workspace/user/sessions/agent_test',
      agentSessionId: 'agent_test',
      overrideConfigPath: '/tmp/devcontainer-override-agent_test/devcontainer.json',
      teardown: vi.fn().mockResolvedValue(undefined),
    });

    await new SessionService().prepareWorkspace({
      sandbox,
      sandboxId: 'dind-abcdef',
      userId: 'user_test',
      sessionId: 'agent_test' as SessionId,
      env: createEnv(),
      metadata,
      kilocodeModel: 'test-model',
    });

    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).toHaveBeenCalled();
    expect(tokenMocks.issueCloudAgentGitHubSessionCapability).not.toHaveBeenCalled();
    expect(workspaceMocks.cloneGitHubRepo).toHaveBeenCalledWith(
      session,
      '/workspace/user/sessions/agent_test',
      'acme/repo',
      'resolved-gh-token',
      { name: 'kiloconnect[bot]', email: 'bot@example.com' },
      undefined
    );
  });

  it('fails closed without a raw GitLab token fallback when prepared workspace capability issuance fails', async () => {
    tokenMocks.issueCloudAgentGitLabSessionCapability.mockResolvedValueOnce({
      success: false,
      reason: 'rpc_error',
    });

    await expect(
      new SessionService().prepareWorkspace({
        sandbox: createSandbox(createSession()),
        sandboxId: 'ses-abcdef',
        userId: 'user_test',
        sessionId: 'agent_test' as SessionId,
        env: createEnv(),
        metadata: createMetadata({ managedScmContainment: true }),
      })
    ).rejects.toThrow('GitLab token lookup failed (rpc_error)');

    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
  });

  it('fails closed without raw GitHub auth fallback when prepared workspace capability issuance fails', async () => {
    tokenMocks.issueCloudAgentGitHubSessionCapability.mockResolvedValueOnce({
      success: false,
      error: { reason: 'rpc_error', message: 'RPC unavailable' },
    });

    await expect(
      new SessionService().prepareWorkspace({
        sandbox: createSandbox(createSession()),
        sandboxId: 'ses-abcdef',
        userId: 'user_test',
        sessionId: 'agent_test' as SessionId,
        env: createEnv(),
        metadata: createMetadata({
          githubRepo: 'acme/repo',
          gitUrl: undefined,
          gitToken: undefined,
          platform: 'github',
        }),
      })
    ).rejects.toThrow('GitHub token or active app installation required');

    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
  });

  it('throws when required metadata is missing', async () => {
    const metadata = createMetadata({ kilocodeToken: undefined });

    await expect(
      new SessionService().prepareWorkspace({
        sandbox: createSandbox(createSession()),
        sandboxId: 'ses-abcdef',
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
    tokenMocks.issueCloudAgentGitHubSessionCapability.mockResolvedValue({
      success: true,
      value: {
        capability: 'kgh2.default',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
      },
    });
    tokenMocks.issueCloudAgentGitLabSessionCapability.mockResolvedValue({
      success: true,
      value: {
        capability: 'kgl2.default',
        instanceOrigin: 'https://gitlab.com',
        instanceHost: 'gitlab.com',
        projectPath: 'acme/repo',
        integrationId: 'integration_1',
        authType: 'oauth',
        identity: { accountId: '42', accountLogin: 'octocat' },
        glabIsOAuth2: true,
      },
    });
    tokenMocks.resolveManagedGitLabToken.mockResolvedValue({
      success: true,
      token: 'resolved-gitlab-token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: true,
    });
    tokenMocks.resolveManagedBitbucketToken.mockResolvedValue({
      success: true,
      token: 'fresh-bitbucket-token',
    });
    devcontainerMocks.detectDevContainer.mockResolvedValue(null);
    devcontainerMocks.bringUpDevContainer.mockReset();
    portMocks.randomPort.mockReturnValue(4173);
    attachmentMocks.buildSignedPromptAttachments.mockResolvedValue([]);
  });

  async function buildPromptWrapperRequests(
    metadata: CloudAgentSessionState,
    customizeEnv?: (env: PersistenceEnv) => void
  ) {
    const service = new SessionService();
    const env = createEnv();
    env.WORKER_URL = 'https://cloud-agent.example.com';
    customizeEnv?.(env);

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
          sandboxId: metadata.workspace?.sandboxId ?? 'ses-abcdef',
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

  it('uses a managed GitLab capability when containment is explicitly set for a standard sandbox', async () => {
    const result = await buildPromptWrapperRequests({
      ...createMetadata(),
      workspace: { sandboxId: 'ses-abcdef', managedScmContainment: true },
    } satisfies CloudAgentSessionState);

    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalledWith(
      expect.any(Object),
      {
        gitUrl: 'https://gitlab.com/acme/repo.git',
        userId: 'user_test',
        outboundContainerId: 'containment-small-sandbox-do-id',
        orgId: undefined,
        createdOnPlatform: undefined,
      }
    );
    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({ token: 'kgl2.default' });
  });

  it('uses a managed GitLab capability when containment is explicitly set for shared sandboxes', async () => {
    const result = await buildPromptWrapperRequests({
      ...createMetadata(),
      workspace: { sandboxId: 'usr-abcdef', managedScmContainment: true },
    } satisfies CloudAgentSessionState);

    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ outboundContainerId: 'containment-sandbox-do-id' })
    );
    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({ token: 'kgl2.default' });
  });

  it('preserves a self-managed GitLab instance subpath for direct credentials', async () => {
    tokenMocks.resolveManagedGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'resolved-gitlab-token',
      instanceUrl: 'https://gitlab.example.com:8443/gitlab',
      glabIsOAuth2: true,
    });

    const result = await buildPromptWrapperRequests(
      createMetadata({
        gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/repo.git',
        managedScmContainment: false,
      })
    );

    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.example.com:8443');
    expect(result.readyRequest.materialized.env.GITLAB_SUBFOLDER).toBe('gitlab');
  });

  it('uses a managed GitHub capability for every standard sandbox', async () => {
    const result = await buildPromptWrapperRequests({
      ...createMetadata({
        githubRepo: 'acme/repo',
        gitUrl: undefined,
        gitToken: undefined,
        platform: 'github',
        createdOnPlatform: 'cloud-agent-web',
      }),
      workspace: { sandboxId: 'ses-abcdef', managedScmContainment: true },
    } satisfies CloudAgentSessionState);

    expect(tokenMocks.issueCloudAgentGitHubSessionCapability).toHaveBeenCalledWith(
      expect.any(Object),
      {
        githubRepo: 'acme/repo',
        userId: 'user_test',
        outboundContainerId: 'containment-small-sandbox-do-id',
        orgId: undefined,
        allowUserAuthorization: true,
      }
    );
    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({ token: 'kgh2.default' });
  });

  it('uses a managed GitHub capability for shared standard sandboxes', async () => {
    const result = await buildPromptWrapperRequests({
      ...createMetadata({
        githubRepo: 'acme/repo',
        gitUrl: undefined,
        gitToken: undefined,
        platform: 'github',
        createdOnPlatform: 'cloud-agent-web',
      }),
      workspace: { sandboxId: 'usr-abcdef', managedScmContainment: true },
    } satisfies CloudAgentSessionState);

    expect(tokenMocks.issueCloudAgentGitHubSessionCapability).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ outboundContainerId: 'containment-sandbox-do-id' })
    );
    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({ token: 'kgh2.default' });
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
          sandboxId: metadata.workspace?.sandboxId ?? 'ses-abcdef',
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

  it('uses direct GitLab authentication for a DIND sandbox', async () => {
    const result = await buildPromptWrapperRequests({
      ...createMetadata(),
      workspace: { sandboxId: 'dind-abcdef' },
    } satisfies CloudAgentSessionState);

    expect(tokenMocks.resolveManagedGitLabToken).toHaveBeenCalled();
    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({ token: 'resolved-gitlab-token' });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('resolved-gitlab-token');
  });

  it('derives a managed capability from the SandboxSmallContainment container ID', async () => {
    await buildPromptWrapperRequests({
      ...createMetadata(),
      workspace: { sandboxId: 'ses-abcdef', managedScmContainment: true },
    } satisfies CloudAgentSessionState);

    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ outboundContainerId: 'containment-small-sandbox-do-id' })
    );
  });

  it('derives a managed capability from the shared SandboxContainment container ID', async () => {
    await buildPromptWrapperRequests({
      ...createMetadata(),
      workspace: { sandboxId: 'usr-abcdef', managedScmContainment: true },
    } satisfies CloudAgentSessionState);

    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ outboundContainerId: 'containment-sandbox-do-id' })
    );
  });

  it('uses direct GitLab authentication in DIND devcontainer wrapper readiness', async () => {
    const result = await buildPromptWrapperRequests({
      ...createMetadata(),
      workspace: {
        sandboxId: 'dind-abcdef',
        devcontainerRequested: true,
      },
    } satisfies CloudAgentSessionState);

    expect(tokenMocks.resolveManagedGitLabToken).toHaveBeenCalled();
    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'git',
      token: 'resolved-gitlab-token',
      platform: 'gitlab',
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('resolved-gitlab-token');
  });

  it('fails closed without raw GitLab fallback when managed capability issuance fails', async () => {
    tokenMocks.issueCloudAgentGitLabSessionCapability.mockResolvedValueOnce({
      success: false,
      reason: 'rpc_error',
    });

    await expect(
      buildPromptWrapperRequests(createMetadata({ managedScmContainment: true }))
    ).rejects.toThrow('GitLab token lookup failed (rpc_error)');

    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
  });

  it('fails closed without raw GitHub fallback when managed capability issuance fails', async () => {
    tokenMocks.issueCloudAgentGitHubSessionCapability.mockResolvedValueOnce({
      success: false,
      error: { reason: 'rpc_error', message: 'RPC unavailable' },
    });

    await expect(
      buildPromptWrapperRequests(
        createMetadata({
          githubRepo: 'acme/repo',
          gitUrl: undefined,
          gitToken: undefined,
          platform: 'github',
        })
      )
    ).rejects.toThrow('GitHub token or active app installation required');

    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
  });

  it('uses a managed GitLab capability for an explicitly contained prepared wrapper workspace', async () => {
    const result = await buildPromptWrapperRequests(
      createMetadata({ preparedAt: 1, managedScmContainment: true })
    );

    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalled();
    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({
      token: 'kgl2.default',
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('kgl2.default');
    expect(JSON.stringify(result.readyRequest)).not.toContain('resolved-gitlab-token');
  });

  it('uses direct GitLab authentication for a resumed DIND session', async () => {
    const result = await buildPromptWrapperRequests({
      ...createMetadata({ preparedAt: 1 }),
      workspace: { sandboxId: 'dind-abcdef' },
      devcontainer: {
        workspacePath: '/workspace/user/sessions/agent_test',
        innerWorkspaceFolder: '/workspaces/repo',
        wrapperPort: 4173,
        configPath: '.devcontainer/devcontainer.json',
      },
    } satisfies CloudAgentSessionState);

    expect(tokenMocks.resolveManagedGitLabToken).toHaveBeenCalled();
    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({ token: 'resolved-gitlab-token' });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('resolved-gitlab-token');
  });

  it('uses direct GitHub authentication in DIND devcontainer wrapper readiness', async () => {
    const result = await buildPromptWrapperRequests({
      ...createMetadata({
        githubRepo: 'acme/repo',
        gitUrl: undefined,
        gitToken: undefined,
        platform: 'github',
      }),
      workspace: {
        sandboxId: 'dind-abcdef',
        devcontainerRequested: true,
      },
    } satisfies CloudAgentSessionState);

    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).toHaveBeenCalled();
    expect(tokenMocks.issueCloudAgentGitHubSessionCapability).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'github',
      token: 'resolved-gh-token',
    });
    expect(result.readyRequest.materialized.env.GH_TOKEN).toBe('resolved-gh-token');
  });

  it('uses direct GitHub authentication for a resumed DIND session with resolved devcontainer metadata', async () => {
    const devcontainer = {
      workspacePath: '/workspace/user/sessions/agent_test',
      innerWorkspaceFolder: '/workspaces/repo',
      wrapperPort: 4173,
      configPath: '.devcontainer/devcontainer.json',
    };
    const result = await buildPromptWrapperRequests({
      ...createMetadata({
        preparedAt: 1,
        githubRepo: 'acme/repo',
        gitUrl: undefined,
        gitToken: undefined,
        platform: 'github',
      }),
      workspace: { sandboxId: 'dind-abcdef' },
      devcontainer,
    } satisfies CloudAgentSessionState);

    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).toHaveBeenCalled();
    expect(tokenMocks.issueCloudAgentGitHubSessionCapability).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'github',
      token: 'resolved-gh-token',
    });
    expect(result.readyRequest.materialized.env.GH_TOKEN).toBe('resolved-gh-token');
    expect(result.readyRequest.devcontainer).toEqual({ requested: true, resolved: devcontainer });
  });

  it('materializes workspace setup and prompt delivery behind an opaque Kilo capability, never the raw tokens', async () => {
    const service = new SessionService();
    const env = createEnv();
    env.WORKER_URL = 'https://cloud-agent.example.com';
    const issueKiloSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      capability: 'kka1.issued',
    });
    if (!env.GIT_TOKEN_SERVICE) throw new Error('Expected GIT_TOKEN_SERVICE in test env');
    env.GIT_TOKEN_SERVICE.issueKiloSessionCapability = issueKiloSessionCapability;
    const metadata = createMetadata({
      setupCommands: ['pnpm install'],
      envVars: { PUBLIC_VALUE: 'visible' },
      upstreamBranch: 'main',
      managedScmContainment: true,
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
          sandboxId: 'ses-abcdef',
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
      sandboxId: 'ses-abcdef',
      sessionHome: '/home/agent_test',
      branchName: 'main',
      kiloSessionId: 'kilo-session',
      gitToken: 'kgl2.default',
      gitlabTokenManaged: true,
    });
    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalled();
    expect(result.readyRequest).toMatchObject({
      agentSessionId: 'agent_test',
      userId: 'user_test',
      sandboxId: 'ses-abcdef',
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
        token: 'kgl2.default',
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
    expect(result.readyRequest.materialized.env.KILOCODE_TOKEN).toBe('kka1.issued');
    expect(JSON.parse(result.readyRequest.materialized.env.KILO_AUTH_CONTENT)).toEqual({
      kilo: { type: 'api', key: 'kka1.issued' },
    });
    expect(issueKiloSessionCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_test',
        cloudAgentSessionId: 'agent_test',
        kiloSessionId: 'kilo-session',
        userToken: 'kilo-token',
        outboundContainerId: 'containment-small-sandbox-do-id',
      })
    );
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('kgl2.default');
    expect(JSON.stringify(result.readyRequest)).not.toContain('resolved-gitlab-token');
    expect(JSON.stringify(result.readyRequest)).not.toContain('kilo-token');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.com');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBe('true');
    expect(result.readyRequest.session.workerAuthToken).not.toBe('kilo-token');
    const ticketResult = await validateWrapperDispatchTicket(
      `Bearer ${result.readyRequest.session.workerAuthToken}`,
      'secret'
    );
    expect(ticketResult).toMatchObject({
      success: true,
      claims: {
        type: 'wrapper_dispatch_ticket',
        userId: 'user_test',
        cloudAgentSessionId: 'agent_test',
        kiloSessionId: 'kilo-session',
        wrapperRunId: 'wr_test',
        wrapperGeneration: 2,
        wrapperConnectionId: 'conn_test',
      },
    });
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

  it('pins the provider baseURL to the target baked into the issued capability, not env.KILO_OPENROUTER_BASE independently', async () => {
    const service = new SessionService();
    const env = createEnv();
    env.WORKER_URL = 'https://cloud-agent.example.com';
    env.KILO_OPENROUTER_BASE = 'https://openrouter.wrong-base.example.com';
    env.KILO_SESSION_INGEST_URL = 'http://localhost:8800/ingest/';
    const issueKiloSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      capability: 'kka1.issued',
    });
    if (!env.GIT_TOKEN_SERVICE) throw new Error('Expected GIT_TOKEN_SERVICE in test env');
    env.GIT_TOKEN_SERVICE.issueKiloSessionCapability = issueKiloSessionCapability;
    // The stored Kilo token can encode its own provider base URL (e.g. a
    // self-hosted proxy) — that must win over the worker's static
    // KILO_OPENROUTER_BASE — the capability's baked-in target and the
    // sandbox's actual outbound baseURL must agree, or the outbound
    // interceptor rejects the request as upstream_not_allowed.
    const metadata = createMetadata({
      upstreamBranch: 'main',
      kilocodeToken: 'http://localhost:9911/api/openrouter/:provider-token',
      managedScmContainment: true,
    });
    const derivedTargets = deriveKiloSandboxTargets(env, metadata.auth.kilocodeToken ?? '');
    if (!derivedTargets.success) throw new Error('Expected valid derived Kilo sandbox targets');

    const result = await service.buildWrapperSessionReadyAndPromptRequests({
      env,
      plan: {
        scope: { sessionId: 'agent_test', userId: 'user_test' },
        turn: {
          type: 'prompt',
          messageId: 'msg_018f1e2d3c4bPayloadTestAAAA',
          prompt: 'Do the work',
        },
        agent: { mode: 'code', model: 'test-model', variant: 'thinking' },
        finalization: { autoCommit: true, condenseOnComplete: false },
        workspace: { sandboxId: 'ses-abcdef', metadata },
        wrapper: {
          fence: {
            wrapperRunId: 'wr_test',
            wrapperGeneration: 2,
            wrapperConnectionId: 'conn_test',
          },
        },
      } satisfies FencedWrapperDispatchRequest,
    });

    const configContent = JSON.parse(result.readyRequest.materialized.env.KILO_CONFIG_CONTENT) as {
      provider: { kilo: { options: { baseURL?: string } } };
    };
    expect(configContent.provider.kilo.options.baseURL).toBe(
      derivedTargets.targets.providerBaseUrl
    );
    expect(result.readyRequest.materialized.env.KILO_SESSION_INGEST_URL).toBe(
      derivedTargets.targets.sessionIngestBaseUrl
    );
    expect(issueKiloSessionCapability).toHaveBeenCalledWith(
      expect.objectContaining({ targets: derivedTargets.targets })
    );
    expect(configContent.provider.kilo.options.baseURL).not.toBe(
      'https://openrouter.wrong-base.example.com'
    );
    expect(result.readyRequest.materialized.env.KILO_SESSION_INGEST_URL).not.toBe(
      'http://localhost:8800/ingest/'
    );
  });

  it('treats transient Kilo capability issuance failures as retryable workspace setup failures', async () => {
    await expect(
      buildPromptWrapperRequests(createMetadata({ managedScmContainment: true }), env => {
        if (!env.GIT_TOKEN_SERVICE) throw new Error('Expected GIT_TOKEN_SERVICE in test env');
        env.GIT_TOKEN_SERVICE.issueKiloSessionCapability = vi
          .fn()
          .mockRejectedValue(new Error('binding unavailable'));
      })
    ).rejects.toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      retryable: true,
      message: 'Kilo session capability issuance failed (rpc_error)',
    });
  });

  it('falls back to the raw Kilo token for DIND sandboxes, which have no outbound interceptor to redeem a capability against', async () => {
    const service = new SessionService();
    const env = createEnv();
    env.WORKER_URL = 'https://cloud-agent.example.com';
    const issueKiloSessionCapability = vi.fn();
    if (!env.GIT_TOKEN_SERVICE) throw new Error('Expected GIT_TOKEN_SERVICE in test env');
    env.GIT_TOKEN_SERVICE.issueKiloSessionCapability = issueKiloSessionCapability;
    const metadata = createMetadata({ sandboxId: 'dind-abcdef' });

    const result = await service.buildWrapperSessionReadyAndPromptRequests({
      env,
      plan: {
        scope: { sessionId: 'agent_test', userId: 'user_test' },
        turn: {
          type: 'prompt',
          messageId: 'msg_018f1e2d3c4bDindFallbackAA',
          prompt: 'Do the work',
        },
        agent: { mode: 'code', model: 'test-model' },
        workspace: { sandboxId: 'dind-abcdef', metadata },
        wrapper: {
          fence: {
            wrapperRunId: 'wr_dind',
            wrapperGeneration: 1,
            wrapperConnectionId: 'conn_dind',
          },
        },
      } satisfies FencedWrapperDispatchRequest,
    });

    expect(issueKiloSessionCapability).not.toHaveBeenCalled();
    expect(result.readyRequest.materialized.env.KILOCODE_TOKEN).toBe('kilo-token');
    expect(JSON.parse(result.readyRequest.materialized.env.KILO_AUTH_CONTENT)).toEqual({
      kilo: { type: 'api', key: 'kilo-token' },
    });
  });

  it('falls back to the raw Kilo token for an uncontained session', async () => {
    const service = new SessionService();
    const env = createEnv();
    env.WORKER_URL = 'https://cloud-agent.example.com';
    const issueKiloSessionCapability = vi.fn();
    if (!env.GIT_TOKEN_SERVICE) throw new Error('Expected GIT_TOKEN_SERVICE in test env');
    env.GIT_TOKEN_SERVICE.issueKiloSessionCapability = issueKiloSessionCapability;
    const metadata = createMetadata({ managedScmContainment: false });

    const result = await service.buildWrapperSessionReadyAndPromptRequests({
      env,
      plan: {
        scope: { sessionId: 'agent_test', userId: 'user_test' },
        turn: {
          type: 'prompt',
          messageId: 'msg_018f1e2d3c4bContainmentFallbackAA',
          prompt: 'Do the work',
        },
        agent: { mode: 'code', model: 'test-model' },
        workspace: { sandboxId: 'ses-abcdef', metadata },
        wrapper: {
          fence: {
            wrapperRunId: 'wr_containment_fallback',
            wrapperGeneration: 1,
            wrapperConnectionId: 'conn_cf',
          },
        },
      } satisfies FencedWrapperDispatchRequest,
    });

    expect(issueKiloSessionCapability).not.toHaveBeenCalled();
    expect(result.readyRequest.materialized.env.KILOCODE_TOKEN).toBe('kilo-token');
    expect(JSON.parse(result.readyRequest.materialized.env.KILO_AUTH_CONTENT)).toEqual({
      kilo: { type: 'api', key: 'kilo-token' },
    });
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

  it.each([
    ['cloud-agent-web', true],
    [undefined, false],
    ['app-builder', false],
    ['code-review', false],
    ['slack', false],
  ])('sets Kilo snapshots for %s-origin sessions to %s', async (createdOnPlatform, snapshot) => {
    const result = await buildPromptWrapperRequests(createMetadata({ createdOnPlatform }));
    const kiloConfig = JSON.parse(result.readyRequest.materialized.env.KILO_CONFIG_CONTENT) as {
      snapshot?: boolean;
    };
    const opencodeConfig = JSON.parse(result.readyRequest.materialized.env.OPENCODE_CONFIG_CONTENT);

    expect(kiloConfig.snapshot).toBe(snapshot);
    expect(opencodeConfig).toEqual(kiloConfig);
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
        workspace: { sandboxId: 'ses-abcdef', metadata: createMetadata() },
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

  it('fails closed without a raw managed GitLab token fallback when wrapper capability issuance fails', async () => {
    tokenMocks.issueCloudAgentGitLabSessionCapability.mockResolvedValueOnce({
      success: false,
      reason: 'rpc_error',
    });

    await expect(
      buildPromptWrapperRequests(createMetadata({ managedScmContainment: true }))
    ).rejects.toThrow('GitLab token lookup failed (rpc_error)');

    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalled();
    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
  });

  it('fails closed without a raw managed token fallback when wrapper capability issuance fails', async () => {
    tokenMocks.issueCloudAgentGitHubSessionCapability.mockResolvedValueOnce({
      success: false,
      error: { reason: 'rpc_error', message: 'RPC unavailable' },
    });
    const metadata = createMetadata({
      githubRepo: 'acme/repo',
      gitUrl: undefined,
      gitToken: undefined,
      platform: 'github',
    });

    await expect(buildPromptWrapperRequests(metadata)).rejects.toThrow(
      'GitHub token or active app installation required'
    );

    expect(tokenMocks.issueCloudAgentGitHubSessionCapability).toHaveBeenCalled();
    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
  });

  it('uses a capability for selected-user GitHub remote and managed GH_TOKEN', async () => {
    tokenMocks.issueCloudAgentGitHubSessionCapability.mockResolvedValueOnce({
      success: true,
      value: {
        capability: 'kgh2.selected-user',
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

    expect(tokenMocks.issueCloudAgentGitHubSessionCapability).toHaveBeenCalledWith(
      expect.any(Object),
      {
        githubRepo: 'acme/repo',
        userId: 'user_test',
        outboundContainerId: 'containment-small-sandbox-do-id',
        orgId: undefined,
        allowUserAuthorization: true,
      }
    );
    expect(tokenMocks.resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'github',
      token: 'kgh2.selected-user',
      gitAuthor: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
    });
    expect(result.readyRequest.materialized.env.GH_TOKEN).toBe('kgh2.selected-user');
    expect(JSON.stringify(result.readyRequest)).not.toContain('selected-user-token');
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

    expect(tokenMocks.issueCloudAgentGitHubSessionCapability).toHaveBeenCalledWith(
      expect.any(Object),
      {
        githubRepo: 'acme/repo',
        userId: 'user_test',
        outboundContainerId: 'containment-small-sandbox-do-id',
        orgId: undefined,
        allowUserAuthorization: true,
      }
    );
  });

  it.each([undefined, 'code-review', 'discord', 'github'])(
    'requests installation-only GitHub capability for %s-origin sessions',
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

      expect(tokenMocks.issueCloudAgentGitHubSessionCapability).toHaveBeenCalledWith(
        expect.any(Object),
        {
          githubRepo: 'acme/repo',
          userId: 'user_test',
          outboundContainerId: 'containment-small-sandbox-do-id',
          orgId: undefined,
          allowUserAuthorization: false,
        }
      );
    }
  );

  it('preserves installation author identity supplied with capability metadata', async () => {
    tokenMocks.issueCloudAgentGitHubSessionCapability.mockResolvedValueOnce({
      success: true,
      value: {
        capability: 'kgh2.installation',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: {
          name: 'kiloconnect-development[bot]',
          email: '242397087+kiloconnect-development[bot]@users.noreply.github.com',
        },
      },
    });
    const result = await buildPromptWrapperRequests(
      createMetadata({
        githubRepo: 'acme/repo',
        gitUrl: undefined,
        gitToken: undefined,
        platform: 'github',
      })
    );

    expect(result.readyRequest.repo).toMatchObject({
      kind: 'github',
      token: 'kgh2.installation',
      gitAuthor: {
        name: 'kiloconnect-development[bot]',
        email: '242397087+kiloconnect-development[bot]@users.noreply.github.com',
      },
    });
  });

  it('preserves an explicit profile GH_TOKEN over a managed capability', async () => {
    tokenMocks.issueCloudAgentGitHubSessionCapability.mockResolvedValueOnce({
      success: true,
      value: {
        capability: 'kgh2.selected-user',
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

  it('materializes a canonical capability URL with a nested namespace and self-managed base URL', async () => {
    tokenMocks.issueCloudAgentGitLabSessionCapability.mockResolvedValueOnce({
      success: true,
      value: {
        capability: 'kgl2.self-managed',
        gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo.git',
        instanceOrigin: 'https://gitlab.example.com:8443/gitlab',
        instanceHost: 'gitlab.example.com:8443',
        projectPath: 'acme/platform/repo',
        integrationId: 'integration_1',
        authType: 'oauth',
        identity: { accountId: '42', accountLogin: 'octocat' },
        glabIsOAuth2: true,
      },
    });
    const result = await buildPromptWrapperRequests(
      createMetadata({
        gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo',
        platform: 'gitlab',
        managedScmContainment: true,
      })
    );

    expect(result.ready).toMatchObject({
      gitToken: 'kgl2.self-managed',
      gitlabTokenManaged: true,
    });
    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalledWith(
      expect.any(Object),
      {
        gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo',
        userId: 'user_test',
        outboundContainerId: 'containment-small-sandbox-do-id',
        orgId: undefined,
      }
    );
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'git',
      url: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo.git',
      token: 'kgl2.self-managed',
      platform: 'gitlab',
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('kgl2.self-managed');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.example.com:8443');
    expect(result.readyRequest.materialized.env.GITLAB_SUBFOLDER).toBe('gitlab');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBe('true');
  });

  it('preserves explicit profile GitLab CLI values over a managed capability', async () => {
    const result = await buildPromptWrapperRequests(
      createMetadata({
        managedScmContainment: true,
        envVars: {
          GITLAB_TOKEN: 'explicit-profile-token',
          GITLAB_HOST: 'profile.gitlab.example.com',
          GLAB_IS_OAUTH2: 'false',
        },
      })
    );

    expect(result.readyRequest.repo).toMatchObject({
      token: 'kgl2.default',
      platform: 'gitlab',
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('explicit-profile-token');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('profile.gitlab.example.com');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBe('false');
  });

  it('preserves an explicit profile GLAB_IS_OAUTH2 value when injecting a managed GitLab token', async () => {
    const result = await buildPromptWrapperRequests(
      createMetadata({
        managedScmContainment: true,
        envVars: {
          GLAB_IS_OAUTH2: 'false',
        },
      })
    );

    expect(result.ready).toMatchObject({
      gitToken: 'kgl2.default',
      gitlabTokenManaged: true,
    });
    expect(result.readyRequest.repo).toMatchObject({
      token: 'kgl2.default',
      platform: 'gitlab',
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('kgl2.default');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.com');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBe('false');
  });

  it('materializes a review-origin GitLab project capability with OAuth mode disabled', async () => {
    tokenMocks.issueCloudAgentGitLabSessionCapability.mockResolvedValueOnce({
      success: true,
      value: {
        capability: 'kgl2.project',
        gitUrl: 'https://gitlab.com/acme/repo.git',
        instanceOrigin: 'https://gitlab.com',
        instanceHost: 'gitlab.com',
        projectPath: 'acme/repo',
        integrationId: 'project_token_1',
        authType: 'pat',
        identity: { accountId: null, accountLogin: null },
        glabIsOAuth2: false,
      },
    });
    const result = await buildPromptWrapperRequests(createGitLabCodeReviewMetadata());

    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalledWith(
      expect.any(Object),
      {
        gitUrl: 'https://gitlab.com/acme/repo.git',
        userId: 'user_test',
        outboundContainerId: 'containment-small-sandbox-do-id',
        orgId: undefined,
        createdOnPlatform: 'code-review',
      }
    );
    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'git',
      token: 'kgl2.project',
      platform: 'gitlab',
      refreshRemote: true,
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('kgl2.project');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBe('false');
    expect(JSON.stringify(result.readyRequest)).not.toContain('resolved-project-token');
  });

  it('does not allow profile GitLab credentials to replace a review project capability', async () => {
    tokenMocks.issueCloudAgentGitLabSessionCapability.mockResolvedValueOnce({
      success: true,
      value: {
        capability: 'kgl2.project',
        gitUrl: 'https://gitlab.com/acme/repo.git',
        instanceOrigin: 'https://gitlab.com',
        instanceHost: 'gitlab.com',
        projectPath: 'acme/repo',
        integrationId: 'project_token_1',
        authType: 'pat',
        identity: { accountId: null, accountLogin: null },
        glabIsOAuth2: false,
      },
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

    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('kgl2.project');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBe('false');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.com');
    expect(JSON.stringify(result.readyRequest)).not.toContain('configured-human-token');
  });

  it.each([
    [
      'integration_identity_missing',
      'GitLab token lookup failed (integration_identity_missing). The connected GitLab integration is missing its account identity. Reconnect or reconfigure the integration.',
    ],
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
    'reports actionable review-origin GitLab capability lookup failure for %s without using a human-token fallback',
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

      tokenMocks.issueCloudAgentGitLabSessionCapability.mockResolvedValueOnce({
        success: false,
        reason,
      });

      await expect(buildPromptWrapperRequests(metadataWithFallbackToken)).rejects.toThrow(
        expectedMessage
      );
      expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalledWith(
        expect.any(Object),
        {
          gitUrl: 'https://gitlab.com/acme/repo.git',
          userId: 'user_test',
          outboundContainerId: 'containment-small-sandbox-do-id',
          orgId: undefined,
          createdOnPlatform: 'code-review',
        }
      );
      expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    }
  );

  it('keeps reconnect guidance for GitLab OAuth-token lifecycle failures', async () => {
    tokenMocks.issueCloudAgentGitLabSessionCapability.mockResolvedValueOnce({
      success: false,
      reason: 'token_refresh_failed',
    });

    await expect(buildPromptWrapperRequests(createGitLabCodeReviewMetadata())).rejects.toThrow(
      'GitLab token lookup failed (token_refresh_failed). Please reconnect your GitLab account.'
    );
    expect(tokenMocks.issueCloudAgentGitLabSessionCapability).toHaveBeenCalledOnce();
    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
  });

  it('materializes only fixed repository identity from the fresh managed token', async () => {
    const result = await buildPromptWrapperRequests(createBitbucketMetadata(true));

    expect(tokenMocks.resolveManagedBitbucketToken).toHaveBeenCalledWith(expect.any(Object), {
      userId: 'user_test',
      orgId: '123e4567-e89b-12d3-a456-426614174030',
      expectedIntegrationId: '123e4567-e89b-12d3-a456-426614174022',
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      repositoryUrl: 'https://bitbucket.org/acme-team/widgets.git',
    });
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'git',
      token: 'fresh-bitbucket-token',
      platform: 'bitbucket',
      refreshRemote: true,
    });
    expect(result.readyRequest.materialized.env).toMatchObject({
      BITBUCKET_TOKEN: 'fresh-bitbucket-token',
      KILO_BITBUCKET_WORKSPACE_SLUG: 'acme-team',
      KILO_BITBUCKET_WORKSPACE_UUID: '{123e4567-e89b-12d3-a456-426614174020}',
      KILO_BITBUCKET_REPOSITORY_SLUG: 'widgets',
      KILO_BITBUCKET_REPOSITORY_UUID: '{123e4567-e89b-12d3-a456-426614174021}',
    });
    expect(result.readyRequest.materialized.env.KILO_BITBUCKET_INTEGRATION_ID).toBeUndefined();
    expect(result.readyRequest.materialized.env.PATH).toBeUndefined();
    expect(
      Object.keys(result.readyRequest.materialized.env)
        .filter(key => key.startsWith('KILO_BITBUCKET_'))
        .sort()
    ).toEqual(
      [
        'KILO_BITBUCKET_REPOSITORY_SLUG',
        'KILO_BITBUCKET_REPOSITORY_UUID',
        'KILO_BITBUCKET_WORKSPACE_SLUG',
        'KILO_BITBUCKET_WORKSPACE_UUID',
      ].sort()
    );

    const inputPath = bitbucketReviewInputPath('123e4567-e89b-12d3-a456-426614174023');
    const config = JSON.parse(result.readyRequest.materialized.env.KILO_CONFIG_CONTENT) as {
      permission: {
        bash: Record<string, 'allow' | 'deny'>;
        edit: Record<string, 'allow' | 'deny'>;
        external_directory: Record<string, 'allow' | 'deny'>;
        task: string;
        lsp: string;
      };
    };
    const relativeInputPath = relative('/workspace/user/sessions/agent_test', inputPath);
    expect(
      resolveCommandGuardBashPermission(
        config.permission.external_directory,
        `${dirname(inputPath)}/*`
      )
    ).toBe('allow');
    expect(resolveCommandGuardBashPermission(config.permission.external_directory, '/tmp/*')).toBe(
      'deny'
    );
    expect(resolveCommandGuardBashPermission(config.permission.edit, relativeInputPath)).toBe(
      'allow'
    );
    expect(resolveCommandGuardBashPermission(config.permission.edit, '../another.json')).toBe(
      'deny'
    );
    expect(config.permission.task).toBe('deny');
    expect(config.permission.lsp).toBe('deny');
    expect(
      resolveCommandGuardBashPermission(
        config.permission.bash,
        `bb comments create 42 --input - < ${inputPath}`
      )
    ).toBe('allow');
    for (const key of [
      'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_KEY_1',
      'GIT_CONFIG_VALUE_1',
      'GIT_CONFIG_KEY_2',
      'GIT_CONFIG_VALUE_2',
      'GIT_OPTIONAL_LOCKS',
    ]) {
      expect(result.readyRequest.materialized.env[key], key).toBeUndefined();
    }
  });

  it('does not materialize profile env vars or encrypted secrets for Bitbucket reviews', async () => {
    const baseMetadata = createBitbucketMetadata(true);
    const metadata = {
      ...baseMetadata,
      profile: {
        ...baseMetadata.profile,
        envVars: {
          BASH_ENV: '/workspace/repository-controlled.sh',
          LD_PRELOAD: '/workspace/repository-controlled.so',
        },
        encryptedSecrets: {
          PROFILE_SECRET: {
            encryptedData: 'not-decrypted',
            encryptedDEK: 'not-decrypted',
            algorithm: 'rsa-aes-256-gcm' as const,
            version: 1 as const,
          },
        },
      },
    } satisfies CloudAgentSessionState;

    const result = await buildPromptWrapperRequests(metadata, env => {
      env.AGENT_ENV_VARS_PRIVATE_KEY = undefined;
    });
    const materialized = result.readyRequest.materialized.env;

    expect(materialized.BASH_ENV).toBeUndefined();
    expect(materialized.LD_PRELOAD).toBeUndefined();
    expect(materialized.PROFILE_SECRET).toBeUndefined();
  });

  it('materializes fixed Bitbucket CLI environment for ordinary Bitbucket sessions', async () => {
    const result = await buildPromptWrapperRequests(createBitbucketMetadata(false));
    const materialized = result.readyRequest.materialized.env;

    expect(tokenMocks.resolveManagedBitbucketToken).toHaveBeenCalledWith(expect.any(Object), {
      userId: 'user_test',
      orgId: '123e4567-e89b-12d3-a456-426614174030',
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      repositoryUrl: 'https://bitbucket.org/acme-team/widgets.git',
    });
    expect(result.readyRequest.repo).toMatchObject({
      token: 'fresh-bitbucket-token',
      platform: 'bitbucket',
      refreshRemote: true,
    });
    expect(materialized).toMatchObject({
      BITBUCKET_TOKEN: 'fresh-bitbucket-token',
      KILO_BITBUCKET_WORKSPACE_SLUG: 'acme-team',
      KILO_BITBUCKET_WORKSPACE_UUID: '{123e4567-e89b-12d3-a456-426614174020}',
      KILO_BITBUCKET_REPOSITORY_SLUG: 'widgets',
      KILO_BITBUCKET_REPOSITORY_UUID: '{123e4567-e89b-12d3-a456-426614174021}',
    });
    expect(materialized.KILO_BITBUCKET_INTEGRATION_ID).toBeUndefined();
    expect(
      Object.keys(materialized)
        .filter(key => key.startsWith('KILO_BITBUCKET_'))
        .sort()
    ).toEqual(
      [
        'KILO_BITBUCKET_REPOSITORY_SLUG',
        'KILO_BITBUCKET_REPOSITORY_UUID',
        'KILO_BITBUCKET_WORKSPACE_SLUG',
        'KILO_BITBUCKET_WORKSPACE_UUID',
      ].sort()
    );
    expect(materialized.PATH).toBe('/user/bin');
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

  it('preserves legacy GitLab env setup for SSH clone URLs', async () => {
    const result = await buildPromptWrapperRequests(
      createMetadata({
        gitUrl: 'git@gitlab.com:acme/repo.git',
        gitToken: 'generic-git-token',
        platform: undefined,
        gitlabTokenManaged: undefined,
      })
    );

    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'git',
      url: 'git@gitlab.com:acme/repo.git',
      token: 'generic-git-token',
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('generic-git-token');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.com');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBeUndefined();
  });

  it('preserves legacy GitLab env setup for ssh URL clone URLs', async () => {
    const result = await buildPromptWrapperRequests(
      createMetadata({
        gitUrl: 'ssh://git@gitlab.com/acme/repo.git',
        gitToken: 'generic-git-token',
        platform: undefined,
        gitlabTokenManaged: undefined,
      })
    );

    expect(tokenMocks.resolveManagedGitLabToken).not.toHaveBeenCalled();
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'git',
      url: 'ssh://git@gitlab.com/acme/repo.git',
      token: 'generic-git-token',
    });
    expect(result.readyRequest.materialized.env.GITLAB_TOKEN).toBe('generic-git-token');
    expect(result.readyRequest.materialized.env.GITLAB_HOST).toBe('gitlab.com');
    expect(result.readyRequest.materialized.env.GLAB_IS_OAUTH2).toBeUndefined();
  });

  it('preserves legacy Bitbucket env setup for ssh URL clone URLs', async () => {
    const baseMetadata = createBitbucketMetadata(false);
    const bitbucketRepository = baseMetadata.repository;
    if (bitbucketRepository?.type !== 'bitbucket') {
      throw new Error('Expected Bitbucket metadata fixture');
    }
    const { platform: explicitPlatform, ...repositoryWithoutPlatform } = bitbucketRepository;
    expect(explicitPlatform).toBe('bitbucket');
    const metadata = {
      ...baseMetadata,
      repository: {
        ...repositoryWithoutPlatform,
        url: 'ssh://git@bitbucket.org/acme-team/widgets.git',
      },
    } satisfies CloudAgentSessionState;

    const result = await buildPromptWrapperRequests(metadata);

    expect(tokenMocks.resolveManagedBitbucketToken).toHaveBeenCalledWith(expect.any(Object), {
      userId: 'user_test',
      orgId: '123e4567-e89b-12d3-a456-426614174030',
      workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
      repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      repositoryUrl: 'ssh://git@bitbucket.org/acme-team/widgets.git',
    });
    expect(result.readyRequest.repo).toMatchObject({
      kind: 'git',
      url: 'ssh://git@bitbucket.org/acme-team/widgets.git',
      token: 'fresh-bitbucket-token',
      refreshRemote: true,
    });
    expect(result.readyRequest.materialized.env).toMatchObject({
      BITBUCKET_TOKEN: 'fresh-bitbucket-token',
      KILO_BITBUCKET_WORKSPACE_SLUG: 'acme-team',
      KILO_BITBUCKET_WORKSPACE_UUID: '{123e4567-e89b-12d3-a456-426614174020}',
      KILO_BITBUCKET_REPOSITORY_SLUG: 'widgets',
      KILO_BITBUCKET_REPOSITORY_UUID: '{123e4567-e89b-12d3-a456-426614174021}',
    });
  });

  it('does not infer Bitbucket from clone URL path substrings', async () => {
    const result = await buildPromptWrapperRequests(
      createMetadata({
        gitUrl: 'https://example.com/bitbucket.org/acme/repo.git',
        gitToken: 'generic-git-token',
        platform: undefined,
        bitbucketTokenManaged: true,
        gitlabTokenManaged: undefined,
      })
    );

    expect(result.readyRequest.repo).toMatchObject({
      kind: 'git',
      url: 'https://example.com/bitbucket.org/acme/repo.git',
      token: 'generic-git-token',
    });
    expect(result.readyRequest.materialized.env.BITBUCKET_TOKEN).toBeUndefined();
    expect(result.readyRequest.materialized.env.KILO_BITBUCKET_WORKSPACE_SLUG).toBeUndefined();
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
