/**
 * Shared handler for loading auto-fix configuration for a ticket.
 *
 * Extracted so the `pr-callback` route can call it directly without a
 * self-referencing HTTP fetch to `/api/internal/auto-fix/config`.
 */

import { getFixTicketById } from '@/lib/auto-fix/db/fix-tickets';
import type { AutoFixTicket } from '@kilocode/db/schema';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { AutoFixAgentConfigSchema } from '@/lib/auto-fix/core/schemas';
import type { Owner } from '@/lib/auto-fix/core/schemas';

type GetFixConfigResult =
  | {
      ok: true;
      ticket: AutoFixTicket;
      githubToken: string | undefined;
      config: {
        model_slug: string;
        pr_base_branch: string;
        pr_title_template: string;
        pr_body_template?: string | null;
        custom_instructions?: string | null;
      };
    }
  | { ok: false; error: string; status: number };

export async function getFixConfig(ticketId: string): Promise<GetFixConfigResult> {
  if (!ticketId) {
    return { ok: false, error: 'Missing required field: ticketId', status: 400 };
  }

  logExceptInTest('[auto-fix-config] Getting config for ticket', { ticketId });

  const ticket = await getFixTicketById(ticketId);

  if (!ticket) {
    logExceptInTest('[auto-fix-config] Ticket not found', { ticketId });
    return { ok: false, error: 'Ticket not found', status: 404 };
  }

  let githubToken: string | undefined;

  if (ticket.platform_integration_id) {
    try {
      const integration = await getIntegrationById(ticket.platform_integration_id);

      if (integration?.platform_installation_id) {
        const tokenData = await generateGitHubInstallationToken(
          integration.platform_installation_id
        );
        githubToken = tokenData.token;

        logExceptInTest('[auto-fix-config] GitHub token obtained', {
          ticketId,
          hasToken: !!githubToken,
        });
      }
    } catch (authError) {
      errorExceptInTest('[auto-fix-config] Failed to get GitHub token:', authError);
      captureException(authError, {
        tags: { operation: 'auto-fix-config', step: 'get-github-token' },
        extra: { ticketId, platformIntegrationId: ticket.platform_integration_id },
      });
    }
  }

  if (!ticket.owned_by_organization_id && !ticket.owned_by_user_id) {
    errorExceptInTest('[auto-fix-config] Ticket has no owner', { ticketId });
    return { ok: false, error: 'Ticket has no owner (neither user nor org)', status: 400 };
  }

  const ownerId = ticket.owned_by_organization_id ?? ticket.owned_by_user_id;
  // ownerId is guaranteed non-null by the guard above, but TS can't narrow across two fields.
  let owner: Owner;
  if (ticket.owned_by_organization_id) {
    const botUserId = await getBotUserId(ticket.owned_by_organization_id, 'auto-fix');
    if (!botUserId) {
      errorExceptInTest('[auto-fix-config] Bot user not found for organization', {
        ticketId,
        organizationId: ticket.owned_by_organization_id,
      });
      captureMessage('Bot user missing for organization auto fix config', {
        level: 'error',
        tags: { source: 'auto-fix-config' },
        extra: { organizationId: ticket.owned_by_organization_id, ticketId },
      });
      return { ok: false, error: 'Bot user not found for organization', status: 500 };
    }
    owner = {
      type: 'org',
      id: ticket.owned_by_organization_id,
      userId: botUserId,
    };
  } else {
    owner = {
      type: 'user',
      id: ownerId ?? '',
      userId: ownerId ?? '',
    };
  }

  const agentConfig = await getAgentConfigForOwner(owner, 'auto_fix', 'github');

  if (!agentConfig) {
    return { ok: false, error: 'Agent config not found', status: 404 };
  }

  const configResult = AutoFixAgentConfigSchema.safeParse(agentConfig.config);

  if (!configResult.success) {
    errorExceptInTest('[auto-fix-config] Invalid agent config shape', {
      ticketId,
      errors: configResult.error.flatten(),
    });
    return { ok: false, error: 'Invalid agent config', status: 500 };
  }

  const config = configResult.data;

  logExceptInTest('[auto-fix-config] Returning config', {
    ticketId,
    hasGithubToken: !!githubToken,
    modelSlug: config.model_slug,
  });

  return {
    ok: true,
    ticket,
    githubToken,
    config: {
      model_slug: config.model_slug,
      pr_base_branch: config.pr_base_branch || 'main',
      pr_title_template: config.pr_title_template || 'Fix #{issue_number}: {issue_title}',
      pr_body_template: config.pr_body_template,
      custom_instructions: config.custom_instructions,
    },
  };
}
