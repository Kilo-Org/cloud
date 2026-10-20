import 'server-only';

import { Octokit } from '@octokit/rest';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { user_github_app_tokens, type PlatformIntegration } from '@kilocode/db/schema';
import {
  generateGitHubInstallationToken,
  type CollaboratorPermission,
  type GitHubAppType,
} from '@/lib/integrations/platforms/github/adapter';
import { getGitHubUserAccessToken } from '@/lib/integrations/platforms/github/user-token-client';
import { isKiloReviewBotAuthor, normalizeGitHubLogin } from '@/lib/code-reviews/kilo-bot-logins';

/**
 * Server-side intake for the fix-review workflow.
 *
 * The agent that runs the fix session can commit and push, so the set of review
 * comments it may act on is decided here, before its prompt is built: only
 * comments from the account that started the run, from accounts with write
 * access to the repository, or from Kilo's own review bot survive. Comments in
 * a resolved thread, or already answered by the PR author, are dropped as no
 * longer actionable.
 */

export const FIX_REVIEW_COMMENT_BODY_MAX_LENGTH = 4_000;
const COMMENTS_PAGE_SIZE = 100;
const REVIEW_THREADS_MAX_PAGES = 20;

const KNOWN_PERMISSIONS: Record<string, CollaboratorPermission> = {
  admin: 'admin',
  write: 'write',
  read: 'read',
  none: 'none',
};

export type FixReviewComment = {
  id: number;
  authorLogin: string;
  authorType: string;
  authorId: number | null;
  path: string;
  line: number | null;
  body: string;
};

const ReviewThreadsResponseSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          reviewThreads: z.object({
            pageInfo: z.object({
              hasNextPage: z.boolean(),
              endCursor: z.string().nullable(),
            }),
            nodes: z.array(
              z.object({
                isResolved: z.boolean(),
                comments: z.object({
                  nodes: z.array(
                    z.object({
                      databaseId: z.number().nullable(),
                      author: z.object({ login: z.string() }).nullable(),
                    })
                  ),
                }),
              })
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

const REVIEW_THREADS_QUERY = /* GraphQL */ `
  query FixReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            isResolved
            comments(first: 100) {
              nodes {
                databaseId
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
`;

export type FixReviewTarget = {
  owner: string;
  repo: string;
  pullNumber: number;
};

export type FixReviewCommentClient = {
  listComments: () => Promise<FixReviewComment[]>;
  lookupPermission: (login: string) => Promise<CollaboratorPermission | null>;
  listSettledCommentIds: (prAuthor: string) => Promise<ReadonlySet<number>>;
};

function splitRepositoryFullName(repositoryFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repositoryFullName.split('/');
  if (!owner || !repo) {
    throw new Error('Fix-review repository must be owner/repo');
  }
  return { owner, repo };
}

export function createFixReviewCommentClient(
  octokit: Octokit,
  target: FixReviewTarget
): FixReviewCommentClient {
  const { owner, repo, pullNumber } = target;

  return {
    async listComments() {
      const comments: FixReviewComment[] = [];
      for (let page = 1; ; page += 1) {
        const { data } = await octokit.pulls.listReviewComments({
          owner,
          repo,
          pull_number: pullNumber,
          per_page: COMMENTS_PAGE_SIZE,
          page,
        });
        for (const comment of data) {
          comments.push({
            id: comment.id,
            authorLogin: comment.user?.login ?? '',
            authorType: comment.user?.type ?? '',
            authorId: comment.user?.id ?? null,
            path: comment.path,
            line: comment.line ?? null,
            body: comment.body,
          });
        }
        if (data.length < COMMENTS_PAGE_SIZE) return comments;
      }
    },

    async lookupPermission(login) {
      try {
        const { data } = await octokit.repos.getCollaboratorPermissionLevel({
          owner,
          repo,
          username: login,
        });
        const permission = data.permission;
        return KNOWN_PERMISSIONS[permission] ?? null;
      } catch {
        return null;
      }
    },

    async listSettledCommentIds(prAuthor) {
      const normalizedAuthor = normalizeGitHubLogin(prAuthor);
      const settled = new Set<number>();
      let after: string | null = null;
      for (let page = 1; page <= REVIEW_THREADS_MAX_PAGES; page += 1) {
        const response = (await octokit.request('POST /graphql', {
          query: REVIEW_THREADS_QUERY,
          variables: { owner, name: repo, number: pullNumber, after },
        })) as { data: { data?: unknown } };

        const parsed = ReviewThreadsResponseSchema.safeParse(response.data.data);
        const connection = parsed.success
          ? parsed.data.repository?.pullRequest?.reviewThreads
          : undefined;
        if (!connection) {
          throw new Error('GitHub did not return the pull request review threads');
        }

        for (const thread of connection.nodes) {
          const nodes = thread.comments.nodes;
          const authorParticipated = nodes.some(
            node =>
              node.author !== null && normalizeGitHubLogin(node.author.login) === normalizedAuthor
          );
          for (const node of nodes) {
            if (node.databaseId === null) continue;
            const writtenByAuthor =
              node.author !== null && normalizeGitHubLogin(node.author.login) === normalizedAuthor;
            if (thread.isResolved || (authorParticipated && !writtenByAuthor)) {
              settled.add(node.databaseId);
            }
          }
        }

        if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) {
          return settled;
        }
        after = connection.pageInfo.endCursor;
      }
      throw new Error('Pull request has too many review threads to inspect');
    },
  };
}

export async function selectFixReviewComments(input: {
  comments: readonly FixReviewComment[];
  trustedLogins: readonly string[];
  settledCommentIds: ReadonlySet<number>;
  lookupPermission: (login: string) => Promise<CollaboratorPermission | null>;
}): Promise<FixReviewComment[]> {
  const trustedLogins = new Set(
    input.trustedLogins.filter(login => login.length > 0).map(normalizeGitHubLogin)
  );
  const permissionByLogin = new Map<string, Promise<CollaboratorPermission | null>>();

  async function isAuthorized(comment: FixReviewComment): Promise<boolean> {
    if (
      isKiloReviewBotAuthor({
        login: comment.authorLogin,
        type: comment.authorType,
        id: comment.authorId,
      })
    ) {
      return true;
    }
    if (comment.authorLogin.length === 0) return false;
    const loginKey = normalizeGitHubLogin(comment.authorLogin);
    if (trustedLogins.has(loginKey)) return true;

    let permission = permissionByLogin.get(loginKey);
    if (!permission) {
      permission = input.lookupPermission(comment.authorLogin);
      permissionByLogin.set(loginKey, permission);
    }
    const resolved = await permission;
    return resolved === 'admin' || resolved === 'write';
  }

  const candidates = input.comments.filter(comment => !input.settledCommentIds.has(comment.id));
  const authorization = await Promise.all(candidates.map(comment => isAuthorized(comment)));

  return candidates
    .filter((_, index) => authorization[index])
    .map(comment => ({
      ...comment,
      body:
        comment.body.length > FIX_REVIEW_COMMENT_BODY_MAX_LENGTH
          ? `${comment.body.slice(0, FIX_REVIEW_COMMENT_BODY_MAX_LENGTH)}\n[comment truncated]`
          : comment.body,
    }));
}

export type FixReviewSelectionDeps = {
  getInitiatorGitHubLogin: (kiloUserId: string) => Promise<string | null>;
  getUserAccessToken: typeof getGitHubUserAccessToken;
  generateInstallationToken: (
    installationId: string,
    appType: GitHubAppType
  ) => Promise<{ token: string }>;
  createCommentClient: (token: string, target: FixReviewTarget) => FixReviewCommentClient;
};

const defaultDeps: FixReviewSelectionDeps = {
  async getInitiatorGitHubLogin(kiloUserId) {
    const [authorization] = await db
      .select({ login: user_github_app_tokens.github_login })
      .from(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.kilo_user_id, kiloUserId),
          eq(user_github_app_tokens.github_app_type, 'standard')
        )
      )
      .limit(1);
    return authorization?.login ?? null;
  },
  getUserAccessToken: getGitHubUserAccessToken,
  generateInstallationToken: generateGitHubInstallationToken,
  createCommentClient: (token, target) =>
    createFixReviewCommentClient(
      new Octokit({ auth: token, userAgent: 'kilo-fix-review' }),
      target
    ),
};

async function resolveCommentClient(input: {
  repositoryFullName: string;
  pullNumber: number;
  initiatorKiloUserId: string;
  integration: Pick<PlatformIntegration, 'platform_installation_id' | 'github_app_type'> | null;
  deps: FixReviewSelectionDeps;
}): Promise<{ client: FixReviewCommentClient; initiatorGitHubLogin: string | null }> {
  const { owner, repo } = splitRepositoryFullName(input.repositoryFullName);
  const initiatorGitHubLogin = await input.deps.getInitiatorGitHubLogin(input.initiatorKiloUserId);
  const target = { owner, repo, pullNumber: input.pullNumber };
  const installationId = input.integration?.platform_installation_id;

  if (installationId) {
    const appType: GitHubAppType = input.integration?.github_app_type ?? 'standard';
    const { token } = await input.deps.generateInstallationToken(installationId, appType);
    return {
      client: input.deps.createCommentClient(token, target),
      initiatorGitHubLogin,
    };
  }

  const credential = await input.deps.getUserAccessToken(input.initiatorKiloUserId, {
    op: 'fetch',
  });
  if (credential.status !== 'connected') {
    throw new Error('No GitHub credential available to verify review comments');
  }
  return {
    client: input.deps.createCommentClient(credential.credential.token, target),
    initiatorGitHubLogin: initiatorGitHubLogin ?? credential.credential.githubLogin,
  };
}

/**
 * Reads the PR's review comments with a credential the server controls and
 * returns only the comments the fix session may act on.
 *
 * Throws when the credential or the GitHub response cannot be established, so
 * the caller can refuse to start a session it cannot verify.
 */
export async function selectFixReviewCommentsForReview(input: {
  repositoryFullName: string;
  pullNumber: number;
  prAuthor: string;
  initiatorKiloUserId: string;
  integration: Pick<PlatformIntegration, 'platform_installation_id' | 'github_app_type'> | null;
  deps?: Partial<FixReviewSelectionDeps>;
}): Promise<FixReviewComment[]> {
  const deps: FixReviewSelectionDeps = { ...defaultDeps, ...input.deps };
  const { client, initiatorGitHubLogin } = await resolveCommentClient({ ...input, deps });

  const [comments, settledCommentIds] = await Promise.all([
    client.listComments(),
    client.listSettledCommentIds(input.prAuthor),
  ]);

  return selectFixReviewComments({
    comments,
    trustedLogins: initiatorGitHubLogin ? [initiatorGitHubLogin] : [],
    settledCommentIds,
    lookupPermission: login => client.lookupPermission(login),
  });
}
