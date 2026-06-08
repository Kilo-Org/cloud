import type { PlatformIntegration } from '@kilocode/db/schema';

import {
  getGitHubReviewComment,
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

const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const REVIEW_MEMORY_FEEDBACK_EXCERPT_MAX_LENGTH = 2_000;

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

export async function handleGitHubReviewCommentReply(input: {
  payload: PullRequestReviewCommentPayload;
  integration: PlatformIntegration;
  deliveryId: string;
  fetchParentComment?: FetchParentReviewComment;
}): Promise<{ recorded: boolean; reason?: string; eventId?: string }> {
  if (input.payload.action !== 'created') return { recorded: false, reason: 'comment-not-created' };

  const parentCommentId = input.payload.comment.in_reply_to_id ?? null;
  if (!parentCommentId) return { recorded: false, reason: 'not-review-comment-reply' };

  if (isLikelyKiloBotActor(input.payload.comment.user.login)) {
    return { recorded: false, reason: 'bot-authored-comment' };
  }

  if (!MAINTAINER_AUTHOR_ASSOCIATIONS.has(input.payload.comment.author_association)) {
    return { recorded: false, reason: 'not-maintainer-reply' };
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
