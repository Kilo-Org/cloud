import type { AutoFixTicket, PlatformIntegration } from '@kilocode/db/schema';
import type {
  PullRequestReviewCommentPayload,
  PullRequestReviewPayload,
  PullRequestReviewThreadPayload,
  ReactionPayload,
} from '@/lib/integrations/platforms/github/webhook-schemas';
import {
  createReviewMemoryDedupeHash,
  findFeedbackSubject,
  recordFeedbackEvent,
  upsertFeedbackSubject,
  type ReviewMemoryOwner,
} from './db';
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

const POSITIVE_REACTIONS = new Set(['+1', 'heart', 'hooray', 'rocket']);
const NEGATIVE_REACTIONS = new Set(['-1', 'confused']);

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
  return actor?.type === 'Bot' || login.endsWith('[bot]') || login.includes('kilo');
}

function pullNumberFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const match = url.match(/\/pull\/(\d+)/);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : null;
}

function reactionSentiment(content: string): {
  signalKind: 'positive_reaction' | 'negative_reaction';
  sentiment: 'positive' | 'negative';
  strength: number;
} | null {
  if (POSITIVE_REACTIONS.has(content)) {
    return { signalKind: 'positive_reaction', sentiment: 'positive', strength: 2 };
  }
  if (NEGATIVE_REACTIONS.has(content)) {
    return { signalKind: 'negative_reaction', sentiment: 'negative', strength: 3 };
  }
  return null;
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
  const normalized = body.toLowerCase();
  if (/@kilo\s+(fix|patch)\b/i.test(body)) {
    return { signalKind: 'autofix_requested', sentiment: 'negative', strength: 5 };
  }

  const correctivePatterns = [
    'false positive',
    'not an issue',
    'incorrect',
    'wrong',
    'this is expected',
    'expected behavior',
    'does not apply',
    'please remove',
    'unhelpful',
  ];
  if (correctivePatterns.some(pattern => normalized.includes(pattern))) {
    return { signalKind: 'corrective_reply', sentiment: 'negative', strength: 3 };
  }

  const supportivePatterns = [
    'good catch',
    'nice catch',
    'thanks',
    'thank you',
    'fixed',
    'resolved',
    'agreed',
    'makes sense',
  ];
  if (supportivePatterns.some(pattern => normalized.includes(pattern))) {
    return { signalKind: 'supportive_reply', sentiment: 'positive', strength: 2 };
  }

  return { signalKind: 'supportive_reply', sentiment: 'neutral', strength: 1 };
}

async function findOrUpsertCommentSubject(params: {
  owner: ReviewMemoryOwner;
  integration: PlatformIntegration;
  repoFullName: string;
  prNumber: number | null;
  prUrl: string | null;
  headSha?: string | null;
  comment: {
    id: number;
    body?: string;
    html_url?: string;
    path?: string;
    line?: number | null;
    diff_hunk?: string;
  };
}) {
  const externalId = String(params.comment.id);
  const body = params.comment.body ?? '';
  const existingInline = await findFeedbackSubject({
    owner: params.owner,
    platform: 'github',
    repoFullName: params.repoFullName,
    subjectType: 'inline_comment',
    externalId,
  });
  if (existingInline) return existingInline;

  const existingSummary = await findFeedbackSubject({
    owner: params.owner,
    platform: 'github',
    repoFullName: params.repoFullName,
    subjectType: 'summary_comment',
    externalId,
  });
  if (existingSummary) return existingSummary;

  const isSummary = body.includes('<!-- kilo-review -->');
  const isInline = isLikelyKiloInlineReviewBody(body);
  if (!isSummary && !isInline) return null;

  const metadata = isInline ? parseReviewFindingMetadata(body) : null;
  return await upsertFeedbackSubject({
    owner: params.owner,
    platform: 'github',
    platformIntegrationId: params.integration.id,
    subjectType: isSummary ? 'summary_comment' : 'inline_comment',
    externalId,
    externalUrl: params.comment.html_url ?? null,
    repoFullName: params.repoFullName,
    prNumber: params.prNumber,
    prUrl: params.prUrl,
    headSha: params.headSha,
    filePath: params.comment.path ?? null,
    lineNumber: params.comment.line ?? null,
    diffHunk: params.comment.diff_hunk ?? null,
    bodyExcerpt: body,
    severity: metadata?.severity ?? null,
    findingTitle: metadata?.findingTitle ?? null,
    findingFingerprint: metadata?.findingFingerprint ?? null,
    state: 'active',
  });
}

export async function handleGitHubReactionFeedback(input: {
  payload: ReactionPayload;
  integration: PlatformIntegration;
  deliveryId: string;
}): Promise<GitHubFeedbackResult> {
  if (input.payload.action !== 'created')
    return { recorded: false, reason: 'reaction-not-created' };
  if (isLikelyKiloBotActor(input.payload.sender ?? input.payload.reaction.user)) {
    return { recorded: false, reason: 'bot-authored-reaction' };
  }

  const owner = ownerFromIntegration(input.integration);
  if (!owner) return { recorded: false, reason: 'missing-owner' };

  const sentiment = reactionSentiment(input.payload.reaction.content);
  if (!sentiment) return { recorded: false, reason: 'unsupported-reaction' };
  if (!input.payload.comment) return { recorded: false, reason: 'missing-comment' };

  const prNumber =
    input.payload.pull_request?.number ??
    input.payload.issue?.number ??
    pullNumberFromUrl(input.payload.comment.html_url);
  const prUrl =
    input.payload.pull_request?.html_url ??
    input.payload.issue?.html_url ??
    input.payload.comment.html_url ??
    null;
  const subject = await findOrUpsertCommentSubject({
    owner,
    integration: input.integration,
    repoFullName: input.payload.repository.full_name,
    prNumber,
    prUrl,
    headSha: input.payload.pull_request?.head?.sha ?? null,
    comment: input.payload.comment,
  });

  if (!subject) return { recorded: false, reason: 'not-kilo-subject' };

  const result = await recordFeedbackEvent({
    owner,
    platform: 'github',
    platformIntegrationId: input.integration.id,
    subjectId: subject.id,
    codeReviewId: subject.code_review_id,
    repoFullName: input.payload.repository.full_name,
    prNumber,
    prUrl,
    eventSource: 'github_webhook',
    signalKind: sentiment.signalKind,
    sentiment: sentiment.sentiment,
    strength: sentiment.strength,
    externalEventId: `github:${input.deliveryId}:reaction:${input.payload.reaction.id}`,
    externalUrl: input.payload.comment.html_url ?? prUrl,
    evidenceExcerpt: `Reaction: ${input.payload.reaction.content}`,
    metadata: { reaction: input.payload.reaction.content },
    occurredAt: input.payload.reaction.created_at ?? null,
  });

  return { recorded: result.created, eventId: result.event.id };
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

  if (!subject && classification.signalKind !== 'autofix_requested') {
    return { recorded: false, reason: 'not-kilo-subject' };
  }

  const prUrl = input.payload.pull_request.html_url ?? null;
  const result = await recordFeedbackEvent({
    owner,
    platform: 'github',
    platformIntegrationId: input.integration.id,
    subjectId: subject?.id ?? null,
    codeReviewId: subject?.code_review_id ?? null,
    repoFullName: input.payload.repository.full_name,
    prNumber: input.payload.pull_request.number,
    prUrl,
    eventSource: 'github_webhook',
    signalKind: classification.signalKind,
    sentiment: classification.sentiment,
    strength: classification.strength,
    externalEventId: `github:${input.deliveryId}:review-comment:${input.payload.comment.id}`,
    externalUrl: input.payload.comment.html_url,
    evidenceExcerpt: input.payload.comment.body,
    metadata: parentCommentId ? { parent_review_comment_id: parentCommentId } : {},
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

  if (input.payload.action === 'dismissed') {
    if (!isLikelyKiloBotActor(input.payload.review.user)) {
      return { recorded: false, reason: 'non-kilo-review' };
    }
    const subject = await upsertFeedbackSubject({
      owner,
      platform: 'github',
      platformIntegrationId: input.integration.id,
      subjectType: 'review',
      externalId: String(input.payload.review.id),
      externalUrl: input.payload.pull_request.html_url,
      repoFullName: input.payload.repository.full_name,
      prNumber: input.payload.pull_request.number,
      prUrl: input.payload.pull_request.html_url,
      headSha: input.payload.pull_request.head.sha,
      state: 'dismissed',
    });
    const result = await recordFeedbackEvent({
      owner,
      platform: 'github',
      platformIntegrationId: input.integration.id,
      subjectId: subject.id,
      repoFullName: input.payload.repository.full_name,
      prNumber: input.payload.pull_request.number,
      prUrl: input.payload.pull_request.html_url,
      eventSource: 'github_webhook',
      signalKind: 'review_dismissed',
      sentiment: 'negative',
      strength: 4,
      externalEventId: `github:${input.deliveryId}:review-dismissed:${input.payload.review.id}`,
      externalUrl: input.payload.pull_request.html_url,
      evidenceExcerpt: 'Kilo review was dismissed.',
    });
    return { recorded: result.created, eventId: result.event.id };
  }

  if (input.payload.action === 'submitted') {
    const state = input.payload.review.state;
    if (state !== 'approved' && state !== 'changes_requested') {
      return { recorded: false, reason: 'unsupported-review-state' };
    }
    const result = await recordFeedbackEvent({
      owner,
      platform: 'github',
      platformIntegrationId: input.integration.id,
      repoFullName: input.payload.repository.full_name,
      prNumber: input.payload.pull_request.number,
      prUrl: input.payload.pull_request.html_url,
      eventSource: 'github_webhook',
      signalKind: state === 'approved' ? 'pr_approved' : 'pr_changes_requested',
      sentiment: state === 'approved' ? 'positive' : 'negative',
      strength: 1,
      externalEventId: `github:${input.deliveryId}:review:${input.payload.review.id}:${state}`,
      externalUrl: input.payload.pull_request.html_url,
      evidenceExcerpt: state === 'approved' ? 'Pull request approved.' : 'Changes requested.',
      metadata: { review_state: state },
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

  const kiloComment = input.payload.thread.comments.find(comment =>
    isLikelyKiloInlineReviewBody(comment.body)
  );
  if (!kiloComment) return { recorded: false, reason: 'not-kilo-thread' };

  const metadata = parseReviewFindingMetadata(kiloComment.body);
  const subject = await upsertFeedbackSubject({
    owner,
    platform: 'github',
    platformIntegrationId: input.integration.id,
    subjectType: 'discussion',
    externalId: input.payload.thread.id,
    externalThreadId: input.payload.thread.id,
    externalUrl: kiloComment.html_url ?? input.payload.pull_request.html_url ?? null,
    repoFullName: input.payload.repository.full_name,
    prNumber: input.payload.pull_request.number,
    prUrl: input.payload.pull_request.html_url ?? null,
    headSha: input.payload.pull_request.head?.sha ?? null,
    filePath: kiloComment.path ?? null,
    lineNumber: kiloComment.line ?? null,
    diffHunk: kiloComment.diff_hunk ?? null,
    bodyExcerpt: kiloComment.body,
    severity: metadata.severity,
    findingTitle: metadata.findingTitle,
    findingFingerprint: metadata.findingFingerprint,
    state: input.payload.action === 'resolved' ? 'resolved' : 'active',
  });

  const signalKind = input.payload.action === 'resolved' ? 'thread_resolved' : 'thread_unresolved';
  const result = await recordFeedbackEvent({
    owner,
    platform: 'github',
    platformIntegrationId: input.integration.id,
    subjectId: subject.id,
    codeReviewId: subject.code_review_id,
    repoFullName: input.payload.repository.full_name,
    prNumber: input.payload.pull_request.number,
    prUrl: input.payload.pull_request.html_url ?? null,
    eventSource: 'github_webhook',
    signalKind,
    sentiment: input.payload.action === 'resolved' ? 'positive' : 'negative',
    strength: 2,
    externalEventId: `github:${input.deliveryId}:thread:${input.payload.thread.id}:${input.payload.action}`,
    externalUrl: kiloComment.html_url ?? input.payload.pull_request.html_url ?? null,
    evidenceExcerpt:
      input.payload.action === 'resolved' ? 'Review thread resolved.' : 'Review thread reopened.',
    metadata: { thread_id: input.payload.thread.id },
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
  const externalEventId = `github:auto-fix:${input.ticket.id}:${signalKind}`;
  const result = await recordFeedbackEvent({
    owner,
    platform: 'github',
    platformIntegrationId: input.ticket.platform_integration_id,
    subjectId: subject?.id ?? null,
    codeReviewId: subject?.code_review_id ?? null,
    repoFullName: input.ticket.repo_full_name,
    prNumber: input.ticket.issue_number,
    prUrl: input.ticket.issue_url,
    eventSource: 'auto_fix',
    signalKind,
    sentiment: input.outcome === 'success' ? 'positive' : (failure?.sentiment ?? 'negative'),
    strength: input.outcome === 'success' ? 2 : (failure?.strength ?? 2),
    externalEventId,
    dedupeHash: createReviewMemoryDedupeHash([externalEventId]),
    externalUrl: input.ticket.issue_url,
    evidenceExcerpt:
      input.outcome === 'success'
        ? 'Auto Fix completed for requested review feedback.'
        : input.errorMessage
          ? `Auto Fix failed: ${input.errorMessage}`
          : 'Auto Fix failed for requested review feedback.',
    metadata: {
      ticket_id: input.ticket.id,
      review_comment_id: input.ticket.review_comment_id,
      failure_category: failure?.category,
    },
    occurredAt: input.ticket.completed_at ?? null,
  });

  return { recorded: result.created, eventId: result.event.id };
}
