/**
 * Internal API Endpoint: Create GitHub PR (Auto Fix)
 *
 * Called by:
 * - Auto Fix Worker (after Cloud Agent completes)
 *
 * Process:
 * 1. Receive ticket ID, session ID, and config
 * 2. Verify branch exists on GitHub
 * 3. Create PR on GitHub
 * 4. Update ticket with PR details
 * 5. Post comment on original issue
 *
 * URL: POST /api/internal/auto-fix/create-pr
 * Protected by internal API secret
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getFixTicketById, updateFixTicketStatus } from '@/lib/auto-fix/db/fix-tickets';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { createPullRequest } from '@/lib/auto-fix/github/create-pull-request';
import { postIssueComment } from '@/lib/auto-fix/github/post-comment';

interface CreatePRPayload {
  ticketId: string;
  sessionId: string;
  branchName?: string; // Optional: actual branch name created by agent (defaults to session/{sessionId})
  githubToken: string;
  config: {
    pr_base_branch: string;
    pr_title_template: string;
    pr_body_template?: string | null;
  };
}

export async function POST(req: NextRequest) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload: CreatePRPayload = await req.json();
    const { ticketId, sessionId, branchName: providedBranchName, githubToken, config } = payload;

    // Validate payload
    if (!ticketId || !sessionId || !githubToken || !config) {
      return NextResponse.json(
        { error: 'Missing required fields: ticketId, sessionId, githubToken, config' },
        { status: 400 }
      );
    }

    logExceptInTest('[auto-fix-create-pr] Creating GitHub PR', {
      ticketId,
      sessionId,
    });

    // Get ticket
    const ticket = await getFixTicketById(ticketId);

    if (!ticket) {
      logExceptInTest('[auto-fix-create-pr] Ticket not found', { ticketId });
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    // Review-comment tickets should never go through this endpoint.
    // They are handled entirely via handleCommentReply in the pr-callback route.
    if (ticket.review_comment_id != null) {
      errorExceptInTest(
        '[auto-fix-create-pr] Rejecting review-comment ticket — use pr-callback instead',
        { ticketId, reviewCommentId: ticket.review_comment_id }
      );
      captureMessage('create-pr called for review-comment ticket', {
        level: 'warning',
        tags: { source: 'auto-fix-create-pr' },
        extra: {
          ticketId,
          sessionId,
          reviewCommentId: ticket.review_comment_id,
          triggerSource: ticket.trigger_source,
        },
      });
      return NextResponse.json(
        { error: 'Review-comment tickets are handled via pr-callback, not create-pr' },
        { status: 400 }
      );
    }

    const isTerminalState =
      ticket.status === 'completed' || ticket.status === 'failed' || ticket.status === 'cancelled';

    if (isTerminalState) {
      logExceptInTest('[auto-fix-create-pr] Ticket already in terminal state, skipping', {
        ticketId,
        currentStatus: ticket.status,
      });
      return NextResponse.json({
        success: true,
        message: 'Ticket already in terminal state',
        currentStatus: ticket.status,
      });
    }

    try {
      // Use the provided branch name if available, otherwise default to session/{sessionId}
      // The agent may create a branch based on the prompt (e.g., auto-fix/{ticketId})
      const branchName = providedBranchName || `session/${sessionId}`;

      logExceptInTest('[auto-fix-create-pr] Using branch name', {
        ticketId,
        branchName,
        wasProvided: !!providedBranchName,
      });

      // Apply title template
      const prTitle = config.pr_title_template
        .replace('{issue_number}', ticket.issue_number.toString())
        .replace('{issue_title}', ticket.issue_title);

      // Apply body template or use default
      const prBody =
        config.pr_body_template ||
        `Fixes #${ticket.issue_number}

This pull request was automatically created by Kilo Auto-Fix to address the issue.

## Changes

The changes implement the fix as described in the original issue.

## Classification

- **Type**: ${ticket.classification || 'unknown'}
- **Confidence**: ${ticket.confidence ? (Number(ticket.confidence) * 100).toFixed(0) : 'N/A'}%
- **Intent**: ${ticket.intent_summary || 'N/A'}

---

*This PR was created automatically by [Kilo Auto-Fix](https://kilo.ai). Please review the changes carefully before merging.*`;

      const baseBranch = config.pr_base_branch || 'main';

      const pr = await createPullRequest({
        repoFullName: ticket.repo_full_name,
        baseBranch,
        headBranch: branchName,
        title: prTitle,
        body: prBody,
        githubToken,
      });

      logExceptInTest('[auto-fix-create-pr] GitHub PR created', {
        ticketId,
        prNumber: pr.number,
        prUrl: pr.url,
      });

      // Update ticket with PR details
      await updateFixTicketStatus(ticketId, 'completed', {
        prNumber: pr.number,
        prUrl: pr.url,
        prBranch: branchName,
        completedAt: new Date(),
      });

      // Post comment on issue linking to PR
      try {
        await postIssueComment({
          repoFullName: ticket.repo_full_name,
          issueNumber: ticket.issue_number,
          body: `🤖 **Auto-Fix Update**\n\nI've created a pull request to fix this issue: ${pr.url}\n\nPlease review the changes and provide feedback. If the fix looks good, feel free to merge it!`,
          githubToken,
        });

        logExceptInTest('[auto-fix-create-pr] Posted success comment', { ticketId });
      } catch (commentError) {
        errorExceptInTest('[auto-fix-create-pr] Failed to post success comment:', commentError);
        captureException(commentError, {
          tags: { operation: 'auto-fix-create-pr', step: 'post-success-comment' },
          extra: { ticketId, sessionId, prNumber: pr.number },
        });
        // Continue - comment failure is not critical
      }

      return NextResponse.json({ success: true, prNumber: pr.number, prUrl: pr.url });
    } catch (prError) {
      errorExceptInTest('[auto-fix-create-pr] Failed to create GitHub PR:', prError);
      captureException(prError, {
        tags: { operation: 'auto-fix-create-pr', step: 'create-github-pr' },
        extra: { ticketId, sessionId },
      });

      // Update ticket to failed
      await updateFixTicketStatus(ticketId, 'failed', {
        errorMessage: `Failed to create GitHub PR: ${prError instanceof Error ? prError.message : String(prError)}`,
        completedAt: new Date(),
      });

      // Post comment on issue explaining failure
      try {
        // Use the same branch name logic as above
        const branchName = providedBranchName || `session/${sessionId}`;

        await postIssueComment({
          repoFullName: ticket.repo_full_name,
          issueNumber: ticket.issue_number,
          body: `🤖 **Auto-Fix Update**\n\nI successfully implemented changes to fix this issue, but encountered an error while creating the pull request:\n\n\`\`\`\n${prError instanceof Error ? prError.message : String(prError)}\n\`\`\`\n\nThe changes are available on branch \`${branchName}\`.`,
          githubToken,
        });
      } catch (commentError) {
        errorExceptInTest('[auto-fix-create-pr] Failed to post PR error comment:', commentError);
        // Continue - comment failure is not critical
      }

      return NextResponse.json(
        {
          error: 'Failed to create GitHub PR',
          message: prError instanceof Error ? prError.message : String(prError),
        },
        { status: 500 }
      );
    }
  } catch (error) {
    errorExceptInTest('[auto-fix-create-pr] Error processing request:', error);
    captureException(error, {
      tags: { source: 'auto-fix-create-pr-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to process request',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
