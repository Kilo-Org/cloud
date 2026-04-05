/**
 * Internal API Endpoint: Cloud Agent Callback (Auto Fix)
 *
 * Called by:
 * - Cloud Agent (when fix session completes or fails)
 *
 * Process:
 * 1. Receive callback with sessionId and status
 * 2. Find ticket by sessionId
 * 3. If failed/interrupted: Update ticket status and post comment
 * 4. If successful:
 *    - review_comment trigger: notify on original review thread
 *    - label trigger: create GitHub PR and update ticket
 * 5. Trigger dispatch for pending fixes
 *
 * URL: POST /api/internal/auto-fix/pr-callback
 * Protected by internal API secret
 *
 * Note: This callback is invoked by Cloud Agent when execution reaches a terminal state.
 * For label-triggered tickets, this endpoint creates the PR.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getFixTicketBySessionId, updateFixTicketStatus } from '@/lib/auto-fix/db/fix-tickets';
import { tryDispatchPendingFixes } from '@/lib/auto-fix/dispatch/dispatch-pending-fixes';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { postIssueComment } from '@/lib/auto-fix/github/post-comment';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import {
  handleCommentReply,
  sanitizePublicErrorMessage,
} from '@/lib/auto-fix/github/handle-comment-reply';
import { handleCreateIssuePR } from '@/lib/auto-fix/github/handle-create-issue-pr';
import { z } from 'zod';

const callbackStatusEnum = z.enum(['completed', 'failed', 'interrupted']);

const CallbackPayloadSchema = z
  .object({
    sessionId: z.string().optional(),
    cloudAgentSessionId: z.string().optional(),
    status: callbackStatusEnum,
    errorMessage: z.string().optional(),
    lastSeenBranch: z.string().optional(),
  })
  .refine(data => data.sessionId || data.cloudAgentSessionId, {
    message: 'Either sessionId or cloudAgentSessionId is required',
  });

function normalizePayload(raw: z.infer<typeof CallbackPayloadSchema>): {
  sessionId?: string;
  status: z.infer<typeof callbackStatusEnum>;
  errorMessage?: string;
  lastSeenBranch?: string;
} {
  return {
    sessionId: raw.sessionId ?? raw.cloudAgentSessionId,
    status: raw.status,
    errorMessage: raw.errorMessage,
    lastSeenBranch: raw.lastSeenBranch,
  };
}

export async function POST(req: NextRequest) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const raw: unknown = await req.json();
    const parsed = CallbackPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid payload', issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const { sessionId, status, errorMessage, lastSeenBranch } = normalizePayload(parsed.data);

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing required fields: sessionId' }, { status: 400 });
    }

    logExceptInTest('[auto-fix-pr-callback] Received callback', {
      sessionId,
      status,
      hasError: !!errorMessage,
    });

    // Find ticket by sessionId
    const ticket = await getFixTicketBySessionId(sessionId);

    if (!ticket) {
      logExceptInTest('[auto-fix-pr-callback] Ticket not found for session', { sessionId });
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const ticketId = ticket.id;

    // Use review_comment_id as the definitive signal for review-comment triggers.
    // This is more robust than trigger_source alone because review_comment_id is
    // set immutably at ticket creation and never modified by status updates.
    const isReviewCommentTrigger = ticket.review_comment_id != null;

    if (isReviewCommentTrigger && ticket.trigger_source !== 'review_comment') {
      errorExceptInTest(
        '[auto-fix-pr-callback] trigger_source mismatch: ticket has review_comment_id but trigger_source is not review_comment',
        {
          ticketId,
          sessionId,
          triggerSource: ticket.trigger_source,
          reviewCommentId: ticket.review_comment_id,
        }
      );
      captureMessage('auto-fix trigger_source mismatch', {
        level: 'warning',
        tags: { source: 'auto-fix-pr-callback' },
        extra: {
          ticketId,
          sessionId,
          triggerSource: ticket.trigger_source,
          reviewCommentId: ticket.review_comment_id,
        },
      });
    }

    const isTerminalState =
      ticket.status === 'completed' || ticket.status === 'failed' || ticket.status === 'cancelled';

    if (isTerminalState) {
      logExceptInTest(
        '[auto-fix-pr-callback] Ticket already in terminal state, skipping callback',
        {
          ticketId,
          sessionId,
          currentStatus: ticket.status,
          requestedStatus: status,
        }
      );
      return NextResponse.json({ success: true, message: 'Ticket already terminal' });
    }

    // Handle failure/interruption
    if (status === 'failed' || status === 'interrupted') {
      logExceptInTest('[auto-fix-pr-callback] Auto-fix execution failed', {
        ticketId,
        sessionId,
        status,
        errorMessage,
      });

      if (isReviewCommentTrigger) {
        const replyResult = await handleCommentReply({
          ticketId,
          sessionId,
          outcome: 'failed',
          errorMessage: errorMessage || `Auto-fix execution ${status}`,
        });

        if (!replyResult.ok) {
          await updateFixTicketStatus(ticketId, 'failed', {
            errorMessage: `Failed to post review-comment failure reply: ${replyResult.error}`,
            completedAt: new Date(),
          });
          throw new Error(`Failed to post review-comment failure reply: ${replyResult.error}`);
        }
      } else {
        // Update ticket to failed
        await updateFixTicketStatus(ticketId, 'failed', {
          errorMessage: errorMessage || `Auto-fix execution ${status}`,
          completedAt: new Date(),
        });
      }

      // Post issue-level failure comment only for issue-triggered tickets.
      // Review-comment-triggered tickets are notified on their original review thread.
      if (!isReviewCommentTrigger) {
        try {
          if (ticket.platform_integration_id) {
            const integration = await getIntegrationById(ticket.platform_integration_id);

            if (integration?.platform_installation_id) {
              const tokenData = await generateGitHubInstallationToken(
                integration.platform_installation_id
              );

              await postIssueComment({
                repoFullName: ticket.repo_full_name,
                issueNumber: ticket.issue_number,
                body: `🤖 **Auto-Fix Update**\n\nI attempted to create a pull request to fix this issue, but encountered an error:\n\n\`\`\`\n${sanitizePublicErrorMessage(errorMessage || 'Unknown error')}\n\`\`\`\n\nThis issue may require manual attention.`,
                githubToken: tokenData.token,
              });

              logExceptInTest('[auto-fix-pr-callback] Posted failure comment', { ticketId });
            }
          }
        } catch (commentError) {
          errorExceptInTest('[auto-fix-pr-callback] Failed to post failure comment:', commentError);
          captureException(commentError, {
            tags: { operation: 'auto-fix-pr-callback', step: 'post-failure-comment' },
            extra: { ticketId, sessionId },
          });
          // Continue - comment failure is not critical
        }
      }

      // Trigger dispatch for pending fixes
      try {
        await triggerDispatch(ticket);
      } catch (triggerError) {
        // Log but don't fail the request - dispatch is not critical
        errorExceptInTest(
          '[auto-fix-pr-callback] Error in triggerDispatch (failure path):',
          triggerError
        );
        captureException(triggerError, {
          tags: { operation: 'auto-fix-pr-callback', step: 'trigger-dispatch-failure' },
          extra: { ticketId, sessionId },
        });
      }

      return NextResponse.json({ success: true });
    }

    // Handle success
    logExceptInTest('[auto-fix-pr-callback] Cloud Agent session completed successfully', {
      ticketId,
      sessionId,
    });

    if (isReviewCommentTrigger) {
      const replyResult = await handleCommentReply({
        ticketId,
        sessionId,
        outcome: 'success',
        prBranch: lastSeenBranch,
      });

      if (!replyResult.ok) {
        await updateFixTicketStatus(ticketId, 'failed', {
          errorMessage: `Failed to post review-comment success reply: ${replyResult.error}`,
          completedAt: new Date(),
        });
        throw new Error(`Failed to post review-comment success reply: ${replyResult.error}`);
      }
    } else {
      const prResult = await handleCreateIssuePR({
        ticketId,
        sessionId,
        branchName: lastSeenBranch,
      });
      if (!prResult.ok) {
        throw new Error(prResult.error);
      }
    }

    // Trigger dispatch for pending fixes
    try {
      await triggerDispatch(ticket);
    } catch (triggerError) {
      // Log but don't fail the request - dispatch is not critical
      errorExceptInTest(
        '[auto-fix-pr-callback] Error in triggerDispatch (success path):',
        triggerError
      );
      captureException(triggerError, {
        tags: { operation: 'auto-fix-pr-callback', step: 'trigger-dispatch-success' },
        extra: { ticketId, sessionId },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    errorExceptInTest('[auto-fix-pr-callback] Error processing callback:', error);
    captureException(error, {
      tags: { source: 'auto-fix-pr-callback-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to process callback',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

/**
 * Trigger dispatch for pending fixes
 */
async function triggerDispatch(ticket: {
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
  id: string;
}): Promise<void> {
  try {
    let owner;
    if (ticket.owned_by_organization_id) {
      const botUserId = await getBotUserId(ticket.owned_by_organization_id, 'auto-fix');
      if (botUserId) {
        owner = {
          type: 'org' as const,
          id: ticket.owned_by_organization_id,
          userId: botUserId,
        };
      } else {
        errorExceptInTest('[auto-fix-pr-callback] Bot user not found for organization', {
          organizationId: ticket.owned_by_organization_id,
          ticketId: ticket.id,
        });
        captureMessage('Bot user missing for organization auto fix', {
          level: 'error',
          tags: { source: 'auto-fix-pr-callback' },
          extra: { organizationId: ticket.owned_by_organization_id, ticketId: ticket.id },
        });
      }
    } else {
      owner = {
        type: 'user' as const,
        id: ticket.owned_by_user_id || '',
        userId: ticket.owned_by_user_id || '',
      };
    }

    if (owner) {
      // Trigger dispatch in background (don't await - fire and forget)
      tryDispatchPendingFixes(owner).catch((dispatchError: Error) => {
        errorExceptInTest('[auto-fix-pr-callback] Error dispatching pending fixes:', dispatchError);
        captureException(dispatchError, {
          tags: { source: 'auto-fix-pr-callback-dispatch' },
          extra: { ticketId: ticket.id, owner },
        });
      });

      logExceptInTest('[auto-fix-pr-callback] Triggered dispatch for pending fixes', {
        ticketId: ticket.id,
        owner,
      });
    }
  } catch (dispatchError) {
    errorExceptInTest('[auto-fix-pr-callback] Error in triggerDispatch:', dispatchError);
    // Don't throw - dispatch failure shouldn't fail the callback
  }
}
