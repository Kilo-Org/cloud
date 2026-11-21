import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubTokenGenerationError, GitHubTokenService } from './github-token-service.js';
import { GitTokenRPCEntrypoint } from './index.js';
import { InstallationLookupService } from './installation-lookup-service.js';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(
      _ctx: unknown,
      readonly env: unknown
    ) {}
  },
}));

const scope = {
  userId: 'oauth/example',
  organizationId: '00000000-0000-4000-8000-000000000001',
  integrationId: '00000000-0000-4000-8000-000000000002',
  primaryRepo: 'org/main',
};
const lookupScope = {
  userId: scope.userId,
  orgId: scope.organizationId,
  expectedIntegrationId: scope.integrationId,
  githubRepo: scope.primaryRepo,
};
const installation = {
  success: true,
  installationId: '123',
  accountLogin: 'Org',
  githubAppType: 'lite',
  selectedRepositories: null,
} as const;

function repo(id: number, full_name: string, flags = {}) {
  return { id, full_name, private: true, archived: false, disabled: false, ...flags };
}

const primary = repo(101, 'Org/Main');
const additional = repo(202, 'Org/Tools');

function inventory(repositories: ReturnType<typeof repo>[], total_count = repositories.length) {
  return Response.json({ repositories, total_count });
}

const githubFetch = vi.fn<typeof fetch>();

function createEntrypoint() {
  return new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);
}

describe('hosted workspace GitHub repository RPCs', () => {
  beforeEach(() => {
    githubFetch.mockReset();
    vi.stubGlobal('fetch', githubFetch);
    vi.spyOn(
      InstallationLookupService.prototype,
      'findHostedWorkspaceInstallation'
    ).mockResolvedValue(installation);
    vi.spyOn(InstallationLookupService.prototype, 'findRefreshCandidates').mockResolvedValue({
      success: true,
      candidates: [],
    });
    vi.spyOn(
      GitHubTokenService.prototype,
      'getFreshTokenForRepositorySelection'
    ).mockImplementation(async (_installationId, _appType, selection) =>
      'repositoryNames' in selection ? 'primary-token' : 'ids-token'
    );
    vi.spyOn(GitHubTokenService.prototype, 'getToken').mockResolvedValue('installation-token');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists only eligible safe metadata, reusing the requested page as primary proof', async () => {
    githubFetch.mockResolvedValueOnce(
      inventory(
        [
          primary,
          repo(202, 'Org/Tools', { token: 'never release upstream fields' }),
          repo(204, 'Org/Frozen', { archived: true }),
          repo(205, 'Org/Disabled', { disabled: true }),
          repo(206, 'Other/Public', { private: false }),
          repo(207, 'Org/Unsynced'),
        ],
        101
      )
    );
    vi.mocked(
      InstallationLookupService.prototype.findHostedWorkspaceInstallation
    ).mockResolvedValueOnce({
      ...installation,
      selectedRepositories: new Set([
        'org/main',
        'org/tools',
        'org/frozen',
        'org/disabled',
        'other/public',
      ]),
    });

    await expect(
      createEntrypoint().listHostedWorkspaceGitHubRepositories({ ...scope, page: 1 })
    ).resolves.toEqual({
      success: true,
      repositories: [{ id: 202, fullName: 'Org/Tools', private: true }],
      nextPage: 2,
    });
    expect(
      InstallationLookupService.prototype.findHostedWorkspaceInstallation
    ).toHaveBeenCalledExactlyOnceWith(lookupScope);
    expect(githubFetch).toHaveBeenCalledExactlyOnceWith(
      new URL('https://api.github.com/installation/repositories?per_page=100&page=1'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer installation-token' }),
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      })
    );
    expect(GitHubTokenService.prototype.getFreshTokenForRepositorySelection).not.toHaveBeenCalled();
  });

  it('proves the primary is installed even on a later page with no eligible choices', async () => {
    githubFetch.mockResolvedValueOnce(
      inventory([repo(204, 'Org/Frozen', { archived: true })], 201)
    );
    githubFetch.mockResolvedValueOnce(inventory([primary]));

    await expect(
      createEntrypoint().listHostedWorkspaceGitHubRepositories({ ...scope, page: 2 })
    ).resolves.toEqual({
      success: true,
      repositories: [],
      nextPage: 3,
    });
    expect(
      GitHubTokenService.prototype.getFreshTokenForRepositorySelection
    ).toHaveBeenCalledExactlyOnceWith(
      '123',
      'lite',
      { repositoryNames: ['main'] },
      expect.any(AbortSignal)
    );
    expect(githubFetch).toHaveBeenCalledTimes(2);
    expect(githubFetch.mock.calls[0]?.[0]).toEqual(
      new URL('https://api.github.com/installation/repositories?per_page=100&page=2')
    );
    expect(githubFetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer primary-token',
    });
  });

  it.each(['list', 'resolve'] as const)(
    'uses independent provider timeouts for each upstream call during %s',
    async operation => {
      const timeouts = vi.spyOn(AbortSignal, 'timeout');
      const rpc = createEntrypoint();
      if (operation === 'list') {
        githubFetch.mockResolvedValueOnce(inventory([additional], 101));
        githubFetch.mockResolvedValueOnce(inventory([primary]));
        await expect(
          rpc.listHostedWorkspaceGitHubRepositories({ ...scope, page: 2 })
        ).resolves.toMatchObject({ success: true });
      } else {
        githubFetch.mockResolvedValueOnce(inventory([primary]));
        githubFetch.mockResolvedValueOnce(inventory([additional]));
        await expect(
          rpc.resolveHostedWorkspaceGitHubRepositories({ ...scope, additionalRepositoryIds: [202] })
        ).resolves.toMatchObject({ success: true });
      }

      const tokenSignals = [
        ...vi.mocked(GitHubTokenService.prototype.getToken).mock.calls.map(call => call[2]),
        ...vi
          .mocked(GitHubTokenService.prototype.getFreshTokenForRepositorySelection)
          .mock.calls.map(call => call[3]),
      ];
      const inventorySignals = githubFetch.mock.calls.map(([, init]) => init?.signal);
      const signals = [...tokenSignals, ...inventorySignals];
      expect(timeouts.mock.calls).toEqual([[4_000], [4_000], [4_000], [4_000]]);
      expect(new Set(signals).size).toBe(4);
      expect(new Set(signals)).toEqual(new Set(timeouts.mock.results.map(result => result.value)));
    }
  );

  it('does not expose the catalog when the previously installed primary is gone', async () => {
    githubFetch.mockResolvedValueOnce(inventory([additional]));
    githubFetch.mockResolvedValueOnce(inventory([]));

    await expect(
      createEntrypoint().listHostedWorkspaceGitHubRepositories({ ...scope, page: 1 })
    ).resolves.toEqual({
      success: false,
      reason: 'repository_unavailable',
    });
  });

  it.each([{ archived: true }, { disabled: true }])(
    'rejects an unavailable primary before verifying additional IDs (%j)',
    async flags => {
      githubFetch.mockResolvedValueOnce(inventory([repo(101, 'Org/Main', flags)]));
      await expect(
        createEntrypoint().resolveHostedWorkspaceGitHubRepositories({
          ...scope,
          additionalRepositoryIds: [202],
        })
      ).resolves.toEqual({
        success: false,
        reason: 'repository_unavailable',
      });
      expect(
        GitHubTokenService.prototype.getFreshTokenForRepositorySelection
      ).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['list', 'resolve'] as const)(
    'repairs an exact pinned organization login after a GitHub rename during %s',
    async operation => {
      const lookups = vi.mocked(
        InstallationLookupService.prototype.findHostedWorkspaceInstallation
      );
      lookups.mockResolvedValueOnce({ success: false, reason: 'integration_mismatch' });
      vi.mocked(InstallationLookupService.prototype.findRefreshCandidates).mockResolvedValue({
        success: true,
        candidates: [
          {
            integrationId: scope.integrationId,
            installationId: installation.installationId,
            githubAppType: installation.githubAppType,
            accountLogin: 'OldOrg',
          },
        ],
      });
      const refresh = vi
        .spyOn(GitHubTokenService.prototype, 'refreshInstallationAccountLoginIfDue')
        .mockResolvedValue('Org');
      const update = vi
        .spyOn(InstallationLookupService.prototype, 'updateAccountLogin')
        .mockResolvedValue(true);
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const rpc = createEntrypoint();
      if (operation === 'list') {
        githubFetch.mockResolvedValueOnce(inventory([primary, additional]));
        await expect(
          rpc.listHostedWorkspaceGitHubRepositories({ ...scope, page: 1 })
        ).resolves.toEqual({
          success: true,
          repositories: [{ id: 202, fullName: 'Org/Tools', private: true }],
        });
      } else {
        githubFetch.mockResolvedValueOnce(inventory([primary]));
        githubFetch.mockResolvedValueOnce(inventory([additional]));
        await expect(
          rpc.resolveHostedWorkspaceGitHubRepositories({ ...scope, additionalRepositoryIds: [202] })
        ).resolves.toEqual({
          success: true,
          primary: { id: 101, fullName: 'Org/Main' },
          additional: [{ id: 202, fullName: 'Org/Tools' }],
        });
      }

      expect(
        InstallationLookupService.prototype.findRefreshCandidates
      ).toHaveBeenCalledExactlyOnceWith({ ...lookupScope, accessPurpose: 'workflow' }, 'managed');
      expect(refresh).toHaveBeenCalledExactlyOnceWith('123', 'lite', 4_000);
      expect(update).toHaveBeenCalledExactlyOnceWith(scope.integrationId, 'Org');
      expect(lookups.mock.calls).toEqual([[lookupScope], [lookupScope]]);
    }
  );

  it('denies a wrong pin without refreshing or using any other installation', async () => {
    const wrongPin = '00000000-0000-4000-8000-000000000003';
    vi.mocked(
      InstallationLookupService.prototype.findHostedWorkspaceInstallation
    ).mockResolvedValue({ success: false, reason: 'integration_mismatch' });
    const refresh = vi.spyOn(GitHubTokenService.prototype, 'refreshInstallationAccountLoginIfDue');
    const rpc = createEntrypoint();
    for (const result of await Promise.all([
      rpc.listHostedWorkspaceGitHubRepositories({ ...scope, integrationId: wrongPin, page: 1 }),
      rpc.resolveHostedWorkspaceGitHubRepositories({
        ...scope,
        integrationId: wrongPin,
        additionalRepositoryIds: [202],
      }),
    ])) {
      expect(result).toEqual({ success: false, reason: 'access_denied' });
    }
    const repairScope = {
      ...lookupScope,
      expectedIntegrationId: wrongPin,
      accessPurpose: 'workflow',
    };
    expect(vi.mocked(InstallationLookupService.prototype.findRefreshCandidates).mock.calls).toEqual(
      [
        [repairScope, 'managed'],
        [repairScope, 'managed'],
      ]
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(githubFetch).not.toHaveBeenCalled();
    expect(GitHubTokenService.prototype.getFreshTokenForRepositorySelection).not.toHaveBeenCalled();
    expect(GitHubTokenService.prototype.getToken).not.toHaveBeenCalled();
  });

  it('does not attempt login repair when the primary is outside stored repository access', async () => {
    vi.mocked(
      InstallationLookupService.prototype.findHostedWorkspaceInstallation
    ).mockResolvedValue({ success: false, reason: 'repository_not_installed' });

    await expect(
      createEntrypoint().listHostedWorkspaceGitHubRepositories({ ...scope, page: 1 })
    ).resolves.toEqual({ success: false, reason: 'repository_unavailable' });
    expect(InstallationLookupService.prototype.findRefreshCandidates).not.toHaveBeenCalled();
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it('returns the current primary ID for prepare without minting an additional or broad token', async () => {
    const rpc = createEntrypoint();
    githubFetch.mockResolvedValueOnce(inventory([primary]));
    githubFetch.mockResolvedValueOnce(inventory([repo(999, 'Org/Main')]));
    for (const id of [101, 999]) {
      await expect(
        rpc.resolveHostedWorkspaceGitHubRepositories({ ...scope, additionalRepositoryIds: [] })
      ).resolves.toEqual({
        success: true,
        primary: { id, fullName: 'Org/Main' },
        additional: [],
      });
    }
    expect(GitHubTokenService.prototype.getToken).not.toHaveBeenCalled();
    expect(GitHubTokenService.prototype.getFreshTokenForRepositorySelection).toHaveBeenCalledTimes(
      2
    );
    expect(
      GitHubTokenService.prototype.getFreshTokenForRepositorySelection
    ).toHaveBeenNthCalledWith(
      2,
      '123',
      'lite',
      { repositoryNames: ['main'] },
      expect.any(AbortSignal)
    );
  });

  it('resolves the entire requested ID set to canonical locators in the requested order', async () => {
    githubFetch.mockResolvedValueOnce(inventory([primary]));
    githubFetch.mockResolvedValueOnce(inventory([additional, repo(303, 'Org/Library')]));
    await expect(
      createEntrypoint().resolveHostedWorkspaceGitHubRepositories({
        ...scope,
        additionalRepositoryIds: [303, 101, 202],
      })
    ).resolves.toEqual({
      success: true,
      primary: { id: 101, fullName: 'Org/Main' },
      additional: [
        { id: 303, fullName: 'Org/Library' },
        { id: 101, fullName: 'Org/Main' },
        { id: 202, fullName: 'Org/Tools' },
      ],
    });
    expect(
      GitHubTokenService.prototype.getFreshTokenForRepositorySelection
    ).toHaveBeenNthCalledWith(
      2,
      '123',
      'lite',
      { repositoryIds: [303, 202] },
      expect.any(AbortSignal)
    );
  });

  it.each([
    ['missing or outside the exact installation', []],
    ['archived', [repo(202, 'Org/Tools', { archived: true })]],
    ['disabled', [repo(202, 'Org/Tools', { disabled: true })]],
    ['transferred to another owner', [repo(202, 'Other/Tools')]],
    ['replaced with a different ID', [repo(203, 'Org/Tools')]],
    ['renamed to the primary locator between reads', [repo(202, 'Org/Main')]],
  ] as const)('fails the entire set if an additional repository is %s', async (_name, rows) => {
    githubFetch.mockResolvedValueOnce(inventory([primary]));
    githubFetch.mockResolvedValueOnce(inventory([repo(303, 'Org/Library'), ...rows]));
    await expect(
      createEntrypoint().resolveHostedWorkspaceGitHubRepositories({
        ...scope,
        additionalRepositoryIds: [303, 202],
      })
    ).resolves.toEqual({
      success: false,
      reason: 'repository_unavailable',
    });
  });

  it('fails closed when a targeted token cannot be issued for a selected repository', async () => {
    githubFetch.mockResolvedValueOnce(inventory([primary]));
    vi.mocked(GitHubTokenService.prototype.getFreshTokenForRepositorySelection)
      .mockResolvedValueOnce('primary-token')
      .mockRejectedValueOnce(new GitHubTokenGenerationError(422, 'repository_not_installed'));
    await expect(
      createEntrypoint().resolveHostedWorkspaceGitHubRepositories({
        ...scope,
        additionalRepositoryIds: [202],
      })
    ).resolves.toEqual({
      success: false,
      reason: 'repository_unavailable',
    });
  });

  it.each([0, 101, 1.5])('rejects page %s before any lookup or GitHub request', async page => {
    await expect(
      createEntrypoint().listHostedWorkspaceGitHubRepositories({ ...scope, page })
    ).resolves.toEqual({
      success: false,
      reason: 'repository_unavailable',
    });
    expect(
      InstallationLookupService.prototype.findHostedWorkspaceInstallation
    ).not.toHaveBeenCalled();
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it.each(
    [[202, 202], [0], [Number.MAX_SAFE_INTEGER + 1], [1, 2, 3, 4, 5, 6]].map(ids => ({ ids }))
  )('rejects malformed or oversized selection $ids before any lookup', async ({ ids }) => {
    await expect(
      createEntrypoint().resolveHostedWorkspaceGitHubRepositories({
        ...scope,
        additionalRepositoryIds: ids,
      })
    ).resolves.toEqual({
      success: false,
      reason: 'repository_unavailable',
    });
    expect(
      InstallationLookupService.prototype.findHostedWorkspaceInstallation
    ).not.toHaveBeenCalled();
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'provider failure',
      () => Response.json({ message: 'secret upstream detail' }, { status: 503 }),
    ],
    [
      'unknown visibility or availability',
      () => inventory([repo(101, 'Org/Main', { disabled: null })]),
    ],
    [
      'oversized provider payload',
      () =>
        Response.json({
          repositories: [primary],
          total_count: 1,
          padding: 'x'.repeat(1024 * 1024),
        }),
    ],
    ['nonterminal page at the cap', () => inventory([primary], 10_001)],
  ] as const)('fails closed without exposing provider data on %s', async (_name, response) => {
    githubFetch.mockResolvedValueOnce(response());
    await expect(
      createEntrypoint().listHostedWorkspaceGitHubRepositories({ ...scope, page: 100 })
    ).resolves.toEqual({
      success: false,
      reason: 'temporarily_unavailable',
    });
  });
});
