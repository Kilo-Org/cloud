import { NextRequest, after } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { bot } from '@/lib/bot';
import { handleGitHubWebhook } from '@/lib/integrations/platforms/github/webhook-handler';

function cloneGitHubRequest(request: NextRequest, rawBody: string) {
  return new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    body: rawBody,
  });
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

  after(async () => {
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
