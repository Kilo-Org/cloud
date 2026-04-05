/**
 * Shared handler for posting review-comment replies (success / failure).
 *
 * Extracted so both the dedicated `/api/internal/auto-fix/comment-reply`
 * endpoint and the `pr-callback` route can call it directly without an
 * extra HTTP round-trip.
 */

import { getFixTicketById, updateFixTicketStatus } from '@/lib/auto-fix/db/fix-tickets';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import {
  replyToReviewComment,
  addReactionToPRReviewComment,
  getPRHeadCommit,
} from '@/lib/integrations/platforms/github/adapter';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { z } from 'zod';

export const CommentReplyPayloadSchema = z.object({
  ticketId: z.string().min(1),
  sessionId: z.string().optional(),
  outcome: z.enum(['success', 'failed']),
  errorMessage: z.string().optional(),
  prBranch: z.string().optional(),
});

export type CommentReplyPayload = z.infer<typeof CommentReplyPayloadSchema>;

type CommentReplyResult =
  | { ok: true; action: string }
  | { ok: false; error: string; status: number };

function getFixTarget(filePath: string | null, lineNumber: number | null): string {
  if (filePath && lineNumber) {
    return `\`${filePath}:${lineNumber}\``;
  }

  if (filePath) {
    return `\`${filePath}\``;
  }

  return 'the requested code path';
}

function buildSuccessReplyBody(params: {
  fixTarget: string;
  commitSha?: string;
  commitUrl?: string;
}): string {
  if (params.commitSha && params.commitUrl) {
    return `Implemented the requested fix around ${params.fixTarget} and pushed [\`${params.commitSha}\`](${params.commitUrl}).`;
  }

  return `Implemented the requested fix around ${params.fixTarget} and pushed it to this PR branch.`;
}

const PUBLIC_ERROR_MAX_LENGTH = 500;

/** Strip URLs, file paths, and stack traces that may leak infra details. */
export function sanitizePublicErrorMessage(raw: string): string {
  return (
    raw
      // collapse multi-line stack traces to a single "(stack trace omitted)" note
      .replace(/(\n\s+at\s.+)+/g, '\n(stack trace omitted)')
      // strip URLs that aren't github.com
      .replace(/https?:\/\/(?!github\.com)[^\s)]+/g, '[internal-url]')
      // redact absolute file paths that may leak infra layout
      .replace(/\/(?:home|var|tmp|usr|opt|etc|root|srv)\/[^\s)]+/g, '[internal-path]')
      .slice(0, PUBLIC_ERROR_MAX_LENGTH)
  );
}

type FriendlyFailure = {
  summary: string;
  suggestedAction: string;
};

function getFriendlyFailure(rawError: string): FriendlyFailure {
  const normalized = rawError.toLowerCase();

  if (normalized.includes('failed to verify balance') || normalized.includes('balance check')) {
    return {
      summary: 'I could not start this fix because the account balance check failed.',
      suggestedAction: 'Confirm your Kilo account has available credits, then retry the fix.',
    };
  }

  if (normalized.includes('permission to') && normalized.includes('denied')) {
    return {
      summary: 'I prepared a fix but could not push it to GitHub due to repository permissions.',
      suggestedAction:
        'Grant the Kilo GitHub App write access to repository contents, then retry the fix.',
    };
  }

  if (normalized.includes('timeout')) {
    return {
      summary: 'The auto-fix run timed out before it could finish.',
      suggestedAction:
        'Retry the fix. If it keeps timing out, request a smaller change scope in your comment.',
    };
  }

  if (
    normalized.includes('cloud agent returned 500') ||
    normalized.includes('internal_server_error')
  ) {
    return {
      summary: 'The auto-fix service encountered an internal error while preparing this change.',
      suggestedAction: 'Retry in a minute. If it keeps failing, share the session ID below.',
    };
  }

  return {
    summary: 'The auto-fix run failed before it could push an updated commit.',
    suggestedAction: 'Retry with more guidance, or apply the fix manually.',
  };
}

/**
 * Core logic for handling a review-comment reply (success or failure).
 * Returns a result object; callers decide how to serialise the response.
 */
export async function handleCommentReply(
  payload: CommentReplyPayload
): Promise<CommentReplyResult> {
  const { ticketId, sessionId, outcome } = payload;

  logExceptInTest('[auto-fix-comment-reply] Processing comment reply', {
    ticketId,
    sessionId,
    outcome,
    hasError: !!payload.errorMessage,
  });

  const ticket = await getFixTicketById(ticketId);

  if (!ticket) {
    logExceptInTest('[auto-fix-comment-reply] Ticket not found', { ticketId });
    return { ok: false, error: 'Ticket not found', status: 404 };
  }

  if (!ticket.review_comment_id) {
    logExceptInTest('[auto-fix-comment-reply] Not a review comment ticket', {
      ticketId,
      triggerSource: ticket.trigger_source,
      reviewCommentId: ticket.review_comment_id,
    });
    return { ok: false, error: 'Ticket is not a review comment trigger', status: 400 };
  }

  const isTerminalState =
    ticket.status === 'completed' || ticket.status === 'failed' || ticket.status === 'cancelled';
  if (isTerminalState) {
    logExceptInTest('[auto-fix-comment-reply] Ticket already terminal, skipping duplicate reply', {
      ticketId,
      status: ticket.status,
    });
    return { ok: true, action: 'skipped_terminal' };
  }

  // Resolve GitHub installation ID
  let installationId: string | undefined;
  if (ticket.platform_integration_id) {
    try {
      const integration = await getIntegrationById(ticket.platform_integration_id);
      installationId = integration?.platform_installation_id ?? undefined;
    } catch (error) {
      errorExceptInTest('[auto-fix-comment-reply] Failed to get integration:', error);
    }
  }

  if (!installationId) {
    errorExceptInTest('[auto-fix-comment-reply] No installation ID found', { ticketId });
    return { ok: false, error: 'GitHub installation not found', status: 500 };
  }

  const [repoOwner, repoName] = ticket.repo_full_name.split('/');

  if (!repoOwner || !repoName) {
    return { ok: false, error: `Invalid repo_full_name: ${ticket.repo_full_name}`, status: 400 };
  }

  try {
    if (outcome === 'success') {
      // +1 reaction on the review comment
      try {
        await addReactionToPRReviewComment(
          installationId,
          repoOwner,
          repoName,
          ticket.review_comment_id,
          '+1'
        );
        logExceptInTest('[auto-fix-comment-reply] Added +1 reaction on review comment', {
          ticketId,
          prNumber: ticket.issue_number,
          commentId: ticket.review_comment_id,
        });
      } catch (reactionError) {
        errorExceptInTest(
          '[auto-fix-comment-reply] Failed to add +1 reaction (non-fatal):',
          reactionError
        );
      }

      const fixTarget = getFixTarget(ticket.file_path, ticket.line_number);
      let successReplyBody = buildSuccessReplyBody({ fixTarget });

      try {
        const headCommitSha = await getPRHeadCommit(
          installationId,
          repoOwner,
          repoName,
          ticket.issue_number
        );
        const shortSha = headCommitSha.slice(0, 8);
        const commitUrl = `https://github.com/${repoOwner}/${repoName}/commit/${headCommitSha}`;
        successReplyBody = buildSuccessReplyBody({ fixTarget, commitSha: shortSha, commitUrl });
      } catch (commitLookupError) {
        errorExceptInTest(
          '[auto-fix-comment-reply] Failed to fetch PR head commit for success reply (non-fatal):',
          commitLookupError
        );
      }

      try {
        await replyToReviewComment(
          installationId,
          repoOwner,
          repoName,
          ticket.issue_number,
          ticket.review_comment_id,
          successReplyBody
        );
        logExceptInTest('[auto-fix-comment-reply] Posted success reply on review thread', {
          ticketId,
          prNumber: ticket.issue_number,
          commentId: ticket.review_comment_id,
        });
      } catch (successReplyError) {
        errorExceptInTest(
          '[auto-fix-comment-reply] Failed to post success reply (non-fatal):',
          successReplyError
        );
        captureException(successReplyError, {
          tags: { operation: 'auto-fix-comment-reply', step: 'post-success-reply' },
          extra: { ticketId, sessionId, prNumber: ticket.issue_number },
        });
      }

      await updateFixTicketStatus(ticketId, 'completed', {
        sessionId,
        prBranch: payload.prBranch || ticket.pr_head_ref || undefined,
        completedAt: new Date(),
      });

      return { ok: true, action: 'reaction_and_reply' };
    }

    // Failure path
    const failureReason = payload.errorMessage?.trim() || 'Unknown error';
    const friendlyFailure = getFriendlyFailure(failureReason);
    const traceLine = sessionId ? `- Session ID: \`${sessionId}\`` : '- Session ID: unavailable';
    const sanitizedReason = sanitizePublicErrorMessage(failureReason);
    const replyBody = [
      "I couldn't apply this fix automatically this time.",
      '',
      friendlyFailure.summary,
      '',
      'Next steps:',
      `- ${friendlyFailure.suggestedAction}`,
      traceLine,
      '',
      '<details>',
      '<summary>Technical details</summary>',
      '',
      '```',
      sanitizedReason,
      '```',
      '</details>',
    ].join('\n');

    await replyToReviewComment(
      installationId,
      repoOwner,
      repoName,
      ticket.issue_number,
      ticket.review_comment_id,
      replyBody
    );

    logExceptInTest('[auto-fix-comment-reply] Posted failure reply on review thread', {
      ticketId,
      prNumber: ticket.issue_number,
      commentId: ticket.review_comment_id,
    });

    // confused reaction on failure (best effort)
    try {
      await addReactionToPRReviewComment(
        installationId,
        repoOwner,
        repoName,
        ticket.review_comment_id,
        'confused'
      );
    } catch {
      // Best-effort reaction
    }

    await updateFixTicketStatus(ticketId, 'failed', {
      sessionId,
      errorMessage: failureReason,
      completedAt: new Date(),
    });

    return { ok: true, action: 'reply' };
  } catch (replyError) {
    errorExceptInTest('[auto-fix-comment-reply] Failed to notify review comment:', replyError);
    captureException(replyError, {
      tags: { operation: 'auto-fix-comment-reply', step: 'reply-to-comment' },
      extra: { ticketId, sessionId, outcome },
    });

    // Try to add failure reaction
    try {
      await addReactionToPRReviewComment(
        installationId,
        repoOwner,
        repoName,
        ticket.review_comment_id,
        'confused'
      );
    } catch {
      // Best-effort reaction
    }

    await updateFixTicketStatus(ticketId, 'failed', {
      sessionId,
      errorMessage: `Failed to notify review comment: ${replyError instanceof Error ? replyError.message : String(replyError)}`,
      completedAt: new Date(),
    });

    return {
      ok: false,
      error: replyError instanceof Error ? replyError.message : String(replyError),
      status: 500,
    };
  }
}
