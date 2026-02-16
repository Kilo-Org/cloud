/**
 * Prepare Triage Payload
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
import { getTriageTicketById } from '../db/triage-tickets';
import type { Owner } from '../core';
import type { AutoTriageAgentConfig, DispatchTriageRequest } from '../core/schemas';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { AUTO_TRIAGE_CONSTANTS } from '../core/constants';

export interface PreparePayloadParams {
  ticketId: string;
  owner: Owner;
  agentConfig: {
    config: AutoTriageAgentConfig | Record<string, unknown>;
    [key: string]: unknown;
  };
}

/**
 * Prepare complete payload for auto triage
 * Does all the heavy lifting: DB queries, token generation
 */
export async function prepareTriagePayload(
  params: PreparePayloadParams
): Promise<DispatchTriageRequest> {
  const { ticketId, owner, agentConfig } = params;

  try {
    // 1. Get the ticket from DB
    const ticket = await getTriageTicketById(ticketId);
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
    const authToken = generateApiToken(user, { botId: 'auto-triage' });

    // 4. Get config values
    const config = agentConfig.config as AutoTriageAgentConfig;

    // 5. Prepare session input
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
      modelSlug: config.model_slug || CLAUDE_SONNET_CURRENT_MODEL_ID,
      maxClassificationTimeMinutes: config.max_classification_time_minutes || 5,
      maxPRCreationTimeMinutes: config.max_pr_creation_time_minutes || 15,
    };

    // 6. Build complete payload
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
