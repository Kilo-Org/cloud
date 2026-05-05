import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { bot } from '@/lib/bot';
import { handleGitHubWebhook } from '@/lib/integrations/platforms/github/webhook-handler';

type GitHubWebhookPayloadForChat = {
  action?: string;
  installation?: { id?: number };
  repository?: {
    full_name?: string;
    id?: number;
    name?: string;
    owner?: { id?: number; login?: string; type?: string };
  };
};

function cloneGitHubRequest(request: Request, body: BodyInit): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}

function repositoryOwnerFromFullName(fullName: string): string | undefined {
  const slashIndex = fullName.indexOf('/');
  if (slashIndex <= 0) return undefined;
  return fullName.slice(0, slashIndex);
}

function normalizeGitHubRepositoryForChat<TPayload extends GitHubWebhookPayloadForChat>(
  payload: TPayload
): TPayload {
  const repository = payload.repository;
  if (!repository) return payload;

  const fullName = repository.full_name;
  const ownerLogin =
    repository.owner?.login ?? (fullName ? repositoryOwnerFromFullName(fullName) : undefined);
  if (!ownerLogin) return payload;

  return {
    ...payload,
    repository: {
      ...repository,
      id: repository.id ?? 0,
      name: repository.name ?? fullName?.slice(ownerLogin.length + 1) ?? '',
      full_name: fullName ?? `${ownerLogin}/${repository.name ?? ''}`,
      owner: {
        id: repository.owner?.id ?? 0,
        login: ownerLogin,
        type: repository.owner?.type ?? 'Organization',
      },
    },
  };
}

function clonePayloadWithChatInstallation<TPayload extends GitHubWebhookPayloadForChat>(
  payload: TPayload
): TPayload {
  if (!payload.installation?.id) return normalizeGitHubRepositoryForChat(payload);

  return normalizeGitHubRepositoryForChat({
    ...payload,
    installation: {
      ...payload.installation,
      account: { id: 0, login: '', type: 'Organization' },
      repository_selection: 'selected',
      permissions: {},
      created_at: '',
    },
  });
}

function cloneGitHubRequestForBot(request: Request, body: string): Request {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('Invalid GitHub webhook JSON body');
  }

  return cloneGitHubRequest(
    request,
    JSON.stringify(clonePayloadWithChatInstallation(payload as GitHubWebhookPayloadForChat))
  );
}

function shouldForwardGitHubWebhookToBot(request: Request, body: string): boolean {
  const eventType = request.headers.get('x-github-event');
  if (eventType !== 'issue_comment' && eventType !== 'pull_request_review_comment') {
    return true;
  }

  try {
    const payload = JSON.parse(body) as GitHubWebhookPayloadForChat;
    return payload.action === 'created';
  } catch {
    return true;
  }
}

function forwardGitHubWebhookToBot(request: Request, body: string): Promise<Response> {
  return bot.webhooks.github(cloneGitHubRequestForBot(request, body), {
    waitUntil: task => after(() => task),
  });
}

/**
 * GitHub App Webhook Handler (Standard App)
 *
 * Full-featured KiloConnect app with read/write permissions.
 * Delegates to shared handler with 'standard' app type.
 */
export async function POST(request: NextRequest) {
  const body = await request.text();
  const legacyRequest = cloneGitHubRequest(request, body) as NextRequest;

  if (shouldForwardGitHubWebhookToBot(request, body)) {
    after(async () => {
      const response = await forwardGitHubWebhookToBot(request, body);
      if (!response.ok) {
        console.warn('[GitHub Webhook] Chat adapter returned non-ok response:', {
          status: response.status,
          statusText: response.statusText,
        });
      }
    });
  }

  return handleGitHubWebhook(legacyRequest, 'standard');
}
