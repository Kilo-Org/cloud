import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { verifyGitLabWebhookToken } from '@/lib/integrations/platforms/gitlab/adapter';
import { MergeRequestPayloadSchema } from '@/lib/integrations/platforms/gitlab/webhook-schemas';
import { findGitLabIntegrationByWebhookToken } from '@/lib/integrations/db/platform-integrations';
import { handleMergeRequest } from '@/lib/integrations/platforms/gitlab/webhook-handlers';
import { PLATFORM, GITLAB_EVENT, GITLAB_ACTION } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';
import { logWebhookEvent, updateWebhookEvent } from '@/lib/integrations/db/webhook-events';
import type { Owner } from '@/lib/integrations/core/types';

/**
 * GitLab Webhook Handler
 * Thin routing layer that:
 * 1. Verifies webhook token (X-Gitlab-Token header)
 * 2. Parses the event
 * 3. Routes to appropriate handler
 * 4. Handles errors
 *
 * GitLab webhooks use a simple secret token for verification (not HMAC like GitHub).
 * The token is configured per-project in GitLab and stored in our integration metadata.
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Get the webhook token from header
    const webhookToken = request.headers.get('x-gitlab-token');

    if (!webhookToken) {
      logExceptInTest('Missing X-Gitlab-Token header');
      return new NextResponse('Unauthorized - Missing token', { status: 401 });
    }

    // 2. Find integration by webhook token
    const integration = await findGitLabIntegrationByWebhookToken(webhookToken);

    if (!integration) {
      logExceptInTest('No integration found for webhook token');
      return new NextResponse('Unauthorized - Invalid token', { status: 401 });
    }

    // Get the expected token from integration metadata
    const metadata = integration.metadata as { webhook_secret?: string } | null;
    const expectedToken = metadata?.webhook_secret;

    // Verify the token matches (double-check)
    if (!verifyGitLabWebhookToken(webhookToken, expectedToken)) {
      logExceptInTest('Webhook token verification failed');
      return new NextResponse('Unauthorized', { status: 401 });
    }

    // 3. Check if integration is suspended
    if (integration.suspended_at) {
      logExceptInTest('Integration suspended, skipping event');
      return NextResponse.json({ message: 'Integration suspended' }, { status: 200 });
    }

    // 4. Parse JSON payload
    let payload: unknown;
    try {
      payload = await request.json();
    } catch (error) {
      logExceptInTest('Error parsing GitLab webhook JSON body:', error);
      captureException(error, {
        tags: { source: 'gitlab_webhook_parse_json' },
      });
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    // 5. Get event type from header
    const eventType = request.headers.get('x-gitlab-event') || '';
    const eventSignature = request.headers.get('x-gitlab-event-uuid') || `gitlab-${Date.now()}`;
    const headers = Object.fromEntries(request.headers);

    if (!eventType) {
      return NextResponse.json({ error: 'Missing X-Gitlab-Event header' }, { status: 400 });
    }

    logExceptInTest('GitLab webhook received:', {
      eventType,
      integrationId: integration.id,
    });

    // 6. Helper function to log webhook events
    const logWebhook = async (action: string) => {
      try {
        // Determine owner from integration
        const owner = integration.owned_by_organization_id
          ? { type: 'org' as const, id: integration.owned_by_organization_id }
          : ({ type: 'user' as const, id: integration.owned_by_user_id } as Owner);

        const { id, isDuplicate } = await logWebhookEvent({
          owner,
          platform: PLATFORM.GITLAB,
          event_type: eventType,
          event_action: action,
          payload,
          headers,
          event_signature: eventSignature,
        });

        if (isDuplicate) {
          logExceptInTest('Duplicate webhook event detected');
          return { isDuplicate: true, webhookEventId: id };
        }
        return { isDuplicate: false, webhookEventId: id };
      } catch (error) {
        logExceptInTest('Error logging webhook event:', error);
        captureException(error, {
          tags: { source: 'gitlab_webhook_event_logging' },
          extra: { event_type: eventType, event_action: action },
        });
        return { isDuplicate: false, webhookEventId: undefined };
      }
    };

    // 7. Route based on event type

    // Handle Merge Request events
    if (eventType === GITLAB_EVENT.MERGE_REQUEST) {
      const parseResult = MergeRequestPayloadSchema.safeParse(payload);
      if (!parseResult.success) {
        logExceptInTest('Invalid merge_request payload:', parseResult.error);
        captureMessage('Invalid GitLab webhook payload structure', {
          level: 'error',
          tags: { source: 'gitlab_webhook_validation', event: 'merge_request' },
          extra: { errors: parseResult.error.issues },
        });
        return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
      }

      const action = parseResult.data.object_attributes.action || 'unknown';

      // Filter out closed/merged events - we don't log or process them
      if (action === GITLAB_ACTION.CLOSE || action === GITLAB_ACTION.MERGE) {
        return NextResponse.json({ message: 'Event received' }, { status: 200 });
      }

      // Log webhook event
      const logResult = await logWebhook(action);
      if (logResult.isDuplicate) {
        return NextResponse.json({ message: 'Duplicate event' }, { status: 200 });
      }

      const result = await handleMergeRequest(parseResult.data, integration);

      // Mark webhook event as processed
      if (logResult.webhookEventId) {
        try {
          await updateWebhookEvent(logResult.webhookEventId, {
            processed: true,
            processed_at: new Date().toISOString(),
            handlers_triggered: ['code_review'],
            errors: null,
          });
        } catch (error) {
          logExceptInTest('Error updating webhook event:', error);
        }
      }

      return result;
    }

    // Handle Push events (for future use - e.g., branch protection, CI triggers)
    if (eventType === GITLAB_EVENT.PUSH) {
      logExceptInTest('Push event received, not yet implemented');
      return NextResponse.json({ message: 'Event received' }, { status: 200 });
    }

    // Handle Note (comment) events (for future use - e.g., responding to review comments)
    if (eventType === GITLAB_EVENT.NOTE) {
      logExceptInTest('Note event received, not yet implemented');
      return NextResponse.json({ message: 'Event received' }, { status: 200 });
    }

    // Handle Pipeline events (for future use - e.g., CI status updates)
    if (eventType === GITLAB_EVENT.PIPELINE) {
      logExceptInTest('Pipeline event received, not yet implemented');
      return NextResponse.json({ message: 'Event received' }, { status: 200 });
    }

    // Default: acknowledge receipt
    logExceptInTest('Unhandled GitLab event type:', eventType);
    return NextResponse.json({ message: 'Event received' }, { status: 200 });
  } catch (error) {
    logExceptInTest('GitLab webhook error:', error);
    captureException(error, {
      tags: { source: 'gitlab_webhook_handler' },
    });
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
