/**
 * Shared handler for creating a GitHub PR from an issue-triggered fix ticket.
 *
 * Extracted so the `pr-callback` route can call it directly without
 * self-referencing HTTP fetches to `/api/internal/auto-fix/config`
 * and `/api/internal/auto-fix/create-pr`.
 */

import { updateFixTicketStatus } from '@/lib/auto-fix/db/fix-tickets';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { createPullRequest } from '@/lib/auto-fix/github/create-pull-request';
import { postIssueComment } from '@/lib/auto-fix/github/post-comment';
import { getFixConfig } from '@/lib/auto-fix/github/get-fix-config';
import { sanitizePublicErrorMessage } from '@/lib/auto-fix/github/handle-comment-reply';

type HandleCreateIssuePRParams = {
  ticketId: string;
  sessionId: string;
  branchName?: string;
};

type HandleCreateIssuePRResult =
  | { ok: true; prNumber: number; prUrl: string }
  | { ok: false; error: string };

export async function handleCreateIssuePR(
  params: HandleCreateIssuePRParams
): Promise<HandleCreateIssuePRResult> {
  const { ticketId, sessionId, branchName: providedBranchName } = params;

  // 1. Load config (token + PR settings)
  const configResult = await getFixConfig(ticketId);

  if (!configResult.ok) {
    const message = `Failed to load auto-fix config for PR creation: ${configResult.error}`;
    await markIssueTicketFailed(ticketId, message);
    return { ok: false, error: message };
  }

  const { ticket, githubToken, config } = configResult;

  if (!githubToken) {
    const message = 'Cannot create PR: missing GitHub installation token from auto-fix config';
    await markIssueTicketFailed(ticketId, message);
    return { ok: false, error: message };
  }

  const branchName = providedBranchName || `session/${sessionId}`;

  try {
    logExceptInTest('[auto-fix-create-issue-pr] Creating GitHub PR', {
      ticketId,
      sessionId,
      branchName,
      wasProvided: !!providedBranchName,
    });

    const prTitle = config.pr_title_template
      .replace('{issue_number}', ticket.issue_number.toString())
      .replace('{issue_title}', ticket.issue_title)
      .slice(0, 256);

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

    logExceptInTest('[auto-fix-create-issue-pr] GitHub PR created', {
      ticketId,
      prNumber: pr.number,
      prUrl: pr.url,
    });

    await updateFixTicketStatus(ticketId, 'completed', {
      prNumber: pr.number,
      prUrl: pr.url,
      prBranch: branchName,
      completedAt: new Date(),
    });

    // Post comment on issue linking to PR (best-effort)
    try {
      await postIssueComment({
        repoFullName: ticket.repo_full_name,
        issueNumber: ticket.issue_number,
        body: `🤖 **Auto-Fix Update**\n\nI've created a pull request to fix this issue: ${pr.url}\n\nPlease review the changes and provide feedback. If the fix looks good, feel free to merge it!`,
        githubToken,
      });
      logExceptInTest('[auto-fix-create-issue-pr] Posted success comment', { ticketId });
    } catch (commentError) {
      errorExceptInTest('[auto-fix-create-issue-pr] Failed to post success comment:', commentError);
      captureException(commentError, {
        tags: { operation: 'auto-fix-create-issue-pr', step: 'post-success-comment' },
        extra: { ticketId, sessionId, prNumber: pr.number },
      });
    }

    return { ok: true, prNumber: pr.number, prUrl: pr.url };
  } catch (prError) {
    errorExceptInTest('[auto-fix-create-issue-pr] Failed to create GitHub PR:', prError);
    captureException(prError, {
      tags: { operation: 'auto-fix-create-issue-pr', step: 'create-github-pr' },
      extra: { ticketId, sessionId },
    });

    await updateFixTicketStatus(ticketId, 'failed', {
      errorMessage: `Failed to create GitHub PR: ${prError instanceof Error ? prError.message : String(prError)}`,
      completedAt: new Date(),
    });

    // Post comment on issue explaining failure (best-effort)
    try {
      await postIssueComment({
        repoFullName: ticket.repo_full_name,
        issueNumber: ticket.issue_number,
        body: `🤖 **Auto-Fix Update**\n\nI successfully implemented changes to fix this issue, but encountered an error while creating the pull request:\n\n\`\`\`\n${sanitizePublicErrorMessage(prError instanceof Error ? prError.message : String(prError))}\n\`\`\`\n\nThe changes are available on branch \`${branchName}\`.`,
        githubToken,
      });
    } catch (commentError) {
      errorExceptInTest(
        '[auto-fix-create-issue-pr] Failed to post PR error comment:',
        commentError
      );
    }

    return {
      ok: false,
      error: prError instanceof Error ? prError.message : String(prError),
    };
  }
}

async function markIssueTicketFailed(ticketId: string, errorMessage: string): Promise<void> {
  await updateFixTicketStatus(ticketId, 'failed', {
    errorMessage,
    completedAt: new Date(),
  });
}
