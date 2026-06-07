import type { AutoFixTicket, PlatformIntegration } from '@kilocode/db/schema';
import type {
  PullRequestReviewCommentPayload,
  PullRequestReviewPayload,
  PullRequestReviewThreadPayload,
} from '@/lib/integrations/platforms/github/webhook-schemas';
import {
  createReviewMemoryDedupeHash,
  findFeedbackSubject,
  hasFeedbackEventForSubject,
  recordFeedbackEvent,
  upsertFeedbackSubject,
  type ReviewMemoryOwner,
} from './db';
import { classifyReviewCommentReply } from './reply-classification';
import { isReviewMemoryEnabled } from './settings';
import { isLikelyKiloInlineReviewBody, parseReviewFindingMetadata } from './sync-subjects';

type GitHubFeedbackResult =
  | { recorded: boolean; eventId: string }
  | { recorded: false; reason: string };

type GitHubActor =
  | {
      login?: string;
      type?: string;
    }
  | null
  | undefined;

const KILO_GITHUB_BOT_LOGINS = new Set([
  'kilo-code',
  'kilo-code[bot]',
  'kilo-code-bot',
  'kilo-code-bot[bot]',
  'kilo-code-review-bot',
  'kilo-code-review-bot[bot]',
  'kilocode[bot]',
]);
const REPLY_STYLE_SIGNAL_KINDS = [
  'corrective_reply',
  'supportive_reply',
  'autofix_requested',
] as const;

function ownerFromIntegration(integration: PlatformIntegration): ReviewMemoryOwner | null {
  if (integration.owned_by_organization_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  return null;
}

function ownerFromAutoFixTicket(ticket: AutoFixTicket): ReviewMemoryOwner | null {
  if (ticket.owned_by_organization_id) {
    return { type: 'org', id: ticket.owned_by_organization_id };
  }
  if (ticket.owned_by_user_id) {
    return { type: 'user', id: ticket.owned_by_user_id };
  }
  return null;
}

function isLikelyKiloBotActor(actor: GitHubActor): boolean {
  const login = actor?.login?.toLowerCase() ?? '';
  return KILO_GITHUB_BOT_LOGINS.has(login);
}

function classifyGitHubAutoFixFailure(errorMessage: string | undefined): {
  sentiment: 'negative' | 'neutral';
  strength: number;
  category: string;
} {
  const normalized = errorMessage?.toLowerCase() ?? '';
  if (
    normalized.includes('balance') ||
    normalized.includes('permission') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('internal_server_error') ||
    normalized.includes('cloud agent returned 500')
  ) {
    return { sentiment: 'neutral', strength: 1, category: 'operational' };
  }

  return { sentiment: 'negative', strength: 2, category: 'unclassified' };
}

export function classifyGitHubReviewCommentReply(body: string): {
  signalKind: 'corrective_reply' | 'supportive_reply' | 'autofix_requested';
  sentiment: 'positive' | 'negative' | 'neutral';
  strength: number;
} {
  if (/@kilo\s+(fix|patch)\b/i.test(body)) {
    return { signalKind: 'autofix_requested', sentiment: 'negative', strength: 5 };
  }

  return classifyReviewCommentReply(body);
}

export async function handleGitHubReviewCommentFeedback(input: {
  payload: PullRequestReviewCommentPayload;
  integration: PlatformIntegration;
  deliveryId: string;
}): Promise<GitHubFeedbackResult> {
  if (input.payload.action !== 'created') return { recorded: false, reason: 'comment-not-created' };
  if (isLikelyKiloBotActor(input.payload.comment.user)) {
    return { recorded: false, reason: 'bot-authored-comment' };
  }

  const owner = ownerFromIntegration(input.integration);
  if (!owner) return { recorded: false, reason: 'missing-owner' };
  if (!(await isReviewMemoryEnabled({ owner, platform: 'github' }))) {
    return { recorded: false, reason: 'review-memory-disabled' };
  }

  const classification = classifyGitHubReviewCommentReply(input.payload.comment.body);
  const parentCommentId = input.payload.comment.in_reply_to_id ?? null;
  if (!parentCommentId) return { recorded: false, reason: 'not-review-comment-reply' };

  const subject = parentCommentId
    ? await findFeedbackSubject({
        owner,
        platform: 'github',
        repoFullName: input.payload.repository.full_name,
        subjectType: 'inline_comment',
        externalId: String(parentCommentId),
      })
    : null;

  if (!subject) {
    return { recorded: false, reason: 'not-kilo-subject' };
  }

  if (
    await hasFeedbackEventForSubject({
      owner,
      subjectId: subject.id,
      signalKinds: [...REPLY_STYLE_SIGNAL_KINDS],
    })
  ) {
    return { recorded: false, reason: 'subject-already-has-reply-feedback' };
  }

  const eventKey = `github:${input.deliveryId}:review-comment:${input.payload.comment.id}`;
  const result = await recordFeedbackEvent({
    owner,
    platform: 'github',
    subjectId: subject.id,
    repoFullName: input.payload.repository.full_name,
    prNumber: input.payload.pull_request.number,
    signalKind: classification.signalKind,
    sentiment: classification.sentiment,
    strength: classification.strength,
    dedupeHash: createReviewMemoryDedupeHash([eventKey]),
    evidenceExcerpt:
      classification.signalKind === 'autofix_requested'
        ? 'Auto Fix requested from review comment reply.'
        : input.payload.comment.body,
  });

  return { recorded: result.created, eventId: result.event.id };
}

export async function handleGitHubReviewFeedback(input: {
  payload: PullRequestReviewPayload;
  integration: PlatformIntegration;
  deliveryId: string;
}): Promise<GitHubFeedbackResult> {
  const owner = ownerFromIntegration(input.integration);
  if (!owner) return { recorded: false, reason: 'missing-owner' };
  if (!(await isReviewMemoryEnabled({ owner, platform: 'github' }))) {
    return { recorded: false, reason: 'review-memory-disabled' };
  }

  if (input.payload.action === 'dismissed') {
    if (!isLikelyKiloBotActor(input.payload.review.user)) {
      return { recorded: false, reason: 'non-kilo-review' };
    }
    const subject = await upsertFeedbackSubject({
      owner,
      platform: 'github',
      subjectType: 'review',
      externalId: String(input.payload.review.id),
      repoFullName: input.payload.repository.full_name,
      prNumber: input.payload.pull_request.number,
      state: 'dismissed',
    });
    const eventKey = `github:${input.deliveryId}:review-dismissed:${input.payload.review.id}`;
    const result = await recordFeedbackEvent({
      owner,
      platform: 'github',
      subjectId: subject.id,
      repoFullName: input.payload.repository.full_name,
      prNumber: input.payload.pull_request.number,
      signalKind: 'review_dismissed',
      sentiment: 'negative',
      strength: 4,
      dedupeHash: createReviewMemoryDedupeHash([eventKey]),
      evidenceExcerpt: 'Kilo review was dismissed.',
    });
    return { recorded: result.created, eventId: result.event.id };
  }

  if (input.payload.action === 'submitted') {
    const state = input.payload.review.state;
    if (state !== 'approved' && state !== 'changes_requested') {
      return { recorded: false, reason: 'unsupported-review-state' };
    }
    const eventKey = `github:${input.deliveryId}:review:${input.payload.review.id}:${state}`;
    const result = await recordFeedbackEvent({
      owner,
      platform: 'github',
      repoFullName: input.payload.repository.full_name,
      prNumber: input.payload.pull_request.number,
      signalKind: state === 'approved' ? 'pr_approved' : 'pr_changes_requested',
      sentiment: state === 'approved' ? 'positive' : 'negative',
      strength: 1,
      dedupeHash: createReviewMemoryDedupeHash([eventKey]),
      evidenceExcerpt: null,
    });
    return { recorded: result.created, eventId: result.event.id };
  }

  return { recorded: false, reason: 'unsupported-review-action' };
}

export async function handleGitHubReviewThreadFeedback(input: {
  payload: PullRequestReviewThreadPayload;
  integration: PlatformIntegration;
  deliveryId: string;
}): Promise<GitHubFeedbackResult> {
  if (isLikelyKiloBotActor(input.payload.sender)) {
    return { recorded: false, reason: 'bot-authored-thread-event' };
  }
  const owner = ownerFromIntegration(input.integration);
  if (!owner) return { recorded: false, reason: 'missing-owner' };
  if (!(await isReviewMemoryEnabled({ owner, platform: 'github' }))) {
    return { recorded: false, reason: 'review-memory-disabled' };
  }

  const kiloComment = input.payload.thread.comments.find(comment =>
    isLikelyKiloInlineReviewBody(comment.body)
  );
  if (!kiloComment) return { recorded: false, reason: 'not-kilo-thread' };

  const metadata = parseReviewFindingMetadata(kiloComment.body);
  const subject = await upsertFeedbackSubject({
    owner,
    platform: 'github',
    subjectType: 'discussion',
    externalId: input.payload.thread.id,
    externalThreadId: input.payload.thread.id,
    repoFullName: input.payload.repository.full_name,
    prNumber: input.payload.pull_request.number,
    filePath: kiloComment.path ?? null,
    findingTitle: metadata.findingTitle,
    findingFingerprint: metadata.findingFingerprint,
    state: input.payload.action === 'resolved' ? 'resolved' : 'active',
  });

  const signalKind = input.payload.action === 'resolved' ? 'thread_resolved' : 'thread_unresolved';
  const eventKey = `github:${input.deliveryId}:thread:${input.payload.thread.id}:${input.payload.action}`;
  const result = await recordFeedbackEvent({
    owner,
    platform: 'github',
    subjectId: subject.id,
    repoFullName: input.payload.repository.full_name,
    prNumber: input.payload.pull_request.number,
    signalKind,
    sentiment: input.payload.action === 'resolved' ? 'positive' : 'negative',
    strength: 2,
    dedupeHash: createReviewMemoryDedupeHash([eventKey]),
    evidenceExcerpt:
      input.payload.action === 'resolved' ? 'Review thread resolved.' : 'Review thread reopened.',
  });

  return { recorded: result.created, eventId: result.event.id };
}

export async function recordGitHubAutoFixFeedback(input: {
  ticket: AutoFixTicket;
  outcome: 'success' | 'failed';
  errorMessage?: string;
}): Promise<GitHubFeedbackResult> {
  if (!input.ticket.review_comment_id) {
    return { recorded: false, reason: 'missing-review-comment-id' };
  }

  const owner = ownerFromAutoFixTicket(input.ticket);
  if (!owner) return { recorded: false, reason: 'missing-owner' };
  if (!(await isReviewMemoryEnabled({ owner, platform: 'github' }))) {
    return { recorded: false, reason: 'review-memory-disabled' };
  }

  const subject = await findFeedbackSubject({
    owner,
    platform: 'github',
    repoFullName: input.ticket.repo_full_name,
    subjectType: 'inline_comment',
    externalId: String(input.ticket.review_comment_id),
  });
  const failure =
    input.outcome === 'failed' ? classifyGitHubAutoFixFailure(input.errorMessage) : null;
  const signalKind = input.outcome === 'success' ? 'autofix_completed' : 'autofix_failed';
  const eventKey = `github:auto-fix:${input.ticket.id}:${signalKind}`;
  const result = await recordFeedbackEvent({
    owner,
    platform: 'github',
    subjectId: subject?.id ?? null,
    repoFullName: input.ticket.repo_full_name,
    prNumber: input.ticket.issue_number,
    signalKind,
    sentiment: input.outcome === 'success' ? 'positive' : (failure?.sentiment ?? 'negative'),
    strength: input.outcome === 'success' ? 2 : (failure?.strength ?? 2),
    dedupeHash: createReviewMemoryDedupeHash([eventKey]),
    evidenceExcerpt:
      input.outcome === 'success'
        ? 'Auto Fix completed for requested review feedback.'
        : input.errorMessage
          ? `Auto Fix failed: ${input.errorMessage}`
          : 'Auto Fix failed for requested review feedback.',
    occurredAt: input.ticket.completed_at ?? null,
  });

  return { recorded: result.created, eventId: result.event.id };
}
