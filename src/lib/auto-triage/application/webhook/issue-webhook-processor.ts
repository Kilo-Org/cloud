import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { PlatformIntegration } from '@/db/schema';
import { logExceptInTest } from '@/lib/utils.server';
import {
  createTriageTicket,
  findExistingTicket,
  resetTriageTicketForRetry,
} from '@/lib/auto-triage/db/triage-tickets';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import type { Owner } from '@/lib/auto-triage/core';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import type { AutoTriageAgentConfig } from '@/lib/auto-triage/core/schemas';
import type { ConfigValidator } from './config-validator';

/**
 * Issue payload type
 */
export type IssuePayload = {
  action: 'opened' | 'reopened' | 'edited';
  issue: {
    number: number;
    html_url: string;
    title: string;
    body: string | null;
    user: {
      login: string;
      type?: string;
    };
    labels?: Array<string | { name: string }>;
  };
  repository: {
    id: number;
    full_name: string;
    private: boolean;
  };
  sender: {
    login: string;
    type?: string;
  };
};

/**
 * IssueWebhookProcessor
 *
 * Processes GitHub issue webhook events for auto triage.
 * Orchestrates the workflow: validation, ticket creation, and dispatch.
 */
export class IssueWebhookProcessor {
  constructor(private readonly configValidator: ConfigValidator) {}

  /**
   * Process an issue webhook event
   */
  async process(payload: IssuePayload, integration: PlatformIntegration) {
    const { issue, repository } = payload;

    try {
      logExceptInTest('Issue event received:', {
        action: payload.action,
        issue_number: issue.number,
        repo: repository.full_name,
        title: issue.title,
        author: issue.user?.login,
      });

      // 1. Skip bot events
      if (this.shouldSkipEvent(payload)) {
        return this.skipResponse('Skipped bot event');
      }

      // 2. Resolve owner from integration
      const owner = await this.resolveOwner(integration);
      if (!owner) {
        return NextResponse.json({ message: 'Integration missing user context' }, { status: 500 });
      }

      // 3. Get and validate agent configuration
      const agentConfig = await getAgentConfigForOwner(owner, 'auto_triage', 'github');

      if (!agentConfig || !agentConfig.is_enabled) {
        logExceptInTest(
          `Auto triage agent not enabled for ${owner.type} ${owner.id} (repo: ${repository.full_name})`
        );
        return this.skipResponse('Auto triage agent not enabled for this repository');
      }

      const config = agentConfig.config as AutoTriageAgentConfig;

      logExceptInTest(
        `Auto triage agent enabled for ${owner.type} ${owner.id}, processing ${repository.full_name}#${issue.number}`
      );

      // 4. Validate configuration requirements
      const validationResult = this.configValidator.validate(config, payload, owner.type, owner.id);
      if (!validationResult.isValid) {
        // Type narrowing: when isValid is false, reason property exists
        return this.skipResponse(validationResult.reason);
      }

      // 5. Check for duplicate ticket
      const existingTicket = await findExistingTicket(repository.full_name, issue.number);
      if (existingTicket) {
        const terminalStates: ReadonlyArray<string> = ['actioned', 'failed', 'skipped'];
        const isTerminal = terminalStates.includes(existingTicket.status);

        if (payload.action === 'reopened' && isTerminal) {
          logExceptInTest(
            `Reopened issue with terminal ticket (${existingTicket.status}), re-triaging ${repository.full_name}#${issue.number}`
          );
          await resetTriageTicketForRetry(existingTicket.id);
          await this.tryDispatch(owner, existingTicket.id, repository.full_name, issue.number);
          return this.acceptedResponse(existingTicket.id);
        }

        logExceptInTest(
          `Duplicate triage ticket detected for ${repository.full_name}#${issue.number}`
        );
        return NextResponse.json(
          {
            message: 'Ticket already exists for this issue',
            ticketId: existingTicket.id,
          },
          { status: 200 }
        );
      }

      // 6. Create triage ticket
      const ticketId = await this.createTicket(payload, owner, integration);

      logExceptInTest(
        `Created triage ticket ${ticketId} for ${repository.full_name}#${issue.number}`
      );

      // 7. Trigger dispatch system
      await this.tryDispatch(owner, ticketId, repository.full_name, issue.number);

      // 8. Return accepted response
      return this.acceptedResponse(ticketId);
    } catch (error) {
      logExceptInTest('Error processing auto triage:', error);
      captureException(error, {
        tags: { source: 'issue_webhook' },
        extra: {
          repository: repository.full_name,
          issueNumber: issue.number,
        },
      });

      return NextResponse.json(
        {
          error: 'Failed to trigger auto triage',
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 500 }
      );
    }
  }

  /**
   * Check if event should be skipped (bot events)
   */
  private shouldSkipEvent(payload: IssuePayload): boolean {
    if (payload.sender.type === 'Bot') {
      logExceptInTest('Skipping bot event:', {
        issue_number: payload.issue.number,
        repo: payload.repository.full_name,
        sender: payload.sender.login,
      });
      return true;
    }
    return false;
  }

  /**
   * Resolve owner from platform integration
   */
  private async resolveOwner(integration: PlatformIntegration): Promise<Owner | null> {
    // For orgs: use bot user, fallback to integration creator
    const orgBotUserId = integration.owned_by_organization_id
      ? await getBotUserId(integration.owned_by_organization_id, 'auto-triage')
      : null;

    const owner: Owner = integration.owned_by_organization_id
      ? {
          type: 'org',
          id: integration.owned_by_organization_id,
          // Use bot user if available, fallback to integration creator
          userId: (orgBotUserId ?? integration.kilo_requester_user_id) as string,
        }
      : {
          type: 'user',
          id: integration.owned_by_user_id as string,
          userId: integration.owned_by_user_id as string,
        };

    // Validate we have a valid user ID
    if (!owner.userId) {
      logExceptInTest('No valid user ID found for integration:', {
        integrationId: integration.id,
        ownedByOrgId: integration.owned_by_organization_id,
        ownedByUserId: integration.owned_by_user_id,
        kiloRequesterId: integration.kilo_requester_user_id,
        botUserId: orgBotUserId,
      });

      // For organizations, provide a more actionable error message
      if (integration.owned_by_organization_id) {
        logExceptInTest(
          'Bot user not configured for organization. Please disable and re-enable auto-triage to create the bot user.',
          { organizationId: integration.owned_by_organization_id }
        );
      }

      return null;
    }

    return owner;
  }

  /**
   * Create triage ticket record
   */
  private async createTicket(
    payload: IssuePayload,
    owner: Owner,
    integration: PlatformIntegration
  ): Promise<string> {
    const { issue, repository } = payload;
    const issueLabels = issue.labels?.map(l => (typeof l === 'string' ? l : l.name)) || [];

    return createTriageTicket({
      owner,
      platformIntegrationId: integration.id,
      repoFullName: repository.full_name,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      issueTitle: issue.title,
      issueBody: issue.body,
      issueAuthor: issue.user.login,
      issueType: 'issue',
      issueLabels,
    });
  }

  /**
   * Try to dispatch pending tickets for the owner
   */
  private async tryDispatch(
    owner: Owner,
    ticketId: string,
    repoFullName: string,
    issueNumber: number
  ): Promise<void> {
    try {
      const { tryDispatchPendingTickets } = await import(
        '@/lib/auto-triage/dispatch/dispatch-pending-tickets'
      );
      await tryDispatchPendingTickets(owner);
      logExceptInTest(`Dispatched pending tickets for owner ${owner.type}:${owner.id}`);
    } catch (dispatchError) {
      logExceptInTest('Error during dispatch:', dispatchError);
      captureException(dispatchError, {
        tags: { source: 'issue_webhook_dispatch' },
        extra: {
          ticketId,
          repository: repoFullName,
          issueNumber,
          owner,
        },
      });
      // Don't throw - ticket record created as pending, will be picked up later
    }
  }

  /**
   * Return skip response
   */
  private skipResponse(message: string) {
    return NextResponse.json({ message }, { status: 200 });
  }

  /**
   * Return accepted response (ticket queued)
   */
  private acceptedResponse(ticketId: string) {
    return NextResponse.json(
      {
        message: 'Triage ticket queued',
        ticketId,
      },
      { status: 202 }
    );
  }
}
