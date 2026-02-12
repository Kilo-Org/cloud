import type { NextRequest } from 'next/server';
import { after, NextResponse } from 'next/server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { verifyGitHubWebhookSignature } from '@/lib/integrations/platforms/github/adapter';
import {
  InstallationCreatedPayloadSchema,
  InstallationDeletedPayloadSchema,
  InstallationSuspendPayloadSchema,
  InstallationUnsuspendPayloadSchema,
  InstallationRepositoriesPayloadSchema,
  PushEventPayloadSchema,
  PullRequestPayloadSchema,
  IssuePayloadSchema,
} from '@/lib/integrations/platforms/github/webhook-schemas';
import { findIntegrationByInstallationId } from '@/lib/integrations/db/platform-integrations';
import {
  handleInstallationCreated,
  handleInstallationDeleted,
  handleInstallationSuspend,
  handleInstallationUnsuspend,
  handleInstallationRepositories,
  handlePushEvent,
  handlePullRequest,
  handleIssue,
} from '@/lib/integrations/platforms/github/webhook-handlers';
import { PLATFORM, GITHUB_EVENT, GITHUB_ACTION } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';
import { logWebhookEvent, updateWebhookEvent } from '@/lib/integrations/db/webhook-events';
import type { Owner } from '@/lib/integrations/core/types';
import type { GitHubAppType } from './app-selector';

/**
 * Shared GitHub App Webhook Handler
 *
 * Handles webhooks for both standard and lite GitHub Apps.
 * Thin routing layer that:
 * 1. Verifies webhook signature
 * 2. Parses the event
 * 3. Routes to appropriate handler
 * 4. Handles errors
 *
 * All business logic is in handler files
 *
 * @param request - The incoming Next.js request
 * @param appType - 'standard' for full-featured app, 'lite' for read-only OSS app
 */
export async function handleGitHubWebhook(
  request: NextRequest,
  appType: GitHubAppType
): Promise<Response> {
  // Helper for app-specific logging
  const logSuffix = appType === 'lite' ? ' (lite app)' : '';
  const sentryPrefix = appType === 'lite' ? 'github_lite_' : 'github_';

  try {
    // 1. Verify signature
    const rawBody = await request.text();
    const signature = request.headers.get('x-hub-signature-256') || '';

    if (!verifyGitHubWebhookSignature(rawBody, signature, appType)) {
      logExceptInTest(`Invalid webhook signature${logSuffix}`);
      return new NextResponse('Unauthorized', { status: 401 });
    }

    // 2. Parse JSON payload
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch (error) {
      logExceptInTest(`Error parsing GitHub webhook JSON body${logSuffix}:`, error);
      captureException(error, {
        tags: { source: `${sentryPrefix}webhook_parse_json` },
        extra: { rawBodyPreview: rawBody.substring(0, 200) },
      });
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    // 3. Get event type and action from headers
    const eventType = request.headers.get('x-github-event') || '';
    const eventSignature = request.headers.get('x-github-delivery');
    const headers = Object.fromEntries(request.headers);

    if (!eventType) {
      return NextResponse.json({ error: 'Missing x-github-event header' }, { status: 400 });
    }

    if (!eventSignature) {
      return NextResponse.json(
        { error: 'Missing x-github-delivery header in GitHub webhook request' },
        { status: 400 }
      );
    }

    // 4. Helper function to log webhook events
    const logWebhook = async (
      integration: { owned_by_organization_id: string | null; owned_by_user_id: string | null },
      action: string
    ) => {
      try {
        // Determine owner from integration
        const owner = integration.owned_by_organization_id
          ? { type: 'org' as const, id: integration.owned_by_organization_id }
          : ({ type: 'user' as const, id: integration.owned_by_user_id } as Owner);

        const { id, isDuplicate } = await logWebhookEvent({
          owner,
          platform: PLATFORM.GITHUB,
          event_type: eventType,
          event_action: action,
          payload,
          headers,
          event_signature: eventSignature,
        });

        if (isDuplicate) {
          logExceptInTest(`Duplicate webhook event detected${logSuffix}`);
          return { isDuplicate: true, webhookEventId: id };
        }
        return { isDuplicate: false, webhookEventId: id };
      } catch (error) {
        logExceptInTest(`Error logging webhook event${logSuffix}:`, error);
        captureException(error, {
          tags: { source: 'webhook_event_logging', ...(appType === 'lite' ? { app: 'lite' } : {}) },
          extra: { event_type: eventType, event_action: action },
        });
        return { isDuplicate: false, webhookEventId: undefined };
      }
    };

    // 5. Route based on event type with type-safe Zod parsing

    // Handle installation events
    if (eventType === GITHUB_EVENT.INSTALLATION) {
      const action = (payload as { action?: string }).action || '';

      if (action === GITHUB_ACTION.CREATED) {
        const parseResult = InstallationCreatedPayloadSchema.safeParse(payload);
        if (!parseResult.success) {
          logExceptInTest(`Invalid installation.created payload${logSuffix}:`, parseResult.error);
          captureMessage('Invalid GitHub webhook payload structure', {
            level: 'error',
            tags: { source: `${sentryPrefix}webhook_validation`, event: 'installation.created' },
            extra: { errors: parseResult.error.issues },
          });
          return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
        }
        // Note: For installation.created, webhook logging happens inside handler
        // because we need organization_id which is only available after processing
        return await handleInstallationCreated(parseResult.data);
      }

      if (action === GITHUB_ACTION.DELETED) {
        const parseResult = InstallationDeletedPayloadSchema.safeParse(payload);
        if (!parseResult.success) {
          logExceptInTest(`Invalid installation.deleted payload${logSuffix}:`, parseResult.error);
          captureMessage('Invalid GitHub webhook payload structure', {
            level: 'error',
            tags: { source: `${sentryPrefix}webhook_validation`, event: 'installation.deleted' },
            extra: { errors: parseResult.error.issues },
          });
          return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
        }

        // Get integration before deletion to log the event
        const installationId = parseResult.data.installation.id.toString();
        const integration = await findIntegrationByInstallationId(PLATFORM.GITHUB, installationId);

        if (integration) {
          const logResult = await logWebhook(integration, action);
          if (logResult.isDuplicate) {
            return NextResponse.json({ message: 'Duplicate event' }, { status: 200 });
          }

          const result = await handleInstallationDeleted(parseResult.data);

          // Mark webhook event as processed
          if (logResult.webhookEventId) {
            try {
              await updateWebhookEvent(logResult.webhookEventId, {
                processed: true,
                processed_at: new Date().toISOString(),
                handlers_triggered: ['installation_deleted'],
                errors: null,
              });
            } catch (error) {
              logExceptInTest(`Error updating webhook event${logSuffix}:`, error);
            }
          }

          return result;
        }

        return await handleInstallationDeleted(parseResult.data);
      }

      if (action === GITHUB_ACTION.SUSPEND) {
        const parseResult = InstallationSuspendPayloadSchema.safeParse(payload);
        if (!parseResult.success) {
          logExceptInTest(`Invalid installation.suspend payload${logSuffix}:`, parseResult.error);
          captureMessage('Invalid GitHub webhook payload structure', {
            level: 'error',
            tags: { source: `${sentryPrefix}webhook_validation`, event: 'installation.suspend' },
            extra: { errors: parseResult.error.issues },
          });
          return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
        }

        const installationId = parseResult.data.installation.id.toString();
        const integration = await findIntegrationByInstallationId(PLATFORM.GITHUB, installationId);

        if (integration) {
          const logResult = await logWebhook(integration, action);
          if (logResult.isDuplicate) {
            return NextResponse.json({ message: 'Duplicate event' }, { status: 200 });
          }

          const result = await handleInstallationSuspend(parseResult.data);

          // Mark webhook event as processed
          if (logResult.webhookEventId) {
            try {
              await updateWebhookEvent(logResult.webhookEventId, {
                processed: true,
                processed_at: new Date().toISOString(),
                handlers_triggered: ['installation_suspend'],
                errors: null,
              });
            } catch (error) {
              logExceptInTest(`Error updating webhook event${logSuffix}:`, error);
            }
          }

          return result;
        }

        return await handleInstallationSuspend(parseResult.data);
      }

      if (action === GITHUB_ACTION.UNSUSPEND) {
        const parseResult = InstallationUnsuspendPayloadSchema.safeParse(payload);
        if (!parseResult.success) {
          logExceptInTest(`Invalid installation.unsuspend payload${logSuffix}:`, parseResult.error);
          captureMessage('Invalid GitHub webhook payload structure', {
            level: 'error',
            tags: { source: `${sentryPrefix}webhook_validation`, event: 'installation.unsuspend' },
            extra: { errors: parseResult.error.issues },
          });
          return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
        }

        const installationId = parseResult.data.installation.id.toString();
        const integration = await findIntegrationByInstallationId(PLATFORM.GITHUB, installationId);

        if (integration) {
          const logResult = await logWebhook(integration, action);
          if (logResult.isDuplicate) {
            return NextResponse.json({ message: 'Duplicate event' }, { status: 200 });
          }

          const result = await handleInstallationUnsuspend(parseResult.data);

          // Mark webhook event as processed
          if (logResult.webhookEventId) {
            try {
              await updateWebhookEvent(logResult.webhookEventId, {
                processed: true,
                processed_at: new Date().toISOString(),
                handlers_triggered: ['installation_unsuspend'],
                errors: null,
              });
            } catch (error) {
              logExceptInTest(`Error updating webhook event${logSuffix}:`, error);
            }
          }

          return result;
        }

        return await handleInstallationUnsuspend(parseResult.data);
      }

      return NextResponse.json({ message: 'Event received' }, { status: 200 });
    }

    // Handle installation_repositories events
    if (eventType === GITHUB_EVENT.INSTALLATION_REPOSITORIES) {
      const parseResult = InstallationRepositoriesPayloadSchema.safeParse(payload);
      if (!parseResult.success) {
        logExceptInTest(
          `Invalid installation_repositories payload${logSuffix}:`,
          parseResult.error
        );
        captureMessage('Invalid GitHub webhook payload structure', {
          level: 'error',
          tags: { source: `${sentryPrefix}webhook_validation`, event: 'installation_repositories' },
          extra: { errors: parseResult.error.issues },
        });
        return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
      }

      const installationId = parseResult.data.installation.id.toString();
      const integration = await findIntegrationByInstallationId(PLATFORM.GITHUB, installationId);

      if (!integration) {
        console.warn(`Integration not found${logSuffix}:`, installationId);
        return NextResponse.json({ message: 'Integration not found' }, { status: 404 });
      }

      const action = parseResult.data.action;
      const logResult = await logWebhook(integration, action);
      if (logResult.isDuplicate) {
        return NextResponse.json({ message: 'Duplicate event' }, { status: 200 });
      }

      const result = await handleInstallationRepositories(parseResult.data);

      // Mark webhook event as processed
      if (logResult.webhookEventId) {
        try {
          await updateWebhookEvent(logResult.webhookEventId, {
            processed: true,
            processed_at: new Date().toISOString(),
            handlers_triggered: ['installation_repositories'],
            errors: null,
          });
        } catch (error) {
          logExceptInTest(`Error updating webhook event${logSuffix}:`, error);
        }
      }

      return result;
    }

    // For other events, verify integration exists and is not suspended
    const installation = (payload as { installation?: { id?: number } }).installation;
    const installationId = installation?.id?.toString();

    if (!installationId) {
      logExceptInTest(`Missing installation ID in payload${logSuffix}`);
      return NextResponse.json({ message: 'Missing installation ID' }, { status: 400 });
    }

    const integration = await findIntegrationByInstallationId(PLATFORM.GITHUB, installationId);

    if (!integration) {
      console.warn(`Integration not found for installation${logSuffix}:`, installationId);
      return NextResponse.json({ message: 'Integration not found' }, { status: 404 });
    }

    if (integration.suspended_at) {
      logExceptInTest(`Integration suspended, skipping event${logSuffix}`);
      return NextResponse.json({ message: 'Integration suspended' }, { status: 200 });
    }

    // Handle push events
    if (eventType === GITHUB_EVENT.PUSH) {
      const parseResult = PushEventPayloadSchema.safeParse(payload);
      if (!parseResult.success) {
        logExceptInTest(`Invalid push event payload${logSuffix}:`, parseResult.error);
        captureException(parseResult.error, {
          tags: { source: `${sentryPrefix}webhook_validation`, event: 'push' },
          extra: { errors: parseResult.error.issues },
        });
        return NextResponse.json({ error: 'Invalid push event payload' }, { status: 400 });
      }

      if (!parseResult.data.deleted) {
        // Process async
        after(async () => {
          await handlePushEvent(parseResult.data, integration);
        });
      }
      return NextResponse.json({ message: 'Event received' }, { status: 200 });
    }

    // Handle pull_request events
    if (eventType === GITHUB_EVENT.PULL_REQUEST) {
      const parseResult = PullRequestPayloadSchema.safeParse(payload);
      if (!parseResult.success) {
        logExceptInTest(`Invalid pull_request payload${logSuffix}:`, parseResult.error);
        captureMessage('Invalid GitHub webhook payload structure', {
          level: 'error',
          tags: { source: `${sentryPrefix}webhook_validation`, event: 'pull_request' },
          extra: { errors: parseResult.error.issues },
        });
        return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
      }

      const action = parseResult.data.action;

      // Filter out closed events - we don't log or process them
      if (action === GITHUB_ACTION.CLOSED) {
        return NextResponse.json({ message: 'Event received' }, { status: 200 });
      }

      // Log webhook event for both user and organization-owned integrations
      const logResult = await logWebhook(integration, action);
      if (logResult.isDuplicate) {
        return NextResponse.json({ message: 'Duplicate event' }, { status: 200 });
      }

      const result = await handlePullRequest(parseResult.data, integration);

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
          logExceptInTest(`Error updating webhook event${logSuffix}:`, error);
        }
      }

      return result;
    }

    // Handle issues events
    if (eventType === GITHUB_EVENT.ISSUES) {
      const parseResult = IssuePayloadSchema.safeParse(payload);
      if (!parseResult.success) {
        logExceptInTest(`Invalid issues payload${logSuffix}:`, parseResult.error);
        captureMessage('Invalid GitHub webhook payload structure', {
          level: 'error',
          tags: { source: `${sentryPrefix}webhook_validation`, event: 'issues' },
          extra: { errors: parseResult.error.issues },
        });
        return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
      }

      const action = parseResult.data.action;

      // Log webhook event for both user and organization-owned integrations
      const logResult = await logWebhook(integration, action);
      if (logResult.isDuplicate) {
        return NextResponse.json({ message: 'Duplicate event' }, { status: 200 });
      }

      const result = await handleIssue(parseResult.data, integration);

      // Mark webhook event as processed
      if (logResult.webhookEventId) {
        try {
          await updateWebhookEvent(logResult.webhookEventId, {
            processed: true,
            processed_at: new Date().toISOString(),
            handlers_triggered: ['auto_triage'],
            errors: null,
          });
        } catch (error) {
          logExceptInTest(`Error updating webhook event${logSuffix}:`, error);
        }
      }

      return result;
    }

    // Default: acknowledge receipt
    return NextResponse.json({ message: 'Event received' }, { status: 200 });
  } catch (error) {
    logExceptInTest(`Webhook error${logSuffix}:`, error);
    captureException(error, {
      tags: { source: `${sentryPrefix}webhook_handler` },
    });
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
