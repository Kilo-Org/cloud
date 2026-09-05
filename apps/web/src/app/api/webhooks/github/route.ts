import { NextRequest, after } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { bot } from '@/lib/bot';
import { handleGitHubWebhook } from '@/lib/integrations/platforms/github/webhook-handler';
import { assertGitHubInstallationRuntimeAuthorized } from '@/lib/integrations/github/runtime-authorization';

function cloneGitHubRequest(request: NextRequest, rawBody: string) {
  return new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    body: rawBody,
  });
}

function getGitHubInstallationId(rawBody: string): string | null {
  try {
    const payload: unknown = JSON.parse(rawBody);
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'installation' in payload &&
      typeof payload.installation === 'object' &&
      payload.installation !== null &&
      'id' in payload.installation &&
      (typeof payload.installation.id === 'number' || typeof payload.installation.id === 'string')
    ) {
      return payload.installation.id.toString();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * GitHub App Webhook Handler (Standard App)
 *
 * Full-featured KiloConnect app with read/write permissions.
 * Delegates to shared handler with 'standard' app type.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const botRequest = cloneGitHubRequest(request, rawBody);
  const installationId = getGitHubInstallationId(rawBody);

  after(async () => {
    if (!installationId) return;
    try {
      await assertGitHubInstallationRuntimeAuthorized(installationId, 'standard');
    } catch {
      return;
    }
    try {
      const response = await bot.webhooks.github(botRequest, {
        waitUntil: task => after(() => task),
      });

      if (!response.ok) {
        console.warn('[GitHub Webhook] Chat adapter returned non-ok response:', {
          status: response.status,
          statusText: response.statusText,
        });
      }
    } catch (error) {
      console.error('[GitHub Webhook] Chat adapter threw:', error);
      captureException(error, {
        tags: { endpoint: 'webhooks/github', source: 'chat_adapter' },
      });
    }
  });

  return handleGitHubWebhook(cloneGitHubRequest(request, rawBody), 'standard');
}
