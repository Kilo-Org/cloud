import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
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
});
export type GitHubRepositoryScope = {
  owner: string;
  // An omitted list selects the owner's installation, never every user installation.
  repositoryIds?: number[];
};
export type GitHubTaskResourceFailure =
  | 'repository_mismatch'
  | 'ref_not_allowed'
  | 'operation_not_allowed'
  | 'source_unavailable'
  | 'invalid_task_scope';
export class GitHubTaskResourceError extends Error {
  constructor(readonly reason: GitHubTaskResourceFailure) {
    super(reason);
    this.name = 'GitHubTaskResourceError';
  }
}
type ResourceEnv = Pick<CloudflareEnv, 'GITHUB_APP_CLIENT_ID' | 'GITHUB_APP_CLIENT_SECRET'> & {
  GITHUB_API_BASE_URL?: string;
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
      taskRef: scope.data.taskRef,
      repository: { id: repository.id, nodeId: repository.node_id, owner, name },
    });
  }

  async verify(grant: GitHubTaskGrant, checks: GitHubTaskCheck[]): Promise<GitHubRepositoryScope> {
    const repository = await this.repository(grant.repository.owner, grant.repository.name);
    if (repository.id !== grant.repository.id || repository.node_id !== grant.repository.nodeId)
      throw new GitHubTaskResourceError('repository_mismatch');
    const repositoryIds = new Set([repository.id]);
    for (const check of checks) {
      if (check.kind === 'owner-read') continue;
      if (check.kind === 'repository-read') {
        if (check.owner === grant.repository.owner) {
          repositoryIds.add((await this.repository(check.owner, check.name)).id);
        } else {
          // Never use the connected identity to determine whether another owner's repository is public.
          const value = await this.request(
            `/repos/${encodeURIComponent(check.owner)}/${encodeURIComponent(check.name)}`,
            {
              headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'Kilo-Git-Token-Service',
              },
            }
          );
          const publicRepository = repositorySchema
            .extend({ private: z.literal(false) })
            .safeParse(value);
          if (
            !publicRepository.success ||
            publicRepository.data.owner.login.toLowerCase() !== check.owner ||
            publicRepository.data.name.toLowerCase() !== check.name
          )
            throw new GitHubTaskResourceError('repository_mismatch');
        }
      } else {
        await this.verifyNode(grant, check);
      }
    }
    return {
      owner: grant.repository.owner,
      ...(checks.some(check => check.kind === 'owner-read')
        ? {}
        : { repositoryIds: [...repositoryIds] }),
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
  async scopeUserToken(scope: GitHubRepositoryScope): Promise<string> {
    if (!this.env.GITHUB_APP_CLIENT_ID || !this.env.GITHUB_APP_CLIENT_SECRET)
      throw new GitHubTaskResourceError('source_unavailable');
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
          ...(scope.repositoryIds ? { repository_ids: scope.repositoryIds } : {}),
        }),
      }
    );
    const parsed = z
      .object({
        token: z.string().min(1),
        installation: z.object({
          repository_selection: scope.repositoryIds
            ? z.literal('selected')
            : z.enum(['all', 'selected']),
        }),
      })
      .safeParse(value);
    if (!parsed.success) throw new GitHubTaskResourceError('source_unavailable');
    return parsed.data.token;
  }
}
