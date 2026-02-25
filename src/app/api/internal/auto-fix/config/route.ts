/**
 * Internal API Endpoint: Get Auto Fix Configuration
 *
 * Called by:
 * - Auto Fix Orchestrator (Cloudflare Worker) to get config for PR creation
 *
 * Process:
 * 1. Get ticket and agent config from database
 * 2. Generate GitHub token if available
 * 3. Return configuration for DO to use
 *
 * URL: POST /api/internal/auto-fix/config
 * Protected by internal API secret
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import type { Owner } from '@/lib/auto-fix/core/schemas';
import type { AutoFixAgentConfig } from '@/lib/auto-fix/core/schemas';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { getFixTicketById } from '@/lib/auto-fix/db/fix-tickets';

interface AutoFixConfigRequest {
  ticketId: string;
}

interface AutoFixConfigResponse {
  githubToken?: string;
  config: {
    model_slug: string;
    pr_base_branch: string;
    pr_title_template: string;
    pr_body_template?: string | null;
    custom_instructions?: string | null;
  };
}

export async function POST(req: NextRequest) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: AutoFixConfigRequest = await req.json();
    const { ticketId } = body;

    // Validate payload
    if (!ticketId) {
      return NextResponse.json({ error: 'Missing required field: ticketId' }, { status: 400 });
    }

    logExceptInTest('[auto-fix-config] Getting config for ticket', { ticketId });

    // Get ticket from database
    const ticket = await getFixTicketById(ticketId);

    if (!ticket) {
      logExceptInTest('[auto-fix-config] Ticket not found', { ticketId });
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    // Get GitHub token from integration (if available)
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
        // Continue without GitHub token - may fail later but let cloud agent try
      }
    }

    // Build owner object
    const owner: Owner = ticket.owned_by_organization_id
      ? {
          type: 'org',
          id: ticket.owned_by_organization_id,
          userId: ticket.owned_by_organization_id,
        }
      : {
          type: 'user',
          id: ticket.owned_by_user_id || '',
          userId: ticket.owned_by_user_id || '',
        };

    // Get agent config
    const agentConfig = await getAgentConfigForOwner(owner, 'auto_fix', 'github');

    if (!agentConfig) {
      return NextResponse.json({ error: 'Agent config not found' }, { status: 404 });
    }

    const config = agentConfig.config as AutoFixAgentConfig;

    // Return configuration for DO to use
    const response: AutoFixConfigResponse = {
      githubToken,
      config: {
        model_slug: config.model_slug,
        pr_base_branch: config.pr_base_branch || 'main',
        pr_title_template: config.pr_title_template || 'Fix #{issue_number}: {issue_title}',
        pr_body_template: config.pr_body_template,
        custom_instructions: config.custom_instructions,
      },
    };

    logExceptInTest('[auto-fix-config] Returning config', {
      ticketId,
      hasGithubToken: !!githubToken,
      modelSlug: config.model_slug,
    });

    return NextResponse.json(response);
  } catch (error) {
    errorExceptInTest('[auto-fix-config] Error getting config:', error);
    captureException(error, {
      tags: { source: 'auto-fix-config-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to get auto-fix config',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
