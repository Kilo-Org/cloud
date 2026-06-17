import type { PlatformIntegration } from '@kilocode/db/schema';

import {
  getCollaboratorPermissionLevel,
  getGitHubReviewComment,
  type CollaboratorPermission,
  type GitHubAppType,
} from '@/lib/integrations/platforms/github/adapter';
import type { PullRequestReviewCommentPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import { recordReplyFeedbackEvent, type ReviewMemoryOwner } from './db';
import { isReviewMemoryEnabled } from './settings';

export const KILO_GITHUB_BOT_LOGINS: ReadonlySet<string> = new Set([
  'kilo-code',
  'kilo-code[bot]',
  'kilo-code-bot',
  'kilo-code-bot[bot]',
  'kilo-code-review-bot',
  'kilo-code-review-bot[bot]',
  'kilocode[bot]',
]);

export const REVIEW_MEMORY_FEEDBACK_EXCERPT_MAX_LENGTH = 2_000;
const REVIEW_MEMORY_PERMISSION_CACHE_TTL_MS = 30 * 60_000;

type RepositoryPermissionCacheEntry = {
  value: CollaboratorPermission;
  expiresAtMs: number;
};

const repositoryPermissionCache = new Map<string, RepositoryPermissionCacheEntry>();
const repositoryPermissionInFlight = new Map<string, Promise<CollaboratorPermission | null>>();

export function isLikelyKiloBotActor(login: string | undefined): boolean {
  return KILO_GITHUB_BOT_LOGINS.has(login?.toLowerCase() ?? '');
}

export type FetchParentReviewComment = (input: {
  installationId: string;
  appType: GitHubAppType;
  owner: string;
  repo: string;
  commentId: number;
}) => Promise<{ id: number; body: string; userLogin: string | null } | null>;

export type FetchRepositoryPermission = (input: {
  installationId: string;
  appType: GitHubAppType;
  owner: string;
  repo: string;
  username: string;
}) => Promise<CollaboratorPermission | null>;

export async function handleGitHubReviewCommentReply(input: {
  payload: PullRequestReviewCommentPayload;
  integration: PlatformIntegration;
  deliveryId: string;
  fetchParentComment?: FetchParentReviewComment;
  fetchRepositoryPermission?: FetchRepositoryPermission;
}): Promise<{ recorded: boolean; reason?: string; eventId?: string }> {
  if (input.payload.action !== 'created') return { recorded: false, reason: 'comment-not-created' };

  const parentCommentId = input.payload.comment.in_reply_to_id ?? null;
  if (!parentCommentId) return { recorded: false, reason: 'not-review-comment-reply' };

  if (isLikelyKiloBotActor(input.payload.comment.user.login)) {
    return { recorded: false, reason: 'bot-authored-comment' };
  }

  const owner = ownerFromIntegration(input.integration);
  if (!owner) return { recorded: false, reason: 'missing-owner' };

  if (!(await isReviewMemoryEnabled({ owner, platform: 'github' }))) {
    return { recorded: false, reason: 'review-memory-disabled' };
  }

  const [repoOwner, repo] = input.payload.repository.full_name.split('/');
  if (!repoOwner || !repo) return { recorded: false, reason: 'invalid-repo-name' };

  const installationId = input.payload.installation.id.toString();
  const appType = input.integration.github_app_type ?? 'standard';
  const fetchParentComment = input.fetchParentComment ?? defaultFetchParentComment;
  const fetchRepositoryPermission =
    input.fetchRepositoryPermission ?? defaultFetchRepositoryPermission;
  const parent = await fetchParentComment({
    installationId,
    appType,
    owner: repoOwner,
    repo,
    commentId: parentCommentId,
  });

  if (!parent) return { recorded: false, reason: 'parent-comment-not-found' };
  if (!isLikelyKiloBotActor(parent.userLogin ?? undefined)) {
    return { recorded: false, reason: 'not-kilo-comment' };
  }

  const repositoryPermission = await fetchRepositoryPermissionWithCache(fetchRepositoryPermission, {
    installationId,
    appType,
    owner: repoOwner,
    repo,
    username: input.payload.comment.user.login,
  });

  if (repositoryPermission === null) {
    return { recorded: false, reason: 'repository-permission-unavailable' };
  }

  if (!isTrustedRepositoryPermission(repositoryPermission)) {
    return { recorded: false, reason: 'insufficient-repository-permission' };
  }

  const result = await recordReplyFeedbackEvent({
    owner,
    platform: 'github',
    repoFullName: input.payload.repository.full_name,
    prNumber: input.payload.pull_request.number,
    kiloCommentId: String(parentCommentId),
    replyExcerpt: truncateReviewMemoryFeedbackExcerpt(input.payload.comment.body),
    kiloCommentExcerpt: truncateReviewMemoryFeedbackExcerpt(parent.body),
    occurredAt: input.payload.comment.created_at ?? new Date().toISOString(),
  });

  return { recorded: result.created, eventId: result.event.id };
}

function ownerFromIntegration(integration: PlatformIntegration): ReviewMemoryOwner | null {
  if (integration.owned_by_organization_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  return null;
}

function truncateReviewMemoryFeedbackExcerpt(value: string): string {
  return value.slice(0, REVIEW_MEMORY_FEEDBACK_EXCERPT_MAX_LENGTH);
}

function isTrustedRepositoryPermission(permission: CollaboratorPermission): boolean {
  return permission === 'admin' || permission === 'write';
}

async function fetchRepositoryPermissionWithCache(
  fetchRepositoryPermission: FetchRepositoryPermission,
  input: Parameters<FetchRepositoryPermission>[0]
): Promise<CollaboratorPermission | null> {
  const cacheKey = repositoryPermissionCacheKey(input);
  const now = Date.now();
  const cached = repositoryPermissionCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAtMs > now) {
      return cached.value;
    }
    repositoryPermissionCache.delete(cacheKey);
  }

  const inFlight = repositoryPermissionInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    const permission = await fetchRepositoryPermission(input);
    if (permission !== null) {
      repositoryPermissionCache.set(cacheKey, {
        value: permission,
        expiresAtMs: Date.now() + REVIEW_MEMORY_PERMISSION_CACHE_TTL_MS,
      });
    }
    return permission;
  })();

  repositoryPermissionInFlight.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    repositoryPermissionInFlight.delete(cacheKey);
  }
}

function repositoryPermissionCacheKey(input: Parameters<FetchRepositoryPermission>[0]): string {
  return JSON.stringify([
    normalizeCacheKeyComponent(input.installationId),
    normalizeCacheKeyComponent(input.appType),
    normalizeCacheKeyComponent(input.owner),
    normalizeCacheKeyComponent(input.repo),
    normalizeCacheKeyComponent(input.username),
  ]);
}

function normalizeCacheKeyComponent(value: string): string {
  return value.trim().toLowerCase();
}

const defaultFetchParentComment: FetchParentReviewComment = async input => {
  const comment = await getGitHubReviewComment(
    input.installationId,
    input.owner,
    input.repo,
    input.commentId,
    input.appType
  );
  if (!comment) return null;
  return { id: comment.id, body: comment.body, userLogin: comment.userLogin };
};

const defaultFetchRepositoryPermission: FetchRepositoryPermission = async input => {
  return getCollaboratorPermissionLevel(
    input.installationId,
    input.owner,
    input.repo,
    input.username,
    input.appType
  );
};
