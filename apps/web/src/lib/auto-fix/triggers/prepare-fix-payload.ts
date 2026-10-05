import { prepareCloudAgentWorkflowUser } from '@/lib/auth/cloud-agent-workflow-user';
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { generateCloudAgentWorkflowToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { getFixTicketById } from '../db/fix-tickets';
import type { Owner } from '../core/schemas';
import type { DispatchFixRequest } from '../core/schemas';
import { AutoFixAgentConfigSchema, AUTO_FIX_CONSTANTS } from '../core/schemas';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';

export interface PreparePayloadParams {
  ticketId: string;
  owner: Owner;
  agentConfig: {
    config: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export async function prepareFixPayload(params: PreparePayloadParams): Promise<DispatchFixRequest> {
  const { ticketId, owner, agentConfig } = params;

  try {
    const ticket = await getFixTicketById(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    const [user] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, owner.userId))
      .limit(1);

    if (!user) {
      throw new Error(`User ${owner.userId} not found`);
    }

    const authToken = generateCloudAgentWorkflowToken(await prepareCloudAgentWorkflowUser(user), {
      organizationId: owner.type === 'org' ? owner.id : undefined,
      tokenSource: 'auto-fix',
      botId: 'auto-fix',
      expiresIn: TOKEN_EXPIRY.default,
    });

    const configResult = AutoFixAgentConfigSchema.safeParse(agentConfig.config);
    if (!configResult.success) {
      throw new Error(
        `Invalid agent config for ticket ${ticketId}: ${configResult.error.flatten().fieldErrors}`
      );
    }
    const config = configResult.data;

    const triggerSource = ticket.trigger_source || 'label';

    // 6. Prepare session input
    const sessionInput: DispatchFixRequest['sessionInput'] = {
      repoFullName: ticket.repo_full_name,
      issueNumber: ticket.issue_number,
      issueTitle: ticket.issue_title,
      issueBody: ticket.issue_body,
      classification: ticket.classification || undefined,
      confidence: ticket.confidence ? Number(ticket.confidence) : undefined,
      intentSummary: ticket.intent_summary || undefined,
      relatedFiles: ticket.related_files || undefined,
      customInstructions: config.custom_instructions || null,
      modelSlug: config.model_slug || 'anthropic/claude-sonnet-4.5',
      prBaseBranch: config.pr_base_branch || 'main',
      prTitleTemplate: config.pr_title_template || 'Fix #{issue_number}: {issue_title}',
      prBodyTemplate: config.pr_body_template || null,
      maxPRCreationTimeMinutes:
        config.max_pr_creation_time_minutes ||
        AUTO_FIX_CONSTANTS.DEFAULT_MAX_PR_CREATION_TIME_MINUTES,
    };

    if (triggerSource === 'review_comment') {
      sessionInput.upstreamBranch = ticket.pr_head_ref ?? undefined;
      sessionInput.reviewCommentId = ticket.review_comment_id ?? undefined;
      sessionInput.reviewCommentBody = ticket.review_comment_body ?? undefined;
      sessionInput.filePath = ticket.file_path ?? undefined;
      sessionInput.lineNumber = ticket.line_number ?? undefined;
      sessionInput.diffHunk = ticket.diff_hunk ?? undefined;
    }

    const payload: DispatchFixRequest = {
      ticketId,
      authToken,
      owner,
      triggerSource,
      sessionInput,
    };

    logExceptInTest('[prepareFixPayload] Prepared payload', {
      ticketId,
      owner,
      repoFullName: ticket.repo_full_name,
      issueNumber: ticket.issue_number,
    });

    return payload;
  } catch (error) {
    errorExceptInTest('[prepareFixPayload] Error preparing payload:', error);
    captureException(error, {
      tags: { operation: 'prepareFixPayload' },
      extra: { ticketId, owner },
    });
    throw error;
  }
}
