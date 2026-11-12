import { sha256Hex } from '@kilocode/worker-utils/sha256';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  githubRepositoryPermissions,
  githubPermissionsAreRestricted,
  type RepositoryAccessMode,
  type WorkspaceGitHubRepositoryAccess,
} from '@kilocode/worker-utils/workspace-repository-access';
import {
  githubTaskGrantSchema,
  githubTaskScopeSchema,
  type GitHubTaskCheck,
  type GitHubTaskGrant,
  type GitHubTaskScope,
} from '@kilocode/worker-utils/github-task-grant';

const repositorySchema = z.object({
  id: z.number().int().positive().safe(),
  node_id: z.string().min(1),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
  permissions: z.object({ push: z.boolean().optional() }).optional(),
});
export type GitHubRepositoryScope = {
  owner: string;
  repositoryIds: number[];
};
export type GitHubTaskResourceFailure =
  | 'repository_mismatch'
  | 'ref_not_allowed'
  | 'operation_not_allowed'
  | 'source_unavailable'
  | 'invalid_task_scope'
  | 'repository_access_required'
  | 'separate_repository_requests_required'
  | 'authorization_unavailable';
export class GitHubTaskResourceError extends Error {
  constructor(readonly reason: GitHubTaskResourceFailure) {
    super(reason);
    this.name = 'GitHubTaskResourceError';
  }
}
type ResourceEnv = Pick<CloudflareEnv, 'GITHUB_APP_CLIENT_ID' | 'GITHUB_APP_CLIENT_SECRET'> & {
  GITHUB_API_BASE_URL?: string;
  TOKEN_CACHE?: Pick<KVNamespace, 'get' | 'put'>;
};

/** Resolves resource identities before any guest request receives upstream authorization. */
export class GitHubTaskResources {
  private readonly root: string;
  constructor(
    private readonly token: string,
    private readonly env: ResourceEnv
  ) {
    this.root = (env.GITHUB_API_BASE_URL?.trim() || 'https://api.github.com').replace(/\/+$/, '');
  }

  private async readJson(response: Response): Promise<unknown> {
    if (!response.body) throw new GitHubTaskResourceError('source_unavailable');
    const stream: ReadableStream<unknown> = response.body;
    const bytes = await readBoundedStream(
      stream.pipeThrough(
        new TransformStream<unknown, Uint8Array>({
          transform(chunk, controller) {
            if (!(chunk instanceof Uint8Array))
              throw new GitHubTaskResourceError('source_unavailable');
            controller.enqueue(chunk);
          },
        })
      ),
      1024 * 1024
    );
    if (!bytes.ok) throw new GitHubTaskResourceError('source_unavailable');
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.bytes)
    );
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    try {
      const response = await fetch(`${this.root}${path}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Kilo-Git-Token-Service',
        },
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GitHubTaskResourceError(
          response.status === 404 ? 'repository_mismatch' : 'source_unavailable'
        );
      }
      return await this.readJson(response);
    } catch (error) {
      if (error instanceof GitHubTaskResourceError) throw error;
      throw new GitHubTaskResourceError('source_unavailable');
    }
  }

  async publicRepository(owner: string, name: string): Promise<void> {
    let value: unknown;
    try {
      value = await this.request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Kilo-Git-Token-Service',
          },
        }
      );
    } catch (error) {
      if (error instanceof GitHubTaskResourceError && error.reason === 'repository_mismatch')
        throw new GitHubTaskResourceError('repository_access_required');
      throw error;
    }
    const repository = repositorySchema.extend({ private: z.literal(false) }).safeParse(value);
    if (
      !repository.success ||
      repository.data.owner.login.toLowerCase() !== owner ||
      repository.data.name.toLowerCase() !== name
    )
      throw new GitHubTaskResourceError('repository_access_required');
  }

  async userSubjectId(): Promise<string> {
    const user = z
      .object({ id: z.number().int().positive().safe() })
      .safeParse(await this.request('/user'));
    if (!user.success) throw new GitHubTaskResourceError('authorization_unavailable');
    return String(user.data.id);
  }

  async repository(owner: string, name: string) {
    const value = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    );
    const parsed = repositorySchema.safeParse(value);
    if (!parsed.success) throw new GitHubTaskResourceError('source_unavailable');
    if (parsed.data.owner.login.toLowerCase() !== owner || parsed.data.name.toLowerCase() !== name)
      throw new GitHubTaskResourceError('repository_mismatch');
    return parsed.data;
  }

  async issue(owner: string, name: string, input: GitHubTaskScope): Promise<GitHubTaskGrant> {
    const scope = githubTaskScopeSchema.safeParse(input);
    if (!scope.success) throw new GitHubTaskResourceError('invalid_task_scope');
    const repository = await this.repository(owner, name);
    if (scope.data.repositoryId !== undefined && repository.id !== scope.data.repositoryId)
      throw new GitHubTaskResourceError('repository_mismatch');
    return githubTaskGrantSchema.parse({
      revision: 1,
      scopeId: scope.data.scopeId,
      ...(scope.data.taskRef ? { taskRef: scope.data.taskRef } : {}),
      ...(scope.data.mode ? { mode: scope.data.mode } : {}),
      repository: { id: repository.id, nodeId: repository.node_id, owner, name },
    });
  }

  async verify(
    grant: GitHubTaskGrant,
    checks: GitHubTaskCheck[],
    approved: readonly WorkspaceGitHubRepositoryAccess[] = []
  ): Promise<GitHubRepositoryScope> {
    const repository = await this.repository(grant.repository.owner, grant.repository.name);
    if (repository.id !== grant.repository.id || repository.node_id !== grant.repository.nodeId)
      throw new GitHubTaskResourceError('repository_mismatch');
    const repositoryIds = new Set([repository.id]);
    for (const check of checks) {
      if (check.kind === 'owner-read') continue;
      if (check.kind === 'repository-read') {
        const selected = approved.find(
          repo => repo.owner === check.owner && repo.name === check.name
        );
        if (selected) {
          if (selected.owner !== grant.repository.owner)
            throw new GitHubTaskResourceError('separate_repository_requests_required');
          const resolved = await this.repository(check.owner, check.name);
          if (resolved.id !== selected.repositoryId || resolved.node_id !== selected.nodeId)
            throw new GitHubTaskResourceError('repository_access_required');
          repositoryIds.add(resolved.id);
        } else {
          // Never use the connected identity to determine whether another owner's repository is public.
          let value: unknown;
          try {
            value = await this.request(
              `/repos/${encodeURIComponent(check.owner)}/${encodeURIComponent(check.name)}`,
              {
                headers: {
                  Accept: 'application/vnd.github+json',
                  'User-Agent': 'Kilo-Git-Token-Service',
                },
              }
            );
          } catch (error) {
            if (error instanceof GitHubTaskResourceError && error.reason === 'repository_mismatch')
              throw new GitHubTaskResourceError('repository_access_required');
            throw error;
          }
          const publicRepository = repositorySchema
            .extend({ private: z.literal(false) })
            .safeParse(value);
          if (
            !publicRepository.success ||
            publicRepository.data.owner.login.toLowerCase() !== check.owner ||
            publicRepository.data.name.toLowerCase() !== check.name
          )
            throw new GitHubTaskResourceError('repository_access_required');
        }
      } else {
        await this.verifyNode(grant, check);
      }
    }
    return {
      owner: grant.repository.owner,
      repositoryIds: [...repositoryIds],
    };
  }

  private async verifyNode(
    grant: GitHubTaskGrant,
    check: Extract<GitHubTaskCheck, { nodeId: string }>
  ): Promise<void> {
    const value = await this.request('/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Kilo-Git-Token-Service',
      },
      body: JSON.stringify({
        query:
          'query($id:ID!){node(id:$id){__typename ... on PullRequest{repository{databaseId}} ... on Issue{repository{databaseId}}}}',
        variables: { id: check.nodeId },
      }),
    });
    const parsed = z
      .object({
        data: z.object({
          node: z.object({
            __typename: z.enum(['PullRequest', 'Issue']),
            repository: z.object({ databaseId: z.number().int().positive() }),
          }),
        }),
      })
      .safeParse(value);
    if (
      !parsed.success ||
      parsed.data.data.node.repository.databaseId !== grant.repository.id ||
      (check.kind === 'repository-pull-request-node' &&
        parsed.data.data.node.__typename !== 'PullRequest') ||
      (check.kind === 'repository-issue-node' && parsed.data.data.node.__typename !== 'Issue')
    )
      throw new GitHubTaskResourceError('operation_not_allowed');
  }

  /** GitHub limits the token to one owner, even when the parent identity spans multiple installations. */
  async scopeUserToken(
    scope: GitHubRepositoryScope,
    mode: RepositoryAccessMode = 'contribute'
  ): Promise<string> {
    if (!this.env.GITHUB_APP_CLIENT_ID || !this.env.GITHUB_APP_CLIENT_SECRET)
      throw new GitHubTaskResourceError('source_unavailable');
    if (!scope.repositoryIds?.length)
      throw new GitHubTaskResourceError('authorization_unavailable');
    const ids = [...new Set(scope.repositoryIds)].sort((left, right) => left - right);
    if (ids.length !== scope.repositoryIds.length)
      throw new GitHubTaskResourceError('authorization_unavailable');
    const cacheKey = `github-workspace-scoped:v1:${await sha256Hex(JSON.stringify({ identity: await sha256Hex(this.token), owner: scope.owner, ids, permissions: githubRepositoryPermissions(mode) }))}`;
    if (this.env.TOKEN_CACHE) {
      const cached = z
        .object({ token: z.string().min(1), expiresAt: z.number().positive() })
        .safeParse(await this.env.TOKEN_CACHE.get(cacheKey, 'json'));
      if (cached.success && cached.data.expiresAt > Date.now() + 60_000) return cached.data.token;
    }
    const basic = Buffer.from(
      `${this.env.GITHUB_APP_CLIENT_ID}:${this.env.GITHUB_APP_CLIENT_SECRET}`
    ).toString('base64');
    const value = await this.request(
      `/applications/${encodeURIComponent(this.env.GITHUB_APP_CLIENT_ID)}/token/scoped`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Kilo-Git-Token-Service',
        },
        body: JSON.stringify({
          access_token: this.token,
          target: scope.owner,
          repository_ids: scope.repositoryIds,
          permissions: githubRepositoryPermissions(mode),
        }),
      }
    );
    const parsed = z
      .object({
        token: z.string().min(1),
        expires_at: z.string().optional(),
        installation: z.object({
          id: z.number().int().positive(),
          repository_selection: z.literal('selected'),
          permissions: z.unknown(),
        }),
      })
      .safeParse(value);
    if (
      !parsed.success ||
      !githubPermissionsAreRestricted(parsed.data.installation.permissions, mode)
    )
      throw new GitHubTaskResourceError('authorization_unavailable');
    const issuedIds: number[] = [];
    for (let page = 1; page <= Math.ceil(ids.length / 100); page += 1) {
      const selected = z
        .object({
          total_count: z.number().int().nonnegative(),
          repositories: z.array(z.object({ id: z.number().int().positive().safe() })),
        })
        .safeParse(
          await this.request(
            `/user/installations/${parsed.data.installation.id}/repositories?per_page=100${page > 1 ? `&page=${page}` : ''}`,
            {
              headers: {
                Authorization: `Bearer ${parsed.data.token}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'Kilo-Git-Token-Service',
              },
            }
          )
        );
      if (!selected.success || selected.data.total_count !== ids.length)
        throw new GitHubTaskResourceError('authorization_unavailable');
      issuedIds.push(...selected.data.repositories.map(repo => repo.id));
    }
    if (
      issuedIds.length !== ids.length ||
      new Set(issuedIds).size !== ids.length ||
      issuedIds.some(id => !ids.includes(id))
    )
      throw new GitHubTaskResourceError('authorization_unavailable');
    if (parsed.data.expires_at !== undefined) {
      const expiresAt = Date.parse(parsed.data.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
        throw new GitHubTaskResourceError('authorization_unavailable');
      const expirationTtl = Math.min(1800, Math.floor((expiresAt - Date.now()) / 1000));
      if (this.env.TOKEN_CACHE && expirationTtl >= 60)
        await this.env.TOKEN_CACHE.put(
          cacheKey,
          JSON.stringify({ token: parsed.data.token, expiresAt }),
          { expirationTtl }
        );
    }
    return parsed.data.token;
  }
}
