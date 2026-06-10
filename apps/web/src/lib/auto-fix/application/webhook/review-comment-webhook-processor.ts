/**
 * Review Comment Webhook Processor
 *
 * Processes GitHub PR review comment events to trigger scoped Auto Fix.
 * When a review comment contains "@kilo" and a fix keyword, this processor:
 * 1. Validates the mention and author permissions
 * 2. Checks Auto Fix configuration
 * 3. Creates a fix ticket scoped to the specific file/line
 * 4. Dispatches to Auto Fix worker
 */

import type { PlatformIntegration } from '@kilocode/db/schema';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import {
  createFixTicket,
  findExistingReviewCommentFixTicket,
  resetFixTicketForRetry,
} from '../../db/fix-tickets';
import { tryDispatchPendingFixes } from '../../dispatch/dispatch-pending-fixes';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import {
  addReactionToPRReviewComment,
  getCollaboratorPermissionLevel,
} from '@/lib/integrations/platforms/github/adapter';
import { AutoFixAgentConfigSchema } from '../../core/schemas';
import type { Owner } from '../../core/schemas';
import type {
  PullRequestReviewCommentPayload,
  GitHubAuthorAssociation,
} from '@/lib/integrations/platforms/github/webhook-schemas';

const KILO_MENTION_PATTERN = /@kilo\b/i;
const FIX_KEYWORD_PATTERN = /\b(fix|patch)\b/i;

/**
 * author_association values that imply write access.
 * GitHub's author_association field is unreliable — org members sometimes appear
 * as CONTRIBUTOR in webhook payloads. When the value is not in this set we fall
 * back to an API check.
 */
const WRITE_ACCESS_ASSOCIATIONS = new Set<GitHubAuthorAssociation>([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

const WRITE_PERMISSION_LEVELS = new Set(['admin', 'write']);

export class ReviewCommentWebhookProcessor {
  async process(
    payload: PullRequestReviewCommentPayload,
    integration: PlatformIntegration
  ): Promise<void> {
    const { comment, pull_request, repository, installation } = payload;
    const installationId = installation.id.toString();
    const [repoOwner, repoName] = repository.full_name.split('/');

    if (!repoOwner || !repoName) {
      errorExceptInTest(
        '[ReviewCommentWebhookProcessor] Malformed repository.full_name, cannot proceed',
        { fullName: repository.full_name }
      );
      return;
    }

    logExceptInTest('[ReviewCommentWebhookProcessor] Processing review comment', {
      repoFullName: repository.full_name,
      prNumber: pull_request.number,
      commentId: comment.id,
    });

    // 1. Check if comment body contains @kilo and a fix keyword
    if (!KILO_MENTION_PATTERN.test(comment.body) || !FIX_KEYWORD_PATTERN.test(comment.body)) {
      logExceptInTest('[ReviewCommentWebhookProcessor] No @kilo fix mention found', {
        commentId: comment.id,
      });
      return;
    }

    // 2. Check author permissions for write access
    //    author_association from the webhook payload is checked first, but it is
    //    unreliable (e.g. org members may appear as CONTRIBUTOR). When the fast
    //    check fails we fall back to the collaborator permission API.
    if (!WRITE_ACCESS_ASSOCIATIONS.has(comment.author_association)) {
      const permission = await getCollaboratorPermissionLevel(
        installationId,
        repoOwner,
        repoName,
        comment.user.login
      );

      if (!permission || !WRITE_PERMISSION_LEVELS.has(permission)) {
        logExceptInTest('[ReviewCommentWebhookProcessor] Author lacks write access', {
          commentId: comment.id,
          authorAssociation: comment.author_association,
          apiPermission: permission,
          author: comment.user.login,
        });
        // Add thumbs-down reaction to indicate permission denied
        try {
          await addReactionToPRReviewComment(installationId, repoOwner, repoName, comment.id, '-1');
        } catch {
          // Best-effort reaction
        }
        return;
      }

      logExceptInTest(
        '[ReviewCommentWebhookProcessor] author_association was insufficient but API confirms write access',
        {
          commentId: comment.id,
          authorAssociation: comment.author_association,
          apiPermission: permission,
          author: comment.user.login,
        }
      );
    }

    // 3. Build owner object
    // For org owners, userId is temporarily set to the org ID; it gets resolved
    // to the bot user ID before dispatch (see step 8 below).
    let owner: Owner;
    if (integration.owned_by_organization_id) {
      owner = {
        type: 'org',
        id: integration.owned_by_organization_id,
        userId: integration.owned_by_organization_id,
      };
    } else if (integration.owned_by_user_id) {
      owner = {
        type: 'user',
        id: integration.owned_by_user_id,
        userId: integration.owned_by_user_id,
      };
    } else {
      errorExceptInTest(
        '[ReviewCommentWebhookProcessor] Integration has no owner (neither user nor org)',
        { integrationId: integration.id }
      );
      return;
    }

    // 4. Get Auto Fix agent config
    const agentConfig = await getAgentConfigForOwner(owner, 'auto_fix', 'github');

    if (!agentConfig || !agentConfig.is_enabled) {
      logExceptInTest('[ReviewCommentWebhookProcessor] Auto Fix not enabled', {
        owner,
        hasConfig: !!agentConfig,
        isEnabled: agentConfig?.is_enabled,
      });
      return;
    }

    const configResult = AutoFixAgentConfigSchema.safeParse(agentConfig.config);
    if (!configResult.success) {
      logExceptInTest('[ReviewCommentWebhookProcessor] Invalid agent config', {
        owner,
        errors: configResult.error.issues,
      });
      return;
    }
    const config = configResult.data;

    // 5. Check if review comments are enabled
    if (!config.enabled_for_review_comments) {
      logExceptInTest('[ReviewCommentWebhookProcessor] Auto Fix not enabled for review comments', {
        owner,
      });
      return;
    }

    // 6. Check repository selection
    if (config.repository_selection_mode === 'selected') {
      if (!config.selected_repository_ids.includes(repository.id)) {
        logExceptInTest('[ReviewCommentWebhookProcessor] Repository not in selected list', {
          repoId: repository.id,
          selectedRepos: config.selected_repository_ids,
        });
        return;
      }
    }

    // 7. Check for existing fix ticket (dedup by comment ID)
    const existingTicket = await findExistingReviewCommentFixTicket(
      repository.full_name,
      comment.id
    );

    // 8. Resolve dispatch owner (org bot user or personal owner)
    let dispatchOwner: Owner;
    if (owner.type === 'org') {
      const botUserId = await getBotUserId(owner.id, 'auto-fix');
      if (!botUserId) {
        errorExceptInTest('[ReviewCommentWebhookProcessor] Bot user not found for organization', {
          organizationId: owner.id,
        });
        // Add confused reaction to indicate configuration problem
        try {
          await addReactionToPRReviewComment(
            installationId,
            repoOwner,
            repoName,
            comment.id,
            'confused'
          );
        } catch {
          // Best-effort reaction
        }
        return;
      }
      dispatchOwner = {
        type: 'org',
        id: owner.id,
        userId: botUserId,
      };
    } else {
      dispatchOwner = owner;
    }

    // 9. Handle existing ticket before creating a new one
    if (existingTicket) {
      if (existingTicket.status === 'pending' || existingTicket.status === 'running') {
        logExceptInTest(
          '[ReviewCommentWebhookProcessor] Fix ticket already in progress for comment',
          {
            ticketId: existingTicket.id,
            status: existingTicket.status,
            commentId: comment.id,
          }
        );
        try {
          await addReactionToPRReviewComment(installationId, repoOwner, repoName, comment.id, '+1');
        } catch {
          // Best-effort reaction
        }
        return;
      }

      logExceptInTest('[ReviewCommentWebhookProcessor] Resetting existing ticket for retry', {
        ticketId: existingTicket.id,
        previousStatus: existingTicket.status,
        commentId: comment.id,
      });

      try {
        await resetFixTicketForRetry(existingTicket.id);

        try {
          await addReactionToPRReviewComment(
            installationId,
            repoOwner,
            repoName,
            comment.id,
            'eyes'
          );
        } catch (reactionError) {
          errorExceptInTest(
            '[ReviewCommentWebhookProcessor] Failed to add eyes reaction for retry:',
            reactionError
          );
        }

        await tryDispatchPendingFixes(dispatchOwner);
      } catch (error) {
        errorExceptInTest('[ReviewCommentWebhookProcessor] Error retrying existing ticket:', error);
        captureException(error, {
          tags: { source: 'review-comment-webhook-processor', flow: 'retry-existing-ticket' },
          extra: {
            ticketId: existingTicket.id,
            repoFullName: repository.full_name,
            prNumber: pull_request.number,
            commentId: comment.id,
          },
        });

        try {
          await addReactionToPRReviewComment(
            installationId,
            repoOwner,
            repoName,
            comment.id,
            'confused'
          );
        } catch {
          // Best-effort reaction
        }
      }

      return;
    }

    // 10. Add eyes reaction to acknowledge the mention
    try {
      await addReactionToPRReviewComment(installationId, repoOwner, repoName, comment.id, 'eyes');
    } catch (reactionError) {
      errorExceptInTest(
        '[ReviewCommentWebhookProcessor] Failed to add eyes reaction:',
        reactionError
      );
      // Continue — reaction failure is not critical
    }

    // 11. Create fix ticket with review comment context
    // Populate issue fields with PR-level data to satisfy NOT NULL constraints
    try {
      const ticketId = await createFixTicket({
        owner,
        platformIntegrationId: integration.id,
        repoFullName: repository.full_name,
        issueNumber: pull_request.number,
        issueUrl: pull_request.html_url || comment.html_url,
        issueTitle: pull_request.title,
        issueBody: comment.body,
        issueAuthor: pull_request.user.login,
        issueLabels: [],
        triggerSource: 'review_comment',
        reviewCommentId: comment.id,
        reviewCommentBody: comment.body,
        filePath: comment.path,
        lineNumber: comment.line ?? undefined,
        diffHunk: comment.diff_hunk,
        prHeadRef: pull_request.head.ref,
      });

      logExceptInTest('[ReviewCommentWebhookProcessor] Created fix ticket', {
        ticketId,
        repoFullName: repository.full_name,
        prNumber: pull_request.number,
        commentId: comment.id,
      });

      // 12. Dispatch to Auto Fix worker
      await tryDispatchPendingFixes(dispatchOwner);
    } catch (error) {
      errorExceptInTest('[ReviewCommentWebhookProcessor] Error creating fix ticket:', error);
      captureException(error, {
        tags: { source: 'review-comment-webhook-processor' },
        extra: {
          repoFullName: repository.full_name,
          prNumber: pull_request.number,
          commentId: comment.id,
        },
      });

      // Add confused reaction to indicate failure
      try {
        await addReactionToPRReviewComment(
          installationId,
          repoOwner,
          repoName,
          comment.id,
          'confused'
        );
      } catch {
        // Best-effort reaction
      }
    }
  }
}
