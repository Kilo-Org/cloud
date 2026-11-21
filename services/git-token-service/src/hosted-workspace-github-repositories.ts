import { z } from 'zod';
import { GitHubTokenGenerationError, type GitHubTokenService } from './github-token-service.js';
import type {
  HostedWorkspaceInstallation,
  InstallationLookupService,
} from './installation-lookup-service.js';
import { readBoundedJsonBody } from './lib/bounded-read.js';

const PAGE_SIZE = 100;
const MAX_PAGE = 100;
const MAX_PAGE_BYTES = 1024 * 1024;
const GITHUB_TIMEOUT_MS = 10_000;
const fullNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const repositoryIdSchema = z.int().positive();
const pageSchema = z.int().min(1).max(MAX_PAGE);
const additionalIdsSchema = z.array(repositoryIdSchema).max(5);
const scopeSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.uuid(),
  integrationId: z.uuid(),
  primaryRepo: fullNameSchema,
});
const repositorySchema = z.object({
  id: repositoryIdSchema,
  full_name: fullNameSchema,
  private: z.boolean(),
  archived: z.boolean(),
  disabled: z.boolean(),
});
const inventorySchema = z.object({
  repositories: z.array(repositorySchema).max(PAGE_SIZE),
  total_count: z.int().nonnegative(),
});

type Repository = z.infer<typeof repositorySchema>;
type Scope = z.infer<typeof scopeSchema>;
type RepositoryIdentity = { id: number; fullName: string };
type Failure = {
  success: false;
  reason: 'access_denied' | 'repository_unavailable' | 'temporarily_unavailable';
};

export type ListHostedWorkspaceGitHubRepositoriesParams = Scope & { page: number };
export type ResolveHostedWorkspaceGitHubRepositoriesParams = Scope & {
  additionalRepositoryIds: number[];
};
export type ListHostedWorkspaceGitHubRepositoriesResult =
  | {
      success: true;
      repositories: (RepositoryIdentity & { private: boolean })[];
      nextPage?: number;
    }
  | Failure;
export type ResolveHostedWorkspaceGitHubRepositoriesResult =
  | { success: true; primary: RepositoryIdentity; additional: RepositoryIdentity[] }
  | Failure;

function unavailable(reason: Failure['reason']): Failure {
  return { success: false, reason };
}

function isEligible(repository: Repository, installation: HostedWorkspaceInstallation): boolean {
  const name = repository.full_name.toLowerCase();
  return (
    !repository.archived &&
    !repository.disabled &&
    name.startsWith(`${installation.accountLogin.toLowerCase()}/`) &&
    (installation.selectedRepositories === null || installation.selectedRepositories.has(name))
  );
}

function identity(repository: Repository): RepositoryIdentity {
  return { id: repository.id, fullName: repository.full_name };
}

function findPrimary(repositories: Repository[], primaryRepo: string): Repository | undefined {
  return repositories.find(repo => repo.full_name.toLowerCase() === primaryRepo.toLowerCase());
}

export class HostedWorkspaceGitHubRepositories {
  constructor(
    private readonly lookup: Pick<InstallationLookupService, 'findHostedWorkspaceInstallation'>,
    private readonly tokens: Pick<
      GitHubTokenService,
      'getToken' | 'getFreshTokenForRepositorySelection'
    >
  ) {}

  async list(
    params: ListHostedWorkspaceGitHubRepositoriesParams
  ): Promise<ListHostedWorkspaceGitHubRepositoriesResult> {
    const scope = scopeSchema.safeParse(params);
    if (!scope.success) return unavailable('access_denied');
    const page = pageSchema.safeParse(params.page);
    if (!page.success) return unavailable('repository_unavailable');

    return this.withInstallation(scope.data, async (installation, signal) => {
      const token = await this.tokens.getToken(
        installation.installationId,
        installation.githubAppType,
        signal
      );
      const { repositories, hasNextPage } = await this.readPage(token, page.data, signal);
      const primary =
        findPrimary(repositories, scope.data.primaryRepo) ??
        (await this.readPrimary(installation, scope.data.primaryRepo, signal));
      if (!primary || !isEligible(primary, installation))
        return unavailable('repository_unavailable');
      if (hasNextPage && page.data === MAX_PAGE) return unavailable('temporarily_unavailable');

      return {
        success: true,
        repositories: repositories
          .filter(
            repo =>
              repo.id !== primary.id &&
              repo.full_name.toLowerCase() !== primary.full_name.toLowerCase() &&
              isEligible(repo, installation)
          )
          .map(repo => ({ ...identity(repo), private: repo.private })),
        ...(hasNextPage ? { nextPage: page.data + 1 } : {}),
      };
    });
  }

  async resolve(
    params: ResolveHostedWorkspaceGitHubRepositoriesParams
  ): Promise<ResolveHostedWorkspaceGitHubRepositoriesResult> {
    const scope = scopeSchema.safeParse(params);
    if (!scope.success) return unavailable('access_denied');
    const ids = additionalIdsSchema.safeParse(params.additionalRepositoryIds);
    if (!ids.success || new Set(ids.data).size !== ids.data.length) {
      return unavailable('repository_unavailable');
    }

    return this.withInstallation(scope.data, async (installation, signal) => {
      const primary = await this.readPrimary(installation, scope.data.primaryRepo, signal);
      if (!primary || !isEligible(primary, installation)) {
        return unavailable('repository_unavailable');
      }
      // Admission reports a duplicate checkout using the primary's resolved ID.
      const otherIds = ids.data.filter(id => id !== primary.id);
      if (otherIds.length === 0) {
        return {
          success: true,
          primary: identity(primary),
          additional: ids.data.length === 0 ? [] : [identity(primary)],
        };
      }

      const token = await this.tokens.getFreshTokenForRepositorySelection(
        installation.installationId,
        installation.githubAppType,
        { repositoryIds: otherIds },
        signal
      );
      const { repositories, hasNextPage } = await this.readPage(token, 1, signal);
      const additional: RepositoryIdentity[] = [];
      for (const id of ids.data) {
        const repo =
          id === primary.id ? primary : repositories.find(repository => repository.id === id);
        if (!repo) {
          return unavailable(hasNextPage ? 'temporarily_unavailable' : 'repository_unavailable');
        }
        if (
          !isEligible(repo, installation) ||
          (repo.id !== primary.id &&
            repo.full_name.toLowerCase() === primary.full_name.toLowerCase())
        ) {
          return unavailable('repository_unavailable');
        }
        additional.push(identity(repo));
      }
      return { success: true, primary: identity(primary), additional };
    });
  }

  private async withInstallation<T>(
    scope: Scope,
    action: (installation: HostedWorkspaceInstallation, signal: AbortSignal) => Promise<T | Failure>
  ): Promise<T | Failure> {
    try {
      const installation = await this.lookup.findHostedWorkspaceInstallation({
        userId: scope.userId,
        orgId: scope.organizationId,
        expectedIntegrationId: scope.integrationId,
        githubRepo: scope.primaryRepo,
      });
      if (!installation.success) {
        if (installation.reason === 'database_not_configured')
          return unavailable('temporarily_unavailable');
        if (installation.reason === 'repository_not_installed')
          return unavailable('repository_unavailable');
        return unavailable('access_denied');
      }
      return await action(installation, AbortSignal.timeout(GITHUB_TIMEOUT_MS));
    } catch (error) {
      if (error instanceof GitHubTokenGenerationError) {
        if (error.reason === 'no_installation_found') return unavailable('access_denied');
        if (error.reason === 'repository_not_installed')
          return unavailable('repository_unavailable');
      }
      console.warn('Hosted workspace GitHub repository verification unavailable');
      return unavailable('temporarily_unavailable');
    }
  }

  private async readPrimary(
    installation: HostedWorkspaceInstallation,
    primaryRepo: string,
    signal: AbortSignal
  ): Promise<Repository | undefined> {
    const repoName = primaryRepo.slice(primaryRepo.indexOf('/') + 1);
    const token = await this.tokens.getFreshTokenForRepositorySelection(
      installation.installationId,
      installation.githubAppType,
      { repositoryNames: [repoName] },
      signal
    );
    const { repositories, hasNextPage } = await this.readPage(token, 1, signal);
    const primary = findPrimary(repositories, primaryRepo);
    if (!primary && hasNextPage) throw new Error('Incomplete scoped GitHub primary inventory');
    return primary;
  }

  private async readPage(token: string, page: number, signal: AbortSignal) {
    const url = new URL('https://api.github.com/installation/repositories');
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Kilo-Git-Token-Service',
      },
      cache: 'no-store',
      redirect: 'manual',
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('GitHub installation inventory unavailable');
    }
    const { repositories, total_count } = inventorySchema.parse(
      await readBoundedJsonBody(response.body, MAX_PAGE_BYTES)
    );
    if (
      total_count < repositories.length ||
      new Set(repositories.map(repo => repo.id)).size !== repositories.length ||
      new Set(repositories.map(repo => repo.full_name.toLowerCase())).size !== repositories.length
    ) {
      throw new Error('Invalid GitHub installation inventory');
    }
    return {
      repositories,
      hasNextPage:
        total_count > page * PAGE_SIZE || /;\s*rel="next"/.test(response.headers.get('Link') ?? ''),
    };
  }
}
