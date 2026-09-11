const mockGithubWebhook = jest.fn();
const mockHandleGitHubWebhook = jest.fn();
const mockAssertRuntimeAuthorized = jest.fn();

let afterCallbacks: Array<() => Promise<void> | void> = [];

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    after: (fn: () => Promise<void> | void) => {
      afterCallbacks.push(fn);
    },
  };
});

jest.mock('@/lib/bot', () => ({
  bot: {
    webhooks: {
      github: (request: Request, options: unknown) => mockGithubWebhook(request, options),
    },
  },
}));

jest.mock('@/lib/integrations/platforms/github/webhook-handler', () => ({
  handleGitHubWebhook: (request: Request, appType: string) =>
    mockHandleGitHubWebhook(request, appType),
}));

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  GitHubRuntimeAuthorizationError: class GitHubRuntimeAuthorizationError extends Error {},
  assertGitHubInstallationRuntimeAuthorized: (installationId: string, appType: string) =>
    mockAssertRuntimeAuthorized(installationId, appType),
}));

import { POST } from './route';
import { GitHubRuntimeAuthorizationError } from '@/lib/integrations/github/runtime-authorization';

function githubRequest(
  eventType: string,
  payload: unknown,
  rawBody = JSON.stringify(payload)
): Request {
  return new Request('https://app.example.com/api/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': `delivery-${eventType}`,
      'x-github-event': eventType,
      'x-hub-signature-256': 'sha256=test',
    },
    body: rawBody,
  });
}

async function flushAfterCallbacks(): Promise<void> {
  const callbacks = afterCallbacks;
  afterCallbacks = [];
  await Promise.all(callbacks.map(callback => callback()));
}

describe('GitHub webhook route', () => {
  beforeEach(() => {
    afterCallbacks = [];
    jest.clearAllMocks();
    mockHandleGitHubWebhook.mockResolvedValue(new Response('legacy ok'));
    mockGithubWebhook.mockResolvedValue(new Response('bot ok'));
    mockAssertRuntimeAuthorized.mockResolvedValue(undefined);
  });

  it('clones the request body for legacy handling and bot handling', async () => {
    const payload = {
      action: 'created',
      installation: { id: 98765 },
      repository: {
        id: 123,
        name: 'widgets',
        full_name: 'acme/widgets',
        owner: { login: 'acme' },
      },
      comment: { id: 456, body: '@kilo fix this' },
    };

    const rawBody = JSON.stringify(payload, null, 2);

    const response = await POST(githubRequest('issue_comment', payload, rawBody) as never);
    await flushAfterCallbacks();

    expect(await response.text()).toBe('legacy ok');
    expect(mockHandleGitHubWebhook).toHaveBeenCalledTimes(1);
    expect(mockGithubWebhook).toHaveBeenCalledTimes(1);

    const legacyRequest = mockHandleGitHubWebhook.mock.calls[0][0] as Request;
    const botRequest = mockGithubWebhook.mock.calls[0][0] as Request;

    expect(legacyRequest).not.toBe(botRequest);
    expect(await legacyRequest.text()).toBe(rawBody);
    expect(await botRequest.text()).toBe(rawBody);
  });

  it('also sends installation webhooks to the bot adapter', async () => {
    await POST(
      githubRequest('installation', {
        action: 'created',
        installation: { id: 98765 },
      }) as never
    );
    await flushAfterCallbacks();

    expect(mockHandleGitHubWebhook).toHaveBeenCalledTimes(1);
    expect(mockGithubWebhook).toHaveBeenCalledTimes(1);
  });

  it('also sends unrelated GitHub events to the bot adapter', async () => {
    await POST(
      githubRequest('pull_request', {
        action: 'opened',
        installation: { id: 98765 },
      }) as never
    );
    await flushAfterCallbacks();

    expect(mockHandleGitHubWebhook).toHaveBeenCalledTimes(1);
    expect(mockGithubWebhook).toHaveBeenCalledTimes(1);
  });

  it('suppresses only expected local disconnect denial', async () => {
    mockAssertRuntimeAuthorized.mockRejectedValue(new GitHubRuntimeAuthorizationError());
    const response = await POST(
      githubRequest('issue_comment', { installation: { id: 98765 } }) as never
    );
    await flushAfterCallbacks();
    expect(response.status).toBe(200);
    expect(mockGithubWebhook).not.toHaveBeenCalled();
  });

  it('returns retryable failure when Chat authorization infrastructure fails', async () => {
    mockAssertRuntimeAuthorized.mockRejectedValue(new Error('database unavailable'));
    const response = await POST(
      githubRequest('issue_comment', { installation: { id: 98765 } }) as never
    );
    expect(response.status).toBe(503);
    expect(mockGithubWebhook).not.toHaveBeenCalled();
  });
});
