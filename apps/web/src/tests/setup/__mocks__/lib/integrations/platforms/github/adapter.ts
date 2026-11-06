/**
 * Mock implementation of GitHub adapter for testing
 */

export type GitHubAppType = 'standard' | 'lite';

export function verifyGitHubWebhookSignature(_payload: string, _signature: string): 'valid' {
  return 'valid';
}

export async function generateGitHubInstallationToken(
  _installationId: string
): Promise<{ token: string; expires_at: string }> {
  return { token: `mock-token-${_installationId}`, expires_at: '2099-01-01T00:00:00.000Z' };
}

export async function deleteGitHubInstallation(_installationId: string): Promise<void> {
  // Mock implementation - no-op
  return;
}

export async function exchangeGitHubOAuthCode(
  _code: string,
  _appType: GitHubAppType = 'standard'
): Promise<{ id: string; login: string; accessToken: string }> {
  return { id: '12345', login: 'octocat', accessToken: 'mock-access-token' };
}

export async function getCollaboratorPermissionLevel(
  _installationId: string,
  _owner: string,
  _repo: string,
  _username: string
): Promise<'admin' | 'write' | 'read' | 'none' | null> {
  return 'write';
}

export async function resolveMergeHeadContent(_args: {
  appType: GitHubAppType;
  baseSha: string;
  headSha: string;
  installationId: string;
  owner: string;
  repo: string;
}): Promise<{ kind: 'not_merge' }> {
  return { kind: 'not_merge' };
}

export async function getCheckRunConclusion(): Promise<'success' | undefined> {
  return undefined;
}

export async function addReactionToPR(
  _installationId: string,
  _owner: string,
  _repo: string,
  _issueNumber: number,
  _reaction: string,
  _appType: GitHubAppType = 'standard'
): Promise<void> {
  return;
}

export async function createCheckRun(
  _installationId: string,
  _owner: string,
  _repo: string,
  _headSha: string,
  _options: unknown,
  _appType: GitHubAppType = 'standard'
): Promise<number> {
  return 0;
}

export async function updateCheckRun(
  _installationId: string,
  _owner: string,
  _repo: string,
  _checkRunId: number,
  _updates: unknown,
  _appType: GitHubAppType = 'standard'
): Promise<void> {
  return;
}

export async function createPRComment(
  _installationId: string,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _body: string,
  _appType: GitHubAppType = 'standard'
): Promise<void> {
  return;
}

export async function hasPRCommentWithMarker(
  _installationId: string,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _marker: string,
  _appType: GitHubAppType = 'standard'
): Promise<boolean> {
  return false;
}

export type AssociatedPullRequest = {
  number: number;
  htmlUrl: string;
  state: 'open' | 'closed' | 'merged' | 'draft';
  title: string;
  headSha: string;
  updatedAt: string;
  createdAt?: string;
  baseRepoFullName?: string;
  headRepoFullName?: string;
  headRef?: string;
  baseSha?: string;
  baseRef?: string;
  mergeable?: boolean | null;
  mergeableState?: string | null;
  commitShas?: string[];
};

export class GitHubRateLimitError extends Error {
  public readonly resetAt: Date;
  constructor(resetAt: Date) {
    super(`GitHub rate limited until ${resetAt.toISOString()}`);
    this.name = 'GitHubRateLimitError';
    this.resetAt = resetAt;
  }
}

/**
 * Mirrors the adapter's rule: 429, `x-ratelimit-remaining: 0`, or a 403 whose
 * Retry-After header or message names a rate limit or abuse. Keep in step with
 * `isGitHubRateLimitError` in the real adapter.
 */
export function isGitHubRateLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = 'status' in error ? error.status : undefined;
  if (status === 429) return true;
  if (getResponseHeader(error, 'x-ratelimit-remaining') === '0') return true;
  if (status !== 403) return false;
  if (getResponseHeader(error, 'retry-after') !== undefined) return true;
  const message = 'message' in error ? error.message : undefined;
  const text = typeof message === 'string' ? message.toLowerCase() : '';
  return text.includes('rate limit') || text.includes('abuse');
}

function getResponseHeader(error: unknown, name: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const response = (error as { response?: { headers?: Record<string, unknown> } }).response;
  const headers = response?.headers;
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

function retryAfterDeadlineMs(error: unknown, now: number): number | null {
  const header = getResponseHeader(error, 'retry-after')?.trim();
  if (!header) return null;
  if (/^\d+$/.test(header)) {
    const seconds = Number(header);
    return Number.isFinite(seconds) ? now + seconds * 1000 : null;
  }
  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function primaryResetDeadlineMs(error: unknown): number | null {
  if (getResponseHeader(error, 'x-ratelimit-remaining') !== '0') return null;
  const resetHeader = getResponseHeader(error, 'x-ratelimit-reset');
  if (!resetHeader) return null;
  const resetSeconds = Number(resetHeader);
  if (!Number.isFinite(resetSeconds) || resetSeconds <= 0) return null;
  return resetSeconds * 1000;
}

function parseRateLimitResetAt(error: unknown, now = Date.now()): Date {
  const deadlines = [retryAfterDeadlineMs(error, now), primaryResetDeadlineMs(error)].filter(
    (deadline): deadline is number => deadline !== null && Number.isFinite(deadline)
  );
  if (deadlines.length === 0) return new Date(now + 60_000);
  return new Date(Math.max(...deadlines));
}

export function toGitHubRateLimitError(error: unknown): GitHubRateLimitError | null {
  if (error instanceof GitHubRateLimitError) return error;
  if (!isGitHubRateLimitError(error)) return null;
  return new GitHubRateLimitError(parseRateLimitResetAt(error));
}

export async function fetchPullRequestByNumber(_params: {
  installationId: number;
  owner: string;
  repo: string;
  number: number;
  appType: GitHubAppType;
  includeCommits?: boolean;
  expectedHeadSha?: string | null;
  signal?: AbortSignal;
}): Promise<AssociatedPullRequest | null> {
  return null;
}

/**
 * Representative PR payload shape including the identity fields added for
 * session-to-PR link verification. Tests that need `fetchPullRequestByNumber`
 * to return a PR can spread this instead of re-declaring every field.
 */
export function mockAssociatedPullRequest(
  overrides: Partial<AssociatedPullRequest> = {}
): AssociatedPullRequest {
  return {
    number: 1,
    htmlUrl: 'https://github.com/mock-owner/mock-repo/pull/1',
    state: 'open',
    title: 'Mock PR',
    headSha: 'mock-head-sha',
    updatedAt: '2099-01-01T00:00:00.000Z',
    baseRepoFullName: 'mock-owner/mock-repo',
    headRepoFullName: 'mock-owner/mock-repo',
    headRef: 'mock-branch',
    ...overrides,
  };
}

export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required';

export async function fetchPullRequestReviewDecision(_args: {
  installationId: string;
  owner: string;
  repo: string;
  number: number;
  appType?: GitHubAppType;
}): Promise<ReviewDecision | null> {
  return null;
}

export async function fetchGitHubRootTextFileAtRef(_params: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}): Promise<string | null> {
  return null;
}
