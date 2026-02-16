/**
 * Prepare Fix Payload
 *
 * Extracts all preparation logic (DB lookups, token generation)
 * Returns complete payload ready for cloud agent
 */

import { captureException } from '@sentry/nextjs';
import { CLAUDE_SONNET_CURRENT_MODEL_ID } from '@/lib/model-constants';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { generateApiToken } from '@/lib/tokens';
import { getFixTicketById } from '../db/fix-tickets';
import type { Owner } from '../core/schemas';
import type { AutoFixAgentConfig, DispatchFixRequest } from '../core/schemas';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { AUTO_FIX_CONSTANTS } from '../core/schemas';

export interface PreparePayloadParams {
  ticketId: string;
  owner: Owner;
  agentConfig: {
    config: AutoFixAgentConfig | Record<string, unknown>;
    [key: string]: unknown;
  };
}

/**
 * Prepare complete payload for auto fix
 * Does all the heavy lifting: DB queries, token generation
 */
export async function prepareFixPayload(params: PreparePayloadParams): Promise<DispatchFixRequest> {
  const { ticketId, owner, agentConfig } = params;

  try {
    // 1. Get the ticket from DB
    const ticket = await getFixTicketById(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found`);
    }

    // 2. Get the user by userId
    const [user] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, owner.userId))
      .limit(1);

    if (!user) {
      throw new Error(`User ${owner.userId} not found`);
    }

    // 3. Generate auth token for cloud agent with bot identifier
    const authToken = generateApiToken(user, { botId: 'auto-fix' });

    // 4. Get config values
    const config = agentConfig.config as AutoFixAgentConfig;

    // 5. Prepare session input
    const sessionInput = {
      repoFullName: ticket.repo_full_name,
      issueNumber: ticket.issue_number,
      issueTitle: ticket.issue_title,
      issueBody: ticket.issue_body,
      classification: ticket.classification || undefined,
      confidence: ticket.confidence ? Number(ticket.confidence) : undefined,
      intentSummary: ticket.intent_summary || undefined,
      relatedFiles: ticket.related_files || undefined,
      customInstructions: config.custom_instructions || null,
      modelSlug: config.model_slug || CLAUDE_SONNET_CURRENT_MODEL_ID,
      prBaseBranch: config.pr_base_branch || 'main',
      prTitleTemplate: config.pr_title_template || 'Fix #{issue_number}: {issue_title}',
      prBodyTemplate: config.pr_body_template || null,
      maxPRCreationTimeMinutes:
        config.max_pr_creation_time_minutes ||
        AUTO_FIX_CONSTANTS.DEFAULT_MAX_PR_CREATION_TIME_MINUTES,
    };

    // 6. Build complete payload
    const payload: DispatchFixRequest = {
      ticketId,
      authToken,
      owner,
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
