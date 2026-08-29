import { describe, expect, it, vi } from 'vitest';
import { type LaunchRepositoryReference } from '@kilocode/app-shared/code-review/repository-identity';
import { type SessionManagerConfig } from '@kilocode/cloud-agent-sdk';

import { resolveProviderLaunchInput, restoreLegacyLaunchInput } from './provider-launch-input';
import { type NewSessionRepository } from './new-session-repository-state';

const reference: LaunchRepositoryReference = {
  repository: {
    provider: 'gitlab',
    instanceUrl: 'https://git.example/base',
    repositoryId: '42',
    fullName: 'Group/Sub/repo',
    defaultBranch: 'develop',
  },
  authorization: {
    kind: 'ownerIntegration',
    owner: { type: 'org', id: 'org-1' },
    integrationId: 'integration-1',
  },
};

function resolve(
  ref = reference,
  upstreamBranch: string | undefined = 'release',
  accountId = 'user-1'
) {
  const row: NewSessionRepository = {
    platform: ref.repository.provider,
    fullName: ref.repository.fullName,
    isPrivate: true,
  };
  return resolveProviderLaunchInput(row, {
    accountId,
    organizationId: ref.authorization.owner.type === 'org' ? ref.authorization.owner.id : undefined,
    launchSelection: { reference: ref, upstreamBranch },
  });
}

describe('provider launch boundary', () => {
  it.each([
    {
      provider: 'github',
      instanceUrl: 'https://github.com',
      expected: { githubRepo: 'owner/repo', githubIntegrationId: 'integration-1' },
    },
    {
      provider: 'gitlab',
      instanceUrl: 'https://git.example/base',
      expected: {
        gitlabProject: 'owner/repo',
        gitlabIntegrationId: 'integration-1',
        gitlabInstanceUrl: 'https://git.example/base',
      },
    },
    {
      provider: 'bitbucket',
      instanceUrl: 'https://bitbucket.org',
      expected: {
        bitbucketRepo: {
          fullName: 'owner/repo',
          workspaceUuid: 'workspace-1',
          repositoryUuid: '42',
        },
        bitbucketIntegrationId: 'integration-1',
      },
    },
  ] as const)(
    'maps $provider identity and the selected branch',
    ({ provider, instanceUrl, expected }) => {
      const repository =
        provider === 'bitbucket'
          ? {
              ...reference.repository,
              provider,
              instanceUrl,
              fullName: 'owner/repo',
              workspaceUuid: 'workspace-1',
            }
          : { ...reference.repository, provider, instanceUrl, fullName: 'owner/repo' };
      expect(resolve({ ...reference, repository })?.input).toEqual({
        ...expected,
        upstreamBranch: 'release',
      });
    }
  );

  it('supports Personal GitLab without inventing a default branch', () => {
    const personal: LaunchRepositoryReference = {
      ...reference,
      authorization: { ...reference.authorization, owner: { type: 'user', id: 'user-1' } },
    };
    const result = resolveProviderLaunchInput(
      { platform: 'gitlab', fullName: 'Group/Sub/repo', isPrivate: true },
      { accountId: 'user-1', launchSelection: { reference: personal } }
    );
    expect(result?.input).toEqual({
      gitlabProject: 'Group/Sub/repo',
      gitlabIntegrationId: 'integration-1',
      gitlabInstanceUrl: 'https://git.example/base',
    });
  });

  it('isolates every identity component and branch in the retry fingerprint', () => {
    const variants = [
      resolve(reference, 'other'),
      resolve(reference, 'release', 'other-account'),
      resolve({
        ...reference,
        authorization: { ...reference.authorization, integrationId: 'other-integration' },
      }),
      resolve({
        ...reference,
        authorization: { ...reference.authorization, owner: { type: 'org', id: 'other-org' } },
      }),
      resolve({
        ...reference,
        authorization: { ...reference.authorization, owner: { type: 'user', id: 'user-1' } },
      }),
      resolve({
        ...reference,
        repository: { ...reference.repository, instanceUrl: 'https://git.example/other' },
      }),
      resolve({ ...reference, repository: { ...reference.repository, repositoryId: '43' } }),
      resolve({
        ...reference,
        repository: { ...reference.repository, fullName: 'Group/Other/repo' },
      }),
    ];
    for (const result of variants) {
      expect(result).not.toBeNull();
      expect(result?.fingerprint).not.toBe(resolve()?.fingerprint);
    }
    expect(new Set(variants.map(result => result?.fingerprint)).size).toBe(variants.length);
  });

  it('rejects an owner change, a stale row, an empty branch, and incomplete Bitbucket identity', () => {
    const row: NewSessionRepository = {
      platform: 'gitlab',
      fullName: 'Group/Sub/repo',
      isPrivate: true,
    };
    expect(
      resolveProviderLaunchInput(row, {
        accountId: 'user-1',
        organizationId: 'other-org',
        launchSelection: { reference },
      })
    ).toBeNull();
    expect(
      resolveProviderLaunchInput(
        { ...row, fullName: 'other/repo' },
        { accountId: 'user-1', organizationId: 'org-1', launchSelection: { reference } }
      )
    ).toBeNull();
    expect(resolve(reference, '')).toBeNull();
    expect(
      resolveProviderLaunchInput(
        { platform: 'bitbucket', fullName: 'workspace/repo', isPrivate: true },
        {}
      )
    ).toBeNull();
    expect(resolveProviderLaunchInput(null, {})).toBeNull();
  });

  it('keeps the old GitHub payload and retry bytes when selection additions are absent', () => {
    const result = resolveProviderLaunchInput(
      { platform: 'github', fullName: 'Owner/repo', isPrivate: true },
      {}
    );
    expect(result?.input).toEqual({ githubRepo: 'Owner/repo' });
    expect(JSON.stringify(result?.fingerprint)).toBe(
      '{"platform":"github","fullName":"Owner/repo"}'
    );
  });
});

describe('legacy launch admission', () => {
  const input = {
    githubRepo: 'owner/repo',
    prompt: 'Saved prompt',
    initialMessageId: 'original-message',
    operationKey: 'original-key',
    mode: 'code',
    model: 'model',
    autoCommit: false,
    autoInitiate: true,
  };
  const row = {
    taxonomy: 'safe-retry' as const,
    operationKey: 'original-key',
    fingerprint: 'old',
    input,
  };
  const retry = {
    ...input,
    initialMessageId: 'replacement-message',
    operationKey: 'replacement-key',
  };

  it('restores the admitted key and message without adding current branch or integration pins', () => {
    expect(restoreLegacyLaunchInput(row, retry)).toEqual(input);
    expect(restoreLegacyLaunchInput(row, { ...retry, upstreamBranch: 'release' })).toBeNull();
    expect(restoreLegacyLaunchInput(row, { ...retry, githubIntegrationId: 'new' })).toBeNull();
  });

  it.each([
    ['repository mismatch', { githubRepo: 'owner/other' }],
    ['prompt mismatch', { prompt: 'Another prompt' }],
    ['key mismatch', { operationKey: 'another-key' }],
    ['missing message identity', { initialMessageId: undefined }],
    ['unrecorded branch', { upstreamBranch: 'release' }],
    ['unrecorded integration', { githubIntegrationId: 'unknown' }],
    ['unknown intent field', { futureSetting: true }],
    ['malformed attachments', { attachments: { path: 'a', files: 'not-an-array' } }],
  ] as const)('quarantines %s instead of reinterpreting the operation', (_name, change) => {
    expect(restoreLegacyLaunchInput({ ...row, input: { ...input, ...change } }, retry)).toBeNull();
  });
});

// Exercise the real mobile adapter with its external transports replaced.
const manager = vi.hoisted(() => ({ config: null as SessionManagerConfig | null, query: vi.fn() }));
vi.mock('@kilocode/cloud-agent-sdk', () => ({
  createSessionManager: (config: SessionManagerConfig) => {
    manager.config = config;
    return {};
  },
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest: vi.fn() }));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
  CLOUD_AGENT_WS_URL: 'wss://ws.test',
  WEB_BASE_URL: 'https://web.test',
}));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: vi.fn(),
}));
vi.mock('@/components/agents/mobile-session-transport-payload', () => ({
  normalizeTransportPayload: vi.fn(),
}));
vi.mock('@/components/agents/mobile-session-diagnostics', () => ({
  formatSafeCloudAgentFailureDiagnostic: vi.fn(),
  withCloudAgentDiagnostics: vi.fn(),
}));
vi.mock('@/components/agents/mobile-session-page-adapter', () => ({
  fetchMobileSessionSnapshotPage: vi.fn(),
}));
vi.mock('@/components/agents/tool-card-image-cache', () => ({ cacheToolAttachment: vi.fn() }));
vi.mock('@/components/agents/file-part-cache', () => ({ cacheFilePart: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpcClient: { cliSessionsV2: { getWithRuntimeState: { query: manager.query } } },
}));

it.each([
  [
    { githubRepo: 'Owner/repo' },
    'https://github.com/other/repo',
    { repository: 'Owner/repo', gitUrl: 'https://github.com/other/repo' },
  ],
  [
    { gitUrl: 'https://git.example/base/Group/Sub/repo.git' },
    null,
    { repository: 'base/Group/Sub/repo', gitUrl: 'https://git.example/base/Group/Sub/repo.git' },
  ],
  [
    { gitUrl: 'https://bitbucket.org/workspace/repo.git' },
    null,
    { repository: 'workspace/repo', gitUrl: 'https://bitbucket.org/workspace/repo.git' },
  ],
  [
    null,
    'git@gitlab.com:group/sub/repo.git',
    { repository: 'group/sub/repo', gitUrl: 'git@gitlab.com:group/sub/repo.git' },
  ],
  [null, null, { repository: null, gitUrl: null }],
])(
  'reconstructs repository metadata from runtime or old history %j',
  async (runtimeState, gitUrl, expected) => {
    const { createMobileAgentSessionManager } = await import('./mobile-session-manager');
    const dependencies = { store: {}, userWebConnection: {} };
    createMobileAgentSessionManager(
      dependencies as Parameters<typeof createMobileAgentSessionManager>[0]
    );
    manager.query.mockResolvedValue({ runtimeState, git_url: gitUrl });
    const result = await manager.config?.fetchSession('ses_test' as never);
    expect(result).toMatchObject(expected);
  }
);
