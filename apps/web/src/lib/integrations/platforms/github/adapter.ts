import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { z } from 'zod';
import { logExceptInTest, warnExceptInTest } from '@/lib/utils.server';

import crypto from 'crypto';
import type { InstallationToken } from '@/lib/integrations/core/types';
import {
  buildGitHubPullRequestHead,
  parseGitHubRepositoryCoordinates,
} from '@/lib/github/pull-request-head';
import { type GitHubAppType, getGitHubAppCredentials } from './app-selector';
import { assertGitHubInstallationRuntimeAuthorized } from '../../github/runtime-authorization';

export type { GitHubAppType } from './app-selector';

export type GitHubInstallationRequest = {
  id: string;
  accountId: string;
  accountLogin: string;
  requesterId: string | null;
  requesterLogin: string | null;
};

export async function fetchGitHubInstallationRequests(
  appType: GitHubAppType = 'standard'
): Promise<GitHubInstallationRequest[]> {
  const credentials = getGitHubAppCredentials(appType);
  const auth = createAppAuth({ appId: credentials.appId, privateKey: credentials.privateKey });
  const { token } = await auth({ type: 'app' });
  const octokit = new Octokit({ auth: token });
  const requests = await octokit.paginate(
    octokit.apps.listInstallationRequestsForAuthenticatedApp,
    {
      per_page: 100,
    }
  );

  return requests.map(request => ({
    id: request.id.toString(),
    accountId: request.account.id.toString(),
    accountLogin: 'login' in request.account ? request.account.login : request.account.slug,
    requesterId: request.requester?.id?.toString() ?? null,
    requesterLogin: request.requester?.login ?? null,
  }));
}

export function verifyGitHubWebhookSignature(
  payload: string,
  signature: string,
  appType: GitHubAppType = 'standard'
): boolean {
  const credentials = getGitHubAppCredentials(appType);
  const hmac = crypto.createHmac('sha256', credentials.webhookSecret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    return false;
  }
}

export async function generateGitHubInstallationToken(
  installationId: string,
  appType: GitHubAppType = 'standard',
  expectedIntegrationId?: string,
  purpose: 'workflow' | 'agent' | 'management' = 'workflow'
): Promise<InstallationToken> {
  await assertGitHubInstallationRuntimeAuthorized(
    installationId,
    appType,
    expectedIntegrationId,
    purpose
  );
  return await generateGitHubInstallationTokenForMaintenance(installationId, appType);
}

export async function generateGitHubInstallationTokenForMaintenance(
  installationId: string,
  appType: GitHubAppType = 'standard'
): Promise<InstallationToken> {
  const credentials = getGitHubAppCredentials(appType);

  if (!credentials.appId || !credentials.privateKey) {
    throw new Error(`GitHub ${appType} App credentials not configured`);
  }

  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    installationId,
  });

  const authResult = await auth({ type: 'installation' });

  return {
    token: authResult.token,
    expires_at: authResult.expiresAt,
  };
}

export async function deleteGitHubInstallation(
  installationId: string,
  appType: GitHubAppType = 'standard'
): Promise<void> {
  const credentials = getGitHubAppCredentials(appType);

  if (!credentials.appId || !credentials.privateKey) {
    throw new Error(`GitHub ${appType} App credentials not configured`);
  }

  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
  });

  const { token } = await auth({ type: 'app' });
  const octokit = new Octokit({ auth: token });

  await octokit.apps.deleteInstallation({
    installation_id: parseInt(installationId),
  });
}

export async function verifyAndDeleteGitHubOrganizationInstallation(params: {
  installationId: string;
  accountId: string;
  appType: GitHubAppType;
}): Promise<void> {
  const credentials = getGitHubAppCredentials(params.appType);
  if (!credentials.appId || !credentials.privateKey)
    throw new Error('GitHub App credentials unavailable');
  const installationId = Number(params.installationId);
  const accountId = Number(params.accountId);
  if (!Number.isSafeInteger(installationId) || !Number.isSafeInteger(accountId)) {
    throw new Error('GitHub installation identity unavailable');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const auth = createAppAuth({ appId: credentials.appId, privateKey: credentials.privateKey });
    const { token } = await auth({ type: 'app' });
    const octokit = new Octokit({
      auth: token,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    const installation = await octokit.apps.getInstallation({
      installation_id: installationId,
      request: { signal: controller.signal },
    });
    const account = installation.data.account;
    if (
      installation.data.id !== installationId ||
      account?.id !== accountId ||
      !account ||
      !('type' in account) ||
      account.type !== 'Organization' ||
      (installation.data.app_id !== undefined &&
        installation.data.app_id.toString() !== credentials.appId)
    ) {
      throw new Error('GitHub installation identity mismatch');
    }
    const deleted = await octokit.apps.deleteInstallation({
      installation_id: installationId,
      request: { signal: controller.signal },
    });
    if (deleted.status !== 204) throw new Error('GitHub installation deletion not confirmed');
  } finally {
    clearTimeout(timeout);
  }
}

type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  created_at: string;
};

type GitHubBranch = {
  name: string;
  isDefault: boolean;
};

export async function fetchGitHubRepositories(
  installationId: string,
  appType: GitHubAppType = 'standard',
  expectedIntegrationId?: string,
  purpose: 'workflow' | 'agent' | 'management' = 'workflow'
): Promise<GitHubRepository[]> {
  const tokenData = await generateGitHubInstallationToken(
    installationId,
    appType,
    expectedIntegrationId,
    purpose
  );
  const octokit = new Octokit({ auth: tokenData.token });

  const repositories: GitHubRepository[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await octokit.apps.listReposAccessibleToInstallation({
      per_page: 100,
      page,
    });

    repositories.push(
      ...data.repositories
        .filter(repo => !repo.archived)
        .map(repo => ({
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          private: repo.private,
          created_at: repo.created_at ?? new Date().toISOString(),
        }))
    );

    if (data.repositories.length < perPage) break;
    page++;
  }

  return repositories;
}

export async function fetchGitHubRepositoriesForMaintenance(
  installationId: string,
  appType: GitHubAppType
): Promise<GitHubRepository[]> {
  const tokenData = await generateGitHubInstallationTokenForMaintenance(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });
  const repositories: GitHubRepository[] = [];
  let page = 1;
  while (true) {
    const response = await octokit.apps.listReposAccessibleToInstallation({ per_page: 100, page });
    repositories.push(
      ...response.data.repositories
        .filter(repository => !repository.archived)
        .map(repository => ({
          id: repository.id,
          name: repository.name,
          full_name: repository.full_name,
          private: repository.private,
          created_at: repository.created_at ?? new Date().toISOString(),
        }))
    );
    if (response.data.repositories.length < 100) break;
    page += 1;
  }
  return repositories;
}

export async function fetchGitHubBranches(
  installationId: string,
  repositoryFullName: string,
  appType: GitHubAppType = 'standard',
  expectedIntegrationId?: string,
  purpose: 'workflow' | 'agent' = 'workflow'
): Promise<GitHubBranch[]> {
  const tokenData = await generateGitHubInstallationToken(
    installationId,
    appType,
    expectedIntegrationId,
    purpose
  );
  const octokit = new Octokit({ auth: tokenData.token });

  const [owner, repo] = repositoryFullName.split('/');

  const { data: repoData } = await octokit.repos.get({
    owner,
    repo,
  });
  const defaultBranch = repoData.default_branch;

  const branches: GitHubBranch[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await octokit.repos.listBranches({
      owner,
      repo,
      per_page: perPage,
      page,
    });

    branches.push(
      ...data.map(branch => ({
        name: branch.name,
        isDefault: branch.name === defaultBranch,
      }))
    );

    if (data.length < perPage) break;
    page++;
  }

  return branches;
}

export async function fetchGitHubInstallationDetails(
  installationId: string,
  appType: GitHubAppType = 'standard'
): Promise<{
  id: number;
  account: {
    id: number;
    login: string;
    type: string;
  };
  repository_selection: string;
  permissions: Record<string, string>;
  events: string[];
  created_at: string;
}> {
  const credentials = getGitHubAppCredentials(appType);

  if (!credentials.appId || !credentials.privateKey) {
    throw new Error(`GitHub ${appType} App credentials not configured`);
  }

  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
  });

  const { token } = await auth({ type: 'app' });
  const octokit = new Octokit({ auth: token });

  const { data } = await octokit.apps.getInstallation({
    installation_id: parseInt(installationId),
  });

  return {
    id: data.id,
    account: {
      id: data.account?.id ?? 0,
      login: (data.account as { login?: string })?.login ?? '',
      type: (data.account as { type?: string })?.type ?? 'User',
    },
    repository_selection: data.repository_selection ?? 'all',
    permissions: data.permissions as Record<string, string>,
    events: data.events ?? [],
    created_at: data.created_at,
  };
}

/**
 * Used to show that Kilo is reviewing a PR (e.g., 👀 eyes reaction).
 */
export async function addReactionToPR(
  installationId: string,
  owner: string,
  repo: string,
  prNumber: number,
  reaction: 'eyes' | '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket',
  appType: GitHubAppType = 'standard'
): Promise<void> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  await octokit.reactions.createForIssue({
    owner,
    repo,
    issue_number: prNumber,
    content: reaction,
  });
}

/**
 * Creates a new top-level comment on a PR (issue comment).
 */
export async function createPRComment(
  installationId: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  appType: GitHubAppType = 'standard'
): Promise<void> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });

  logExceptInTest('[createPRComment] Created comment', { owner, repo, prNumber });
}

/**
 * Checks whether a comment containing the given marker already exists on a PR.
 */
export async function hasPRCommentWithMarker(
  installationId: string,
  owner: string,
  repo: string,
  prNumber: number,
  marker: string,
  appType: GitHubAppType = 'standard'
): Promise<boolean> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  const comments = await octokit.paginate(octokit.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  return comments.some(c => c.body?.includes(marker));
}

/**
 * Used to acknowledge @kilo fix mentions on inline review comments.
 */
export async function addReactionToPRReviewComment(
  installationId: string,
  owner: string,
  repo: string,
  commentId: number,
  reaction: 'eyes' | '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket',
  appType: GitHubAppType = 'standard'
): Promise<void> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  await octokit.reactions.createForPullRequestReviewComment({
    owner,
    repo,
    comment_id: commentId,
    content: reaction,
  });
}

/**
 * Returns the permission string ('admin' | 'write' | 'read' | 'none') or null
 * if the lookup fails (e.g. the App lacks permission to query collaborators).
 */
export type CollaboratorPermission = 'admin' | 'write' | 'read' | 'none';

const KNOWN_PERMISSIONS = new Set<string>(['admin', 'write', 'read', 'none']);

export async function getCollaboratorPermissionLevel(
  installationId: string,
  owner: string,
  repo: string,
  username: string,
  appType: GitHubAppType = 'standard'
): Promise<CollaboratorPermission | null> {
  try {
    const tokenData = await generateGitHubInstallationToken(installationId, appType);
    const octokit = new Octokit({ auth: tokenData.token });

    const { data } = await octokit.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });

    if (KNOWN_PERMISSIONS.has(data.permission)) {
      // Safe: value validated against the known set above
      return data.permission as CollaboratorPermission;
    }
    return null;
  } catch {
    return null;
  }
}

export async function replyToReviewComment(
  installationId: string,
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
  body: string,
  appType: GitHubAppType = 'standard'
): Promise<void> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  await octokit.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: pullNumber,
    comment_id: commentId,
    body,
  });
}

const GitHubOAuthErrorResponseSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});
const GitHubOAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
});

/**
 * Used during installation request flow to identify the GitHub user.
 *
 * @param codeVerifier - The PKCE code verifier, required when the
 *   authorization request that produced `code` included a code_challenge
 *   (as `beginConnection` does). GitHub rejects redemption of such a code
 *   with `invalid_grant` if the verifier isn't sent.
 *
 * Exchanges directly with GitHub's token endpoint rather than through
 * `@octokit/oauth-methods`' `exchangeWebFlowCode`: that library never
 * forwards a supplied `codeVerifier` to GitHub for `clientType:
 * 'github-app'` (confirmed against the installed package — no
 * code_verifier/codeVerifier reference exists anywhere in it), which
 * silently broke every PKCE-bound exchange. This mirrors
 * `exchangeGitHubUserAuthorizationCode` in `user-authorization.ts`, which
 * already exchanges directly and already works correctly.
 */
export async function exchangeGitHubOAuthCode(
  code: string,
  appType: GitHubAppType = 'standard',
  codeVerifier?: string
): Promise<{
  id: string;
  login: string;
  accessToken: string;
}> {
  const credentials = getGitHubAppCredentials(appType);

  if (!credentials.clientId || !credentials.clientSecret) {
    throw new Error(`Missing GitHub ${appType} App credentials`);
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub OAuth code exchange failed (${response.status})`);
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error('GitHub OAuth code exchange returned a non-JSON response');
  }
  // GitHub's token endpoint returns HTTP 200 with an `error` body for OAuth
  // failures like invalid_grant (missing/invalid code_verifier, expired or
  // already-used code), not a non-2xx status.
  const errorBody = GitHubOAuthErrorResponseSchema.safeParse(responseBody);
  if (errorBody.success) {
    throw new Error(
      `GitHub OAuth code exchange failed: ${errorBody.data.error}${
        errorBody.data.error_description ? ` (${errorBody.data.error_description})` : ''
      }`
    );
  }
  const parsedToken = GitHubOAuthTokenResponseSchema.safeParse(responseBody);
  if (!parsedToken.success) {
    throw new Error('GitHub OAuth code exchange returned an invalid token response');
  }

  const accessToken = parsedToken.data.access_token;

  const octokit = new Octokit({
    auth: accessToken,
  });

  const { data: githubUser } = await octokit.rest.users.getAuthenticated();

  return {
    id: githubUser.id.toString(),
    login: githubUser.login,
    accessToken,
  };
}

const KILO_REVIEW_COMMENTS_PER_PAGE = 100;
const MAX_KILO_REVIEW_COMMENT_PAGES = 5;

/**
 * Looks for the <!-- kilo-review --> marker in issue comments.
 * Falls back to detecting older Kilo comments by patterns if no marker found.
 */
export async function findKiloReviewComment(
  installationId: string,
  owner: string,
  repo: string,
  prNumber: number,
  appType: GitHubAppType = 'standard'
): Promise<{ commentId: number; body: string } | null> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  const comments: Array<{ id: number; body?: string | null; updated_at: string }> = [];
  let reachedScanLimit = false;

  for (let page = 1; page <= MAX_KILO_REVIEW_COMMENT_PAGES; page++) {
    const { data: pageComments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: KILO_REVIEW_COMMENTS_PER_PAGE,
      page,
    });
    comments.push(...pageComments);

    if (pageComments.length < KILO_REVIEW_COMMENTS_PER_PAGE) break;
    reachedScanLimit = page === MAX_KILO_REVIEW_COMMENT_PAGES;
  }

  logExceptInTest('[findKiloReviewComment] Fetched comments', {
    owner,
    repo,
    prNumber,
    totalComments: comments.length,
  });

  const markedComments = comments.filter(c => c.body?.includes('<!-- kilo-review -->'));

  if (markedComments.length > 0) {
    const latestComment = markedComments.sort((a, b) => {
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    })[0];
    logExceptInTest('[findKiloReviewComment] Found comment with marker', {
      owner,
      repo,
      prNumber,
      commentId: latestComment.id,
      markedCommentsCount: markedComments.length,
      detectionMethod: 'marker',
    });
    return { commentId: latestComment.id, body: latestComment.body || '' };
  }

  if (reachedScanLimit) {
    throw new Error('Kilo review comment lookup exceeded the safe issue-comment scan limit');
  }

  logExceptInTest('[findKiloReviewComment] No existing Kilo review comment found', {
    owner,
    repo,
    prNumber,
    totalComments: comments.length,
  });

  return null;
}

export async function updateKiloReviewComment(
  installationId: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
  appType: GitHubAppType = 'standard'
): Promise<void> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  await octokit.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body,
  });

  logExceptInTest('[updateKiloReviewComment] Updated comment', {
    owner,
    repo,
    commentId,
  });
}

/**
 * Used to detect duplicates and track outdated inline comments.
 */
export async function fetchPRInlineComments(
  installationId: string,
  owner: string,
  repo: string,
  prNumber: number,
  appType: GitHubAppType = 'standard'
): Promise<
  Array<{
    id: number;
    path: string;
    line: number | null;
    body: string;
    isOutdated: boolean;
    user: { login: string };
  }>
> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  const comments: Array<{
    id: number;
    path: string;
    line: number | null;
    body: string;
    isOutdated: boolean;
    user: { login: string };
  }> = [];

  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: perPage,
      page,
    });

    comments.push(
      ...data.map(c => ({
        id: c.id,
        path: c.path,
        line: c.line ?? null,
        body: c.body,
        isOutdated: c.position === null, // null position = outdated
        user: { login: c.user?.login ?? 'unknown' },
      }))
    );

    if (data.length < perPage) break;
    page++;
  }

  logExceptInTest('[fetchPRInlineComments] Fetched comments', {
    owner,
    repo,
    prNumber,
    totalComments: comments.length,
  });

  return comments;
}

export async function getPRHeadCommit(
  installationId: string,
  owner: string,
  repo: string,
  prNumber: number,
  appType: GitHubAppType = 'standard'
): Promise<string> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  logExceptInTest('[getPRHeadCommit] Got HEAD commit', {
    owner,
    repo,
    prNumber,
    headSha: pr.head.sha.substring(0, 8),
  });

  return pr.head.sha;
}

type GitHubRepositoryContent = {
  type?: string;
  content?: string;
  encoding?: string;
  sha?: string;
};

export function decodeGitHubBase64Content(content: string): string {
  return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
}

/**
 * Fetches a root text file from a repository at a specific ref.
 * Returns null for missing files, directories, or unsupported content responses.
 */
export async function fetchGitHubRootTextFileAtRef(params: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}): Promise<string | null> {
  const { token, owner, repo, path, ref } = params;
  const octokit = new Octokit({ auth: token });

  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if (Array.isArray(data)) return null;

    const content = data as GitHubRepositoryContent;
    if (content.type !== 'file' || content.encoding !== 'base64' || !content.content) {
      return null;
    }

    return decodeGitHubBase64Content(content.content);
  } catch (error) {
    if (isHttpError(error) && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function fetchGitHubRepositoryDefaultBranch(params: {
  token: string;
  owner: string;
  repo: string;
}): Promise<string> {
  const { token, owner, repo } = params;
  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.repos.get({ owner, repo });
  return data.default_branch;
}

export async function fetchGitHubRepositorySize(params: {
  token: string;
  owner: string;
  repo: string;
}): Promise<string | null> {
  const { token, owner, repo } = params;
  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.repos.get({ owner, repo });

  if (typeof data.size !== 'number') {
    return null;
  }

  return `${Math.round(data.size / 1024)} MiB`;
}

export async function createGitHubBranch(params: {
  token: string;
  owner: string;
  repo: string;
  branchName: string;
  baseBranch: string;
}): Promise<void> {
  const { token, owner, repo, branchName, baseBranch } = params;
  const octokit = new Octokit({ auth: token });
  const { data: baseRef } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });

  try {
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseRef.object.sha,
    });
  } catch (error) {
    if (
      isHttpError(error) &&
      error.status === 422 &&
      /reference already exists/i.test(error.message)
    ) {
      return;
    }
    throw error;
  }
}

export async function createOrUpdateGitHubRootTextFile(params: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  branch: string;
  message: string;
  content: string;
}): Promise<void> {
  const { token, owner, repo, path, branch, message, content } = params;
  const octokit = new Octokit({ auth: token });
  let sha: string | undefined;

  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(data)) {
      const existing = data as GitHubRepositoryContent;
      if (existing.type === 'file') {
        sha = existing.sha;
      }
    }
  } catch (error) {
    if (!isHttpError(error) || error.status !== 404) {
      throw error;
    }
  }

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
  });
}

export async function createGitHubPullRequest(params: {
  token: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  /** Repository the head branch was pushed to, when it is a fork. Defaults to `owner/repo`. */
  headRepo?: string;
}): Promise<{ number: number; url: string }> {
  const { token, owner, repo, title, body, headBranch, baseBranch } = params;
  const octokit = new Octokit({ auth: token });
  const headRepoFullName = params.headRepo ?? `${owner}/${repo}`;
  const headRepository = parseGitHubRepositoryCoordinates(headRepoFullName);
  if (!headRepository) {
    throw new Error(`Invalid head repository name format: ${headRepoFullName}`);
  }
  const pullRequestHead = buildGitHubPullRequestHead({
    headBranch,
    headRepository,
    baseRepository: { owner, repo },
  });
  const { data } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head: pullRequestHead.ref,
    base: baseBranch,
    ...(pullRequestHead.headRepo === null ? {} : { head_repo: pullRequestHead.headRepo }),
  });

  return { number: data.number, url: data.html_url };
}

export async function getGitHubReviewComment(
  installationId: string,
  owner: string,
  repo: string,
  commentId: number,
  appType: GitHubAppType = 'standard'
): Promise<{
  id: number;
  body: string;
  userLogin: string | null;
  inReplyToId: number | null;
} | null> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  try {
    const { data } = await octokit.pulls.getReviewComment({
      owner,
      repo,
      comment_id: commentId,
    });
    return {
      id: data.id,
      body: data.body,
      userLogin: data.user?.login ?? null,
      inReplyToId: data.in_reply_to_id ?? null,
    };
  } catch (error) {
    if (isHttpError(error) && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function isHttpError(error: unknown): error is { status: number; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  );
}

export type AssociatedPullRequest = {
  number: number;
  htmlUrl: string;
  state: 'open' | 'closed' | 'merged' | 'draft';
  title: string;
  headSha: string;
  updatedAt: string; // ISO
  /**
   * `owner/name` of the PR's base repository, as reported by GitHub. Used to
   * verify that a session's stored link actually names this repository rather
   * than trusting the branch name alone. `fetchPullRequestByNumber` always
   * populates it; it is optional so callers that only need the previous fields
   * keep compiling, and the identity helper treats its absence as no evidence.
   */
  baseRepoFullName?: string;
  /**
   * `owner/name` of the PR's head repository, as reported by GitHub. Empty when
   * the head repository is gone (for example a deleted fork); a fork or another
   * repository never satisfies the session-repo check.
   */
  headRepoFullName?: string;
  /** Branch the PR was opened from, as reported by GitHub. */
  headRef?: string;
  /**
   * SHAs of the PR's commits. Populated only when the caller passes
   * `includeCommits` and the session SHA is not already the PR head. `undefined`
   * means "not fetched", not "no commits". The walk is capped at
   * `MAX_COMMIT_PAGES` pages so a very large PR cannot turn one refresh into
   * hundreds of sequential GitHub calls.
   */
  commitShas?: string[];
};

/**
 * Bound on the commit pages walked when a session head SHA is not the PR head.
 * 100 commits per page, so at most 1 + `MAX_COMMIT_PAGES` GitHub calls. A
 * session SHA beyond this window is treated as unverified (no PR shown) rather
 * than paging through thousands of commits.
 */
const MAX_COMMIT_PAGES = 10;
const COMMITS_PER_PAGE = 100;

/**
 * Thrown when GitHub returns a rate-limit response. The caller can surface
 * `resetAt` to the user so they know when to retry.
 */
export class GitHubRateLimitError extends Error {
  public readonly resetAt: Date;
  constructor(resetAt: Date) {
    super(`GitHub rate limited until ${resetAt.toISOString()}`);
    this.name = 'GitHubRateLimitError';
    this.resetAt = resetAt;
  }
}

function getResponseHeader(error: unknown, name: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const response = (error as { response?: { headers?: Record<string, unknown> } }).response;
  const headers = response?.headers;
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

function parseRateLimitResetAt(error: unknown): Date {
  const resetHeader = getResponseHeader(error, 'x-ratelimit-reset');
  const resetSeconds = resetHeader ? Number(resetHeader) : NaN;
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    return new Date(resetSeconds * 1000);
  }
  // Fall back to "retry in 60s" if the header is missing/invalid, so callers
  // always have a usable Date to show.
  return new Date(Date.now() + 60_000);
}

function getErrorMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

function isRateLimitError(error: unknown): boolean {
  if (!isHttpError(error)) return false;
  // 429 is unambiguously rate limiting.
  if (error.status === 429) return true;
  // `x-ratelimit-remaining: 0` signals the primary rate limit is exhausted
  // regardless of status.
  const remaining = getResponseHeader(error, 'x-ratelimit-remaining');
  if (remaining === '0') return true;
  // 403 is overloaded: it can mean rate/abuse limiting OR a plain permission
  // denial (e.g. installation lacks pull request access). Only treat 403 as
  // rate-limited when the message indicates so, so that genuine permission
  // failures are surfaced to the caller.
  if (error.status === 403) {
    const message = getErrorMessage(error).toLowerCase();
    return (
      message.includes('rate limit') ||
      message.includes('secondary rate limit') ||
      message.includes('abuse')
    );
  }
  return false;
}

/**
 * Look up a pull request by its number using an installation token.
 *
 * Used by the stored-link-first refresh path: the session carries a concrete
 * PR URL, so we fetch that exact PR instead of searching by branch.
 *
 * @returns The PR, or `null` when the PR does not exist (or the repo is no
 *   longer accessible to this installation).
 * @throws {GitHubRateLimitError} when GitHub rate-limits the request.
 */
export async function fetchPullRequestByNumber(params: {
  installationId: number;
  owner: string;
  repo: string;
  number: number;
  appType: GitHubAppType;
  /**
   * When set, also fetch the PR's commit SHAs so a caller can verify a session
   * head SHA that is not the PR's current head (for example the session pushed
   * an earlier commit and later commits landed on the same branch).
   * Defaults to false to keep the common case to a single API call.
   */
  includeCommits?: boolean;
  /**
   * The session's reported head SHA. When it equals the PR's current head the
   * caller can accept the link from the head alone, so the commit walk is
   * skipped entirely. Without it (or when it differs) the walk runs, capped at
   * `MAX_COMMIT_PAGES`.
   */
  expectedHeadSha?: string | null;
}): Promise<AssociatedPullRequest | null> {
  const {
    installationId,
    owner,
    repo,
    number,
    appType,
    includeCommits = false,
    expectedHeadSha = null,
  } = params;

  const tokenData = await generateGitHubInstallationToken(String(installationId), appType);
  const octokit = new Octokit({ auth: tokenData.token });

  try {
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: number,
    });

    const state: AssociatedPullRequest['state'] =
      pr.merged_at != null
        ? 'merged'
        : pr.state === 'open' && pr.draft
          ? 'draft'
          : pr.state === 'open'
            ? 'open'
            : 'closed';

    let commitShas: string[] | undefined;
    if (includeCommits) {
      const expected = expectedHeadSha?.trim().toLowerCase();
      const prHeadSha = pr.head.sha.trim().toLowerCase();
      // The session's SHA already is the PR head: `verifySessionPullRequestLink`
      // accepts it from the head alone, so no commit walk is needed. This keeps
      // the normal new-CLI refresh to a single GitHub call regardless of how
      // many commits the PR has grown to.
      if (!expected || expected !== prHeadSha) {
        commitShas = [];
        for (let page = 1; page <= MAX_COMMIT_PAGES; page += 1) {
          const { data } = await octokit.pulls.listCommits({
            owner,
            repo,
            pull_number: number,
            per_page: COMMITS_PER_PAGE,
            page,
          });
          for (const commit of data) {
            if (typeof commit.sha === 'string') commitShas.push(commit.sha);
          }
          if (data.length < COMMITS_PER_PAGE) break;
        }
      }
    }

    return {
      number: pr.number,
      htmlUrl: pr.html_url,
      state,
      title: pr.title,
      headSha: pr.head.sha,
      updatedAt: pr.updated_at,
      baseRepoFullName: pr.base.repo?.full_name ?? `${owner}/${repo}`,
      headRepoFullName: pr.head.repo?.full_name ?? '',
      headRef: pr.head.ref,
      ...(commitShas ? { commitShas } : {}),
    };
  } catch (error) {
    if (isRateLimitError(error)) {
      throw new GitHubRateLimitError(parseRateLimitResetAt(error));
    }
    if (isHttpError(error) && error.status === 404) {
      warnExceptInTest('[fetchPullRequestByNumber] PR not found or repo not accessible', {
        owner,
        repo,
        number,
      });
      return null;
    }
    throw error;
  }
}

export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required';

export type BatchedPrInput = {
  alias: string;
  owner: string;
  repo: string;
  number: number;
};

function normalizeReviewDecision(decision: string | null | undefined): ReviewDecision | null {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
    default:
      return null;
  }
}

/**
 * Fetches `reviewDecision` for multiple PRs in a single aliased GraphQL query.
 * All PRs must belong to the same installation (one token is generated).
 * Returns a Map from alias → ReviewDecision|null.
 * @throws {GitHubRateLimitError} on 403 secondary rate limit.
 */
export async function fetchBatchedReviewDecisions(args: {
  installationId: string;
  prs: BatchedPrInput[];
  appType?: GitHubAppType;
}): Promise<Map<string, ReviewDecision | null>> {
  const { installationId, prs, appType = 'standard' } = args;
  if (prs.length === 0) return new Map();

  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  const fragments = prs
    .map(
      ({ alias, owner, repo, number }) =>
        `${alias}: repository(owner: "${owner}", name: "${repo}") { pullRequest(number: ${number}) { reviewDecision } }`
    )
    .join('\n');

  try {
    const response = (await octokit.request('POST /graphql', {
      query: `{ ${fragments} }`,
    })) as {
      data: {
        data: Record<string, { pullRequest: { reviewDecision: string | null } | null } | null>;
      };
    };

    const result = new Map<string, ReviewDecision | null>();
    for (const { alias } of prs) {
      const repoData = response.data.data?.[alias];
      result.set(alias, normalizeReviewDecision(repoData?.pullRequest?.reviewDecision));
    }
    return result;
  } catch (error) {
    if (isRateLimitError(error)) {
      throw new GitHubRateLimitError(parseRateLimitResetAt(error));
    }
    throw error;
  }
}

/**
 * Fetches the rolled-up `reviewDecision` for a single PR via GitHub's GraphQL API.
 * Returns lowercase values matching our DB enum, or `null` when GitHub returns
 * null (no required reviewers and no review submitted yet).
 * @throws {GitHubRateLimitError} on 403 secondary rate limit.
 */
export async function fetchPullRequestReviewDecision(args: {
  installationId: string;
  owner: string;
  repo: string;
  number: number;
  appType?: GitHubAppType;
}): Promise<ReviewDecision | null> {
  const { installationId, owner, repo, number, appType = 'standard' } = args;
  const results = await fetchBatchedReviewDecisions({
    installationId,
    prs: [{ alias: 'pr0', owner, repo, number }],
    appType,
  });
  return results.get('pr0') ?? null;
}

export async function getRepositoryDetails(
  installationId: string,
  repoFullName: string,
  appType: GitHubAppType = 'standard'
): Promise<{
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  isEmpty: boolean;
  isPrivate: boolean;
} | null> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    return null;
  }

  try {
    const { data: repoData } = await octokit.repos.get({
      owner,
      repo,
    });

    let isEmpty = false;
    try {
      const { data: commits } = await octokit.repos.listCommits({
        owner,
        repo,
        per_page: 1,
      });
      isEmpty = commits.length === 0;
    } catch (error) {
      // 409 Conflict means "Git Repository is empty" - this is expected for empty repos
      if (isHttpError(error) && error.status === 409) {
        isEmpty = true;
      } else {
        throw error;
      }
    }

    logExceptInTest('[getRepositoryDetails] Got repository details', {
      fullName: repoData.full_name,
      isEmpty,
      private: repoData.private,
    });

    return {
      fullName: repoData.full_name,
      cloneUrl: repoData.clone_url,
      htmlUrl: repoData.html_url,
      isEmpty,
      isPrivate: repoData.private,
    };
  } catch (error) {
    if (isHttpError(error) && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * The installation settings page is where users grant access to newly
 * created repos.
 */
export async function getInstallationSettingsUrl(
  installationId: string,
  appType: GitHubAppType = 'standard'
): Promise<string> {
  const credentials = getGitHubAppCredentials(appType);

  if (!credentials.appId || !credentials.privateKey) {
    throw new Error(`GitHub ${appType} App credentials not configured`);
  }

  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
  });

  const { token } = await auth({ type: 'app' });
  const octokit = new Octokit({ auth: token });

  const { data } = await octokit.apps.getInstallation({
    installation_id: parseInt(installationId),
  });

  const accountLogin = (data.account as { login?: string })?.login ?? '';
  const accountType = (data.account as { type?: string })?.type ?? 'User';

  if (accountType === 'Organization') {
    return `https://github.com/organizations/${accountLogin}/settings/installations/${installationId}`;
  }
  return `https://github.com/settings/installations/${installationId}`;
}

export async function checkExistingFork(
  installationId: string,
  accountLogin: string,
  sourceOwner: string,
  sourceRepo: string,
  appType: GitHubAppType = 'standard'
): Promise<{ exists: boolean; fullName: string | null }> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  try {
    const { data: repo } = await octokit.repos.get({
      owner: accountLogin,
      repo: sourceRepo,
    });

    if (repo.fork && repo.parent?.full_name === `${sourceOwner}/${sourceRepo}`) {
      return {
        exists: true,
        fullName: repo.full_name,
      };
    }

    // User has a repo with the same name but it's not a fork of our source
    // This is an edge case - the fork will be created with a different name
    return { exists: false, fullName: null };
  } catch (error) {
    if (isHttpError(error) && error.status === 404) {
      return { exists: false, fullName: null };
    }
    throw error;
  }
}

/**
 * Checks whether a commit is a merge commit (has 2+ parents).
 * Used to skip code reviews triggered by "merge base into feature" pushes.
 * Returns false if the API call fails so the review proceeds (fail-open).
 */
export async function isMergeCommit(
  installationId: string,
  owner: string,
  repo: string,
  commitSha: string,
  appType: GitHubAppType = 'standard'
): Promise<boolean> {
  try {
    const tokenData = await generateGitHubInstallationToken(installationId, appType);
    const octokit = new Octokit({ auth: tokenData.token });

    const { data } = await octokit.git.getCommit({
      owner,
      repo,
      commit_sha: commitSha,
    });

    const result = data.parents.length > 1;

    logExceptInTest('[isMergeCommit] Checked commit parents', {
      owner,
      repo,
      sha: commitSha.substring(0, 8),
      parentCount: data.parents.length,
      isMergeCommit: result,
    });

    return result;
  } catch (error) {
    logExceptInTest(
      '[isMergeCommit] Failed to check commit parents, proceeding with review:',
      error
    );
    return false;
  }
}

/**
 * Conclusion values for a completed GitHub Check Run.
 * @see https://docs.github.com/en/rest/checks/runs#create-a-check-run
 */
export type CheckRunConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'action_required';

type CheckRunOutput = {
  title: string;
  summary: string;
  text?: string;
};

/**
 * Creates a GitHub Check Run on a commit.
 *
 * Used when a code review is first queued so the PR immediately shows
 * a pending "Kilo Code Review" check that can be configured as a
 * required status check in branch protection rules.
 *
 * @returns The numeric Check Run ID (store this to update the check later)
 */
export async function createCheckRun(
  installationId: string,
  owner: string,
  repo: string,
  headSha: string,
  options: {
    detailsUrl?: string;
    output?: CheckRunOutput;
  } = {},
  appType: GitHubAppType = 'standard'
): Promise<number> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  const { data } = await octokit.checks.create({
    owner,
    repo,
    name: 'Kilo Code Review',
    head_sha: headSha,
    status: 'queued',
    ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
    ...(options.output ? { output: options.output } : {}),
  });

  logExceptInTest('[createCheckRun] Created check run', {
    owner,
    repo,
    headSha: headSha.substring(0, 8),
    checkRunId: data.id,
  });

  return data.id;
}

/**
 * Updates an existing GitHub Check Run.
 *
 * Called as the review progresses through its lifecycle:
 * - queued  -> in_progress  (review starts running)
 * - in_progress -> completed (review finishes, with a conclusion)
 */
export async function updateCheckRun(
  installationId: string,
  owner: string,
  repo: string,
  checkRunId: number,
  options: {
    status?: 'queued' | 'in_progress' | 'completed';
    conclusion?: CheckRunConclusion;
    detailsUrl?: string;
    output?: CheckRunOutput;
  },
  appType: GitHubAppType = 'standard'
): Promise<void> {
  const tokenData = await generateGitHubInstallationToken(installationId, appType);
  const octokit = new Octokit({ auth: tokenData.token });

  await octokit.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
    ...(options.status ? { status: options.status } : {}),
    ...(options.conclusion ? { conclusion: options.conclusion } : {}),
    ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
    ...(options.output ? { output: options.output } : {}),
    ...(options.status === 'completed' ? { completed_at: new Date().toISOString() } : {}),
  });

  logExceptInTest('[updateCheckRun] Updated check run', {
    owner,
    repo,
    checkRunId,
    status: options.status,
    conclusion: options.conclusion,
  });
}
