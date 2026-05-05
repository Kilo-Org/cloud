import { NextRequest } from 'next/server';
import { after } from 'next/server';
import { bot } from '@/lib/bot';
import { handleGitHubWebhook } from '@/lib/integrations/platforms/github/webhook-handler';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function shouldSendToBotAdapter(eventType: string | null, body: unknown) {
  if (!isRecord(body)) return true;
  return !(eventType === 'issue_comment' && body.action === 'edited');
}

function normalizeBotWebhookBody(body: unknown) {
  if (!isRecord(body)) return body;

  const installation = body.installation;
  if (!isRecord(installation) || 'account' in installation) return body;

  return {
    ...body,
    installation: {
      ...installation,
      account: body.repository,
    },
  };
}

function cloneGitHubRequest(request: NextRequest, body: unknown) {
  return new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
}

/**
 * GitHub App Webhook Handler (Standard App)
 *
 * Full-featured KiloConnect app with read/write permissions.
 * Delegates to shared handler with 'standard' app type.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();

  if (shouldSendToBotAdapter(request.headers.get('x-github-event'), body)) {
    const botRequest = cloneGitHubRequest(request, normalizeBotWebhookBody(body));

    after(async () => {
      const response = await bot.webhooks.github(botRequest, {
        waitUntil: task => after(() => task),
      });

      if (!response.ok) {
        console.warn('[GitHub Webhook] Chat adapter returned non-ok response:', {
          status: response.status,
          statusText: response.statusText,
        });
      }
    });
  }

  return handleGitHubWebhook(cloneGitHubRequest(request, body), 'standard');
}
