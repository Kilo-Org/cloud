import { prepareCloudAgentWorkflowUser } from '@/lib/auth/cloud-agent-workflow-user';
import { captureException } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { generateCloudAgentWorkflowToken, TOKEN_EXPIRY } from '@kilocode/web-shared/lib/tokens';
import { getTriageTicketById } from '../db/triage-tickets';
import type { Owner } from '../core';
import type { AutoTriageAgentConfig, DispatchTriageRequest } from '../core/schemas';
import { logExceptInTest, errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { AUTO_TRIAGE_CONSTANTS } from '../core/constants';

export interface PreparePayloadParams {
  ticketId: string;
  owner: Owner;
  agentConfig: {
    config: AutoTriageAgentConfig | Record<string, unknown>;
    [key: string]: unknown;
  };
}

export async function prepareTriagePayload(
  params: PreparePayloadParams
): Promise<DispatchTriageRequest> {
  const { ticketId, owner, agentConfig } = params;

  try {
    const ticket = await getTriageTicketById(ticketId);
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
      tokenSource: 'auto-triage',
      botId: 'auto-triage',
      expiresIn: TOKEN_EXPIRY.default,
    });

    const config = agentConfig.config as AutoTriageAgentConfig;

    const sessionInput = {
      repoFullName: ticket.repo_full_name,
      issueNumber: ticket.issue_number,
      issueTitle: ticket.issue_title,
      issueBody: ticket.issue_body,
      duplicateThreshold:
        config.duplicate_threshold || AUTO_TRIAGE_CONSTANTS.DEFAULT_DUPLICATE_THRESHOLD,
      autoFixThreshold:
        config.auto_fix_threshold || AUTO_TRIAGE_CONSTANTS.DEFAULT_AUTO_PR_THRESHOLD,
      autoCreatePrThreshold:
        config.auto_create_pr_threshold || AUTO_TRIAGE_CONSTANTS.DEFAULT_AUTO_PR_THRESHOLD,
      customInstructions: config.custom_instructions || null,
      modelSlug: config.model_slug || 'anthropic/claude-sonnet-4.5',
      maxClassificationTimeMinutes: config.max_classification_time_minutes || 5,
      maxPRCreationTimeMinutes: config.max_pr_creation_time_minutes || 15,
    };

    const payload: DispatchTriageRequest = {
      ticketId,
      authToken,
      owner,
      sessionInput,
    };

    logExceptInTest('[prepareTriagePayload] Prepared payload', {
      ticketId,
      owner,
      repoFullName: ticket.repo_full_name,
      issueNumber: ticket.issue_number,
    });

    return payload;
  } catch (error) {
    errorExceptInTest('[prepareTriagePayload] Error preparing payload:', error);
    captureException(error, {
      tags: { operation: 'prepareTriagePayload' },
      extra: { ticketId, owner },
    });
    throw error;
  }
}
