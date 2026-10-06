import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { createTriageTicket, findExistingTicket } from '@/lib/auto-triage/db/triage-tickets';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import type { Owner } from '@/lib/auto-triage/core';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import type { AutoTriageAgentConfig } from '@/lib/auto-triage/core/schemas';
import type { ConfigValidator } from './config-validator';

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

export class IssueWebhookProcessor {
  constructor(private readonly configValidator: ConfigValidator) {}

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

      if (this.shouldSkipEvent(payload)) {
        return this.skipResponse('Skipped bot event');
      }

      const owner = await this.resolveOwner(integration);
      if (!owner) {
        return NextResponse.json({ message: 'Integration missing user context' }, { status: 500 });
      }

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

      const validationResult = this.configValidator.validate(config, payload, owner.type, owner.id);
      if (!validationResult.isValid) {
        return this.skipResponse(validationResult.reason);
      }

      const existingTicket = await findExistingTicket(repository.full_name, issue.number);
      if (existingTicket) {
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

      const ticketId = await this.createTicket(payload, owner, integration);

      logExceptInTest(
        `Created triage ticket ${ticketId} for ${repository.full_name}#${issue.number}`
      );

      await this.tryDispatch(owner, ticketId, repository.full_name, issue.number);

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

  private async resolveOwner(integration: PlatformIntegration): Promise<Owner | null> {
    // For orgs: use bot user, fallback to integration creator
    const orgBotUserId = integration.owned_by_organization_id
      ? await getBotUserId(integration.owned_by_organization_id, 'auto-triage')
      : null;

    const owner: Owner = integration.owned_by_organization_id
      ? {
          type: 'org',
          id: integration.owned_by_organization_id,
          userId: (orgBotUserId ?? integration.kilo_requester_user_id) as string,
        }
      : {
          type: 'user',
          id: integration.owned_by_user_id as string,
          userId: integration.owned_by_user_id as string,
        };

    if (!owner.userId) {
      logExceptInTest('No valid user ID found for integration:', {
        integrationId: integration.id,
        ownedByOrgId: integration.owned_by_organization_id,
        ownedByUserId: integration.owned_by_user_id,
        kiloRequesterId: integration.kilo_requester_user_id,
        botUserId: orgBotUserId,
      });

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

  private async tryDispatch(
    owner: Owner,
    ticketId: string,
    repoFullName: string,
    issueNumber: number
  ): Promise<void> {
    try {
      const { tryDispatchPendingTickets } =
        await import('@/lib/auto-triage/dispatch/dispatch-pending-tickets');
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

  private skipResponse(message: string) {
    return NextResponse.json({ message }, { status: 200 });
  }

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
