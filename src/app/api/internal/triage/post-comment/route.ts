/**
 * Internal API Endpoint: Post Comment on Issue
 *
 * Called by:
 * - Triage Orchestrator (to post duplicate detection comments on GitHub issues)
 *
 * Process:
 * 1. Get ticket and integration
 * 2. Post comment on GitHub issue
 *
 * URL: POST /api/internal/triage/post-comment
 * Protected by internal API secret
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getTriageTicketById } from '@/lib/auto-triage/db/triage-tickets';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { postIssueComment } from '@/lib/auto-triage/github/post-comment';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { z } from 'zod';

const postCommentRequestSchema = z.object({
  ticketId: z.string().min(1),
  body: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = postCommentRequestSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Missing required fields: ticketId, body (non-empty strings)' },
        { status: 400 }
      );
    }

    const { ticketId, body } = parsed.data;

    logExceptInTest('[post-comment] Posting comment on issue', { ticketId });

    // Get ticket from database
    const ticket = await getTriageTicketById(ticketId);

    if (!ticket) {
      logExceptInTest('[post-comment] Ticket not found', { ticketId });
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    // Get GitHub token from integration
    if (!ticket.platform_integration_id) {
      return NextResponse.json({ error: 'No platform integration found' }, { status: 400 });
    }

    const integration = await getIntegrationById(ticket.platform_integration_id);

    if (!integration?.platform_installation_id) {
      return NextResponse.json({ error: 'No platform installation found' }, { status: 400 });
    }

    const tokenData = await generateGitHubInstallationToken(integration.platform_installation_id);

    logExceptInTest('[post-comment] Posting comment on GitHub issue', {
      ticketId,
      repoFullName: ticket.repo_full_name,
      issueNumber: ticket.issue_number,
    });

    await postIssueComment({
      repoFullName: ticket.repo_full_name,
      issueNumber: ticket.issue_number,
      body,
      githubToken: tokenData.token,
    });

    logExceptInTest('[post-comment] Comment posted on GitHub issue', {
      ticketId,
      issueNumber: ticket.issue_number,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    errorExceptInTest('[post-comment] Error posting comment:', error);
    captureException(error, {
      tags: { source: 'post-comment-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to post comment',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
