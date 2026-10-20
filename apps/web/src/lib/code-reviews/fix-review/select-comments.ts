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
export const FIX_REVIEW_MAX_COMMENTS = 20;
export const FIX_REVIEW_TOTAL_BODY_MAX_LENGTH = 40_000;
const COMMENTS_PAGE_SIZE = 100;
const REVIEW_THREADS_MAX_PAGES = 20;
const THREAD_COMMENTS_MAX_PAGES = 20;

const KNOWN_PERMISSIONS: Record<string, CollaboratorPermission> = {
  admin: 'admin',
  write: 'write',
  read: 'read',
  none: 'none',
};

export type FixReviewComment = {
  id: number;
  inReplyToId: number | null;
  authorLogin: string;
  authorType: string;
  authorId: number | null;
  path: string;
  line: number | null;
  body: string;
};

const ThreadCommentSchema = z.object({
  databaseId: z.number().nullable(),
  author: z.object({ login: z.string() }).nullable(),
});

const ThreadCommentsSchema = z.object({
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
  }),
  nodes: z.array(ThreadCommentSchema),
});

const ThreadCommentsResponseSchema = z.object({
  node: z.object({ comments: ThreadCommentsSchema }).nullable(),
});

const ReviewThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  comments: ThreadCommentsSchema,
});

type ReviewThread = z.infer<typeof ReviewThreadSchema>;

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
            nodes: z.array(ReviewThreadSchema),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

const REVIEW_THREAD_COMMENTS_QUERY = /* GraphQL */ `
  query FixReviewThreadComments($threadId: ID!, $after: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
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
`;

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
            id
            isResolved
            comments(first: 100) {
              pageInfo {
                hasNextPage
                endCursor
              }
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
            inReplyToId: comment.in_reply_to_id ?? null,
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
        })) as { data: { data?: unknown; errors?: unknown } };

        if (hasGraphQlErrors(response.data.errors)) {
          throw new Error('GitHub reported errors while reading the review threads');
        }

        const parsed = ReviewThreadsResponseSchema.safeParse(response.data.data);
        const connection = parsed.success
          ? parsed.data.repository?.pullRequest?.reviewThreads
          : undefined;
        if (!connection) {
          throw new Error('GitHub did not return the pull request review threads');
        }

        for (const thread of connection.nodes) {
          const nodes = await readAllThreadComments(octokit, thread);
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

type ThreadComment = z.infer<typeof ThreadCommentSchema>;

function hasGraphQlErrors(errors: unknown): boolean {
  return Array.isArray(errors) && errors.length > 0;
}

async function fetchThreadCommentsPage(
  octokit: Octokit,
  threadId: string,
  after: string | null
): Promise<z.infer<typeof ThreadCommentsSchema>> {
  const response = (await octokit.request('POST /graphql', {
    query: REVIEW_THREAD_COMMENTS_QUERY,
    variables: { threadId, after },
  })) as { data: { data?: unknown; errors?: unknown } };
  if (hasGraphQlErrors(response.data.errors)) {
    throw new Error('GitHub reported errors while reading a review thread');
  }
  const parsed = ThreadCommentsResponseSchema.safeParse(response.data.data);
  const connection = parsed.success ? parsed.data.node?.comments : undefined;
  if (!connection) {
    throw new Error('GitHub did not return the review thread comments');
  }
  return connection;
}

/**
 * The first page of a thread's comments is part of the thread query; a thread
 * with more comments than one page is read to the end so a reply by the PR
 * author cannot be missed.
 */
async function readAllThreadComments(
  octokit: Octokit,
  thread: ReviewThread
): Promise<ThreadComment[]> {
  const comments = [...thread.comments.nodes];
  let page = thread.comments.pageInfo;
  for (let fetched = 1; page.hasNextPage; fetched += 1) {
    if (fetched > THREAD_COMMENTS_MAX_PAGES) {
      throw new Error('Review thread has too many comments to inspect');
    }
    const connection = await fetchThreadCommentsPage(octokit, thread.id, page.endCursor);
    comments.push(...connection.nodes);
    page = connection.pageInfo;
  }
  return comments;
}

export async function selectFixReviewComments(input: {
  comments: readonly FixReviewComment[];
  trustedLogins: readonly string[];
  settledCommentIds: ReadonlySet<number>;
  lookupPermission: (login: string) => Promise<CollaboratorPermission | null>;
}): Promise<FixReviewComment[]> {
  const trustedLogins = new Set(
    input.trustedLogins.map(login => login.trim().toLowerCase()).filter(login => login.length > 0)
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
    const loginKey = comment.authorLogin.trim().toLowerCase();
    if (loginKey.length === 0) return false;
    if (trustedLogins.has(loginKey)) return true;

    let permission = permissionByLogin.get(loginKey);
    if (!permission) {
      permission = input.lookupPermission(comment.authorLogin);
      permissionByLogin.set(loginKey, permission);
    }
    const resolved = await permission;
    return resolved === 'admin' || resolved === 'write';
  }

  // Only top-level comments can ask for a change. Replies carry the discussion
  // around one, including the replies the fix session writes itself.
  const candidates = input.comments.filter(
    comment => comment.inReplyToId === null && !input.settledCommentIds.has(comment.id)
  );
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
    appType: GitHubAppType,
    expectedIntegrationId: string
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
  integration: Pick<
    PlatformIntegration,
    'id' | 'platform_installation_id' | 'github_app_type'
  > | null;
  deps: FixReviewSelectionDeps;
}): Promise<{ client: FixReviewCommentClient; initiatorGitHubLogin: string | null }> {
  const { owner, repo } = splitRepositoryFullName(input.repositoryFullName);
  const initiatorGitHubLogin = await input.deps.getInitiatorGitHubLogin(input.initiatorKiloUserId);
  const target = { owner, repo, pullNumber: input.pullNumber };
  const integration = input.integration;

  if (integration?.platform_installation_id) {
    const appType: GitHubAppType = integration.github_app_type ?? 'standard';
    const { token } = await input.deps.generateInstallationToken(
      integration.platform_installation_id,
      appType,
      integration.id
    );
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

export type FixReviewSelection = {
  comments: FixReviewComment[];
  /** Selected comments beyond the prompt budget, reported to the user. */
  omittedCount: number;
};

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
  integration: Pick<
    PlatformIntegration,
    'id' | 'platform_installation_id' | 'github_app_type'
  > | null;
  deps?: Partial<FixReviewSelectionDeps>;
}): Promise<FixReviewSelection> {
  const deps: FixReviewSelectionDeps = { ...defaultDeps, ...input.deps };
  const { client, initiatorGitHubLogin } = await resolveCommentClient({ ...input, deps });

  const [comments, settledCommentIds] = await Promise.all([
    client.listComments(),
    client.listSettledCommentIds(input.prAuthor),
  ]);

  const selected = await selectFixReviewComments({
    comments,
    trustedLogins: initiatorGitHubLogin ? [initiatorGitHubLogin] : [],
    settledCommentIds,
    lookupPermission: login => client.lookupPermission(login),
  });

  return selectWithinPromptBudget(selected);
}

/**
 * The newest comments are the ones a run was started for, so they are kept
 * first; the oldest are reported as omitted instead of crowding the prompt.
 */
function selectWithinPromptBudget(selected: readonly FixReviewComment[]): FixReviewSelection {
  const kept: FixReviewComment[] = [];
  let budget = FIX_REVIEW_TOTAL_BODY_MAX_LENGTH;
  for (
    let index = selected.length - 1;
    index >= 0 && kept.length < FIX_REVIEW_MAX_COMMENTS;
    index -= 1
  ) {
    const comment = selected[index];
    if (kept.length > 0 && comment.body.length > budget) break;
    kept.push(comment);
    budget -= comment.body.length;
  }
  kept.reverse();
  return { comments: kept, omittedCount: selected.length - kept.length };
}
