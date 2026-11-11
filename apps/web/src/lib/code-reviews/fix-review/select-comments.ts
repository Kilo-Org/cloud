import 'server-only';

import { Octokit } from '@octokit/rest';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { user_github_app_tokens, type PlatformIntegration } from '@kilocode/db/schema';
import { isExpiredProvidedToken } from '@kilocode/db/github-identity';
import {
  generateGitHubInstallationToken,
  type CollaboratorPermission,
  type GitHubAppType,
} from '@/lib/integrations/platforms/github/adapter';
import { lastLinkedPage } from '@/lib/integrations/platforms/github/link-header';
import {
  getGitHubUserAccessToken,
  type GitHubUserAccessTokenConnected,
} from '@/lib/integrations/platforms/github/user-token-client';
import { isKiloReviewBotAuthor, normalizeGitHubLogin } from '@/lib/code-reviews/kilo-bot-logins';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

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
/** Review-comment pages, 100 comments each, that one submission may read. */
export const FIX_REVIEW_COMMENTS_MAX_PAGES = 20;
/** Comment text that one submission may hold while it reads the comment pages. */
export const FIX_REVIEW_COMMENTS_TOTAL_BODY_MAX_LENGTH = 400_000;
const REVIEW_THREADS_MAX_PAGES = 20;
const THREAD_COMMENTS_MAX_PAGES = 20;
/** Author permission lookups that one submission may keep in flight. */
export const FIX_REVIEW_PERMISSION_LOOKUP_CONCURRENCY = 4;

function isGitHubAuthenticationRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
}

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

export type FixReviewCommentListing = {
  /** The pull request's review comments within the read bounds, oldest first. */
  comments: FixReviewComment[];
  /** Review comments the read bounds kept out of the listing. */
  unreadCount: number;
};

export type FixReviewCommentClient = {
  listComments: () => Promise<FixReviewCommentListing>;
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

/**
 * Reads the pull request's review comments within a fixed page budget and a
 * fixed text budget.
 *
 * The newest comments are the ones a run was started for, so a pull request
 * with more pages than the budget is read from its last page down and its older
 * comments are reported as unread. The last page is read first, so the number
 * of comments the read skipped is known without reading the skipped pages. A
 * response that does not state its last page in either form is an error: the
 * caller refuses a session whose comment count cannot be established.
 */
async function readReviewComments(
  octokit: Octokit,
  target: FixReviewTarget
): Promise<FixReviewCommentListing> {
  const { owner, repo, pullNumber } = target;
  const readPage = (page: number, perPage = COMMENTS_PAGE_SIZE) =>
    octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page,
    });

  const firstPage = await readPage(1);
  let lastPage = lastLinkedPage(firstPage.headers.link);
  let listedCount: number | null = null;
  if (lastPage === null && firstPage.headers.link !== undefined) {
    // The header names pages but no last page. One row per page makes the last
    // page number the comment count, so the read still starts at the newest
    // page instead of keeping the oldest one.
    const oneRow = await readPage(1, 1);
    const probedLastPage = lastLinkedPage(oneRow.headers.link);
    if (probedLastPage === null) {
      throw new Error('GitHub did not report the last page of the review comments');
    }
    listedCount = probedLastPage;
    lastPage = Math.max(1, Math.ceil(listedCount / COMMENTS_PAGE_SIZE));
  } else if (
    lastPage === null &&
    firstPage.headers.link === undefined &&
    firstPage.data.length === COMMENTS_PAGE_SIZE
  ) {
    // This first page states no next page, so read the next page once: the
    // list ends there only when that page is empty.
    const nextPage = await readPage(2);
    if (nextPage.data.length > 0) {
      throw new Error('GitHub did not report the last page of the review comments');
    }
  }
  const pageCount = lastPage ?? 1;
  const firstPageToRead = Math.max(1, pageCount - FIX_REVIEW_COMMENTS_MAX_PAGES + 1);
  const pages: FixReviewComment[][] = [];
  let bodyLength = 0;
  let lastPageCount = 0;
  for (let page = pageCount; page >= firstPageToRead; page -= 1) {
    const data = page === 1 ? firstPage.data : (await readPage(page)).data;
    if (page === pageCount) lastPageCount = data.length;
    pages.push(
      data.map(comment => ({
        id: comment.id,
        inReplyToId: comment.in_reply_to_id ?? null,
        authorLogin: comment.user?.login ?? '',
        authorType: comment.user?.type ?? '',
        authorId: comment.user?.id ?? null,
        path: comment.path,
        line: comment.line ?? null,
        body: comment.body,
      }))
    );
    bodyLength += data.reduce((total, comment) => total + comment.body.length, 0);
    if (bodyLength >= FIX_REVIEW_COMMENTS_TOTAL_BODY_MAX_LENGTH) break;
  }

  // Restore the provider's oldest-first order, which the prompt budget reads
  // from its end, so an omitted comment is always an older one.
  pages.reverse();
  const comments = pages.flat();
  const total = listedCount ?? COMMENTS_PAGE_SIZE * (pageCount - 1) + lastPageCount;
  return { comments, unreadCount: Math.max(0, total - comments.length) };
}

export function createFixReviewCommentClient(
  octokit: Octokit,
  target: FixReviewTarget
): FixReviewCommentClient {
  const { owner, repo, pullNumber } = target;

  return {
    listComments: () => readReviewComments(octokit, target),

    async lookupPermission(login) {
      try {
        const { data } = await octokit.repos.getCollaboratorPermissionLevel({
          owner,
          repo,
          username: login,
        });
        const permission = data.permission;
        return KNOWN_PERMISSIONS[permission] ?? null;
      } catch (error) {
        if (isGitHubAuthenticationRejection(error)) throw error;
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

/**
 * The GitHub account bound to the Kilo user who started the run.
 *
 * `githubUserId` is the account id recorded with the binding. It is null when
 * the caller only has a credential resolved at request time.
 */
export type FixReviewInitiatorIdentity = {
  login: string;
  githubUserId: string | null;
};

/**
 * A comment is the initiator's when GitHub reports the account id recorded with
 * the binding. Logins are compared only when one side carries no account id.
 */
function isInitiatorAuthor(
  comment: FixReviewComment,
  initiator: FixReviewInitiatorIdentity | null
): boolean {
  if (initiator === null) return false;
  if (initiator.githubUserId !== null && comment.authorId !== null) {
    return String(comment.authorId) === initiator.githubUserId;
  }
  const key = loginKey(comment.authorLogin);
  return key.length > 0 && key === loginKey(initiator.login);
}

/**
 * A comment needs no repository permission lookup when Kilo's review bot or the
 * account that started the run wrote it.
 */
function needsPermissionLookup(
  comment: FixReviewComment,
  initiator: FixReviewInitiatorIdentity | null
): boolean {
  if (
    isKiloReviewBotAuthor({
      login: comment.authorLogin,
      type: comment.authorType,
      id: comment.authorId,
    })
  ) {
    return false;
  }
  return !isInitiatorAuthor(comment, initiator);
}

function loginKey(login: string): string {
  return login.trim().toLowerCase();
}

/** Runs `visit` over the items with at most `limit` calls in flight. */
async function eachWithinConcurrency<T>(
  items: readonly T[],
  limit: number,
  visit: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await visit(item);
    }
  });
  await Promise.all(workers);
}

export async function selectFixReviewComments(input: {
  comments: readonly FixReviewComment[];
  initiator: FixReviewInitiatorIdentity | null;
  settledCommentIds: ReadonlySet<number>;
  lookupPermission: (login: string) => Promise<CollaboratorPermission | null>;
}): Promise<FixReviewComment[]> {
  // Only top-level comments can ask for a change. Replies carry the discussion
  // around one, including the replies the fix session writes itself.
  const candidates = input.comments.filter(
    comment => comment.inReplyToId === null && !input.settledCommentIds.has(comment.id)
  );

  // One lookup per distinct login, in the order the logins first appear, and
  // never more of them in flight than the fixed limit: the lookup runs with the
  // credential that serves every user of the installation.
  const loginByKey = new Map<string, string>();
  for (const comment of candidates) {
    if (!needsPermissionLookup(comment, input.initiator)) continue;
    const key = loginKey(comment.authorLogin);
    if (key.length === 0 || loginByKey.has(key)) continue;
    loginByKey.set(key, comment.authorLogin);
  }
  const permissionByKey = new Map<string, CollaboratorPermission | null>();
  await eachWithinConcurrency(
    [...loginByKey],
    FIX_REVIEW_PERMISSION_LOOKUP_CONCURRENCY,
    async ([key, login]) => {
      permissionByKey.set(key, await input.lookupPermission(login));
    }
  );

  return candidates
    .filter(comment => {
      if (!needsPermissionLookup(comment, input.initiator)) return true;
      const permission = permissionByKey.get(loginKey(comment.authorLogin));
      return permission === 'admin' || permission === 'write';
    })
    .map(comment => ({
      ...comment,
      body:
        comment.body.length > FIX_REVIEW_COMMENT_BODY_MAX_LENGTH
          ? `${comment.body.slice(0, FIX_REVIEW_COMMENT_BODY_MAX_LENGTH)}\n[comment truncated]`
          : comment.body,
    }));
}

export type FixReviewSelectionDeps = {
  getInitiatorIdentity: (kiloUserId: string) => Promise<FixReviewInitiatorIdentity | null>;
  getUserAccessToken: typeof getGitHubUserAccessToken;
  generateInstallationToken: (
    installationId: string,
    appType: GitHubAppType,
    expectedIntegrationId: string
  ) => Promise<{ token: string }>;
  createCommentClient: (token: string, target: FixReviewTarget) => FixReviewCommentClient;
};

/**
 * The GitHub account recorded for this Kilo user's personal identity, or null
 * when the binding is revoked or its provided token has expired. A binding that
 * cannot produce a credential authorizes nothing.
 */
export async function getFixReviewInitiatorIdentity(
  kiloUserId: string
): Promise<FixReviewInitiatorIdentity | null> {
  const [authorization] = await db
    .select({
      login: user_github_app_tokens.github_login,
      githubUserId: user_github_app_tokens.github_user_id,
      revokedAt: user_github_app_tokens.revoked_at,
      credentialSource: user_github_app_tokens.credential_source,
      expiresAt: user_github_app_tokens.access_token_expires_at,
    })
    .from(user_github_app_tokens)
    .where(
      and(
        eq(user_github_app_tokens.kilo_user_id, kiloUserId),
        eq(user_github_app_tokens.github_app_type, 'standard')
      )
    )
    .limit(1);
  if (!authorization || authorization.revokedAt !== null) return null;
  if (isExpiredProvidedToken(authorization.credentialSource, authorization.expiresAt)) return null;
  return { login: authorization.login, githubUserId: authorization.githubUserId };
}

const defaultDeps: FixReviewSelectionDeps = {
  getInitiatorIdentity: getFixReviewInitiatorIdentity,
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
}): Promise<{
  client: FixReviewCommentClient;
  initiator: FixReviewInitiatorIdentity | null;
  userCredential?: GitHubUserAccessTokenConnected;
}> {
  const { owner, repo } = splitRepositoryFullName(input.repositoryFullName);
  const initiator = await input.deps.getInitiatorIdentity(input.initiatorKiloUserId);

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
      initiator,
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
    userCredential: credential.credential,
    initiator,
  };
}

export type FixReviewSelection = {
  comments: FixReviewComment[];
  /**
   * Comments left out of the prompt: those the read bounds did not fetch and
   * those beyond the prompt budget, reported to the user.
   */
  omittedCount: number;
};

/**
 * Reads the PR's review comments with a credential the server controls and
 * returns only the comments the fix session may act on.
 *
 * Throws when the credential or the GitHub response cannot be established, so
 * the caller can refuse to start a session it cannot verify. The thrown value
 * is always a newly constructed error with no request, response, or cause, so
 * every credential source returns the same error shape.
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
  const { client, initiator, userCredential } = await resolveCommentClient({
    ...input,
    deps,
  });

  try {
    const [listing, settledCommentIds] = await Promise.all([
      client.listComments(),
      client.listSettledCommentIds(input.prAuthor),
    ]);

    const selected = await selectFixReviewComments({
      comments: listing.comments,
      initiator,
      settledCommentIds,
      lookupPermission: login => client.lookupPermission(login),
    });

    return selectWithinPromptBudget(selected, listing.unreadCount);
  } catch (error) {
    // The diagnostic records the credential source and HTTP status only.
    const status =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof error.status === 'number'
        ? error.status
        : null;
    logExceptInTest('Fix-review comment read failed', {
      credential:
        userCredential === undefined
          ? 'installation'
          : (userCredential.credentialSource ?? 'personal'),
      status,
    });
    if (userCredential?.refreshSupported === false && status === 401) {
      await deps.getUserAccessToken(input.initiatorKiloUserId, {
        op: 'reportRejected',
        authorizationId: userCredential.authorizationId,
        credentialVersion: userCredential.credentialVersion,
      });
    }
    throw new Error(
      userCredential === undefined
        ? 'GitHub review comments are unavailable. Try again.'
        : 'GitHub review comments are unavailable. Check your personal connection and try again.'
    );
  }
}

/**
 * The newest comments are the ones a run was started for, so they are kept
 * first; the oldest are reported as omitted instead of crowding the prompt.
 * Comments the read bounds did not fetch are omitted too.
 */
function selectWithinPromptBudget(
  selected: readonly FixReviewComment[],
  unreadCount: number
): FixReviewSelection {
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
  return { comments: kept, omittedCount: unreadCount + selected.length - kept.length };
}
