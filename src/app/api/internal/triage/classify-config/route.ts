/**
 * Internal API Endpoint: Get Classification Configuration
 *
 * Called by:
 * - Triage Orchestrator (Cloudflare Worker) to get config for issue classification
 *
 * Process:
 * 1. Get ticket and agent config from database
 * 2. Generate GitHub token if available
 * 3. Return configuration for DO to use
 *
 * URL: POST /api/internal/triage/classify-config
 * Protected by internal API secret
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getTriageTicketById } from '@/lib/auto-triage/db/triage-tickets';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import type { Owner } from '@/lib/auto-triage/db/types';
import type { AutoTriageAgentConfig } from '@/lib/auto-triage/core/schemas';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';

interface ClassifyConfigRequest {
  ticketId: string;
}

interface ClassifyConfigResponse {
  githubToken?: string;
  config: {
    model_slug: string;
    custom_instructions?: string | null;
  };
  excluded_labels: string[];
}

export async function POST(req: NextRequest) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: ClassifyConfigRequest = await req.json();
    const { ticketId } = body;

    // Validate payload
    if (!ticketId) {
      return NextResponse.json({ error: 'Missing required field: ticketId' }, { status: 400 });
    }

    logExceptInTest('[classify-config] Getting classification config for ticket', { ticketId });

    // Get ticket from database
    const ticket = await getTriageTicketById(ticketId);

    if (!ticket) {
      logExceptInTest('[classify-config] Ticket not found', { ticketId });
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

          logExceptInTest('[classify-config] GitHub token obtained', {
            ticketId,
            hasToken: !!githubToken,
          });
        }
      } catch (authError) {
        errorExceptInTest('[classify-config] Failed to get GitHub token:', authError);
        captureException(authError, {
          tags: { operation: 'classify-config', step: 'get-github-token' },
          extra: { ticketId, platformIntegrationId: ticket.platform_integration_id },
        });
        // Continue without GitHub token - may work with public repos
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
    const agentConfig = await getAgentConfigForOwner(owner, 'auto_triage', 'github');

    if (!agentConfig) {
      return NextResponse.json({ error: 'Agent config not found' }, { status: 404 });
    }

    const config = agentConfig.config as AutoTriageAgentConfig;

    // Labels used for gating (skip/required) should not be offered to the AI for auto-labeling
    const excluded_labels = [...(config.skip_labels ?? []), ...(config.required_labels ?? [])];

    // Return configuration for DO to use
    const response: ClassifyConfigResponse = {
      githubToken,
      config: {
        model_slug: config.model_slug,
        custom_instructions: config.custom_instructions,
      },
      excluded_labels,
    };

    logExceptInTest('[classify-config] Returning classification config', {
      ticketId,
      hasGithubToken: !!githubToken,
      modelSlug: config.model_slug,
    });

    return NextResponse.json(response);
  } catch (error) {
    errorExceptInTest('[classify-config] Error getting classification config:', error);
    captureException(error, {
      tags: { source: 'classify-config-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to get classification config',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
