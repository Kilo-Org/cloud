import crypto from 'node:crypto';
import { beforeEach, describe, expect, test } from '@jest/globals';
import type { Chat } from 'chat';
import type { LinearAdapter } from '@chat-adapter/linear';

jest.mock('@/lib/config.server', () => ({
  LINEAR_WEBHOOK_SECRET: 'test-webhook-secret',
}));

jest.mock('@/lib/bot-identity', () => ({
  unlinkTeamKiloUsers: jest.fn(async () => 0),
}));

jest.mock('@/lib/integrations/linear-service', () => ({
  deleteInstallationByOrganizationId: jest.fn(async () => ({ success: true, deleted: true })),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import { unlinkTeamKiloUsers } from '@/lib/bot-identity';
import { deleteInstallationByOrganizationId } from '@/lib/integrations/linear-service';
import { createLinearWebhookHandler } from './linear-webhook';

const WEBHOOK_SECRET = 'test-webhook-secret';

function signLinearBody(body: string): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

function makeChatStub(): Chat {
  return {
    initialize: jest.fn(async () => undefined),
    getState: jest.fn(() => ({ kind: 'state' })),
  } as unknown as Chat;
}

function makeLinearAdapterStub() {
  return {
    handleWebhook: jest.fn(async () => new Response('adapter-handled', { status: 200 })),
    deleteInstallation: jest.fn(async () => undefined),
  } as unknown as LinearAdapter;
}

function makeRequest(body: string, headers: Record<string, string>): Request {
  return new Request('http://localhost/api/webhooks/linear', {
    method: 'POST',
    headers,
    body,
  });
}

describe('createLinearWebhookHandler signature verification', () => {
  let chat: Chat;
  let linearAdapter: LinearAdapter;
  let handler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    chat = makeChatStub();
    linearAdapter = makeLinearAdapterStub();
    handler = createLinearWebhookHandler(chat, linearAdapter);
  });

  test('rejects requests missing the linear-timestamp header', async () => {
    const body = JSON.stringify({ ping: true });
    const request = makeRequest(body, {
      'linear-signature': signLinearBody(body),
    });

    const response = await handler(request);

    expect(response.status).toBe(401);
  });

  test('rejects requests with a stale timestamp (>60s old)', async () => {
    const body = JSON.stringify({ ping: true });
    const staleTimestamp = (Date.now() - 120 * 1000).toString();
    const request = makeRequest(body, {
      'linear-signature': signLinearBody(body),
      'linear-timestamp': staleTimestamp,
    });

    const response = await handler(request);

    expect(response.status).toBe(401);
  });

  test('rejects requests with a non-numeric timestamp', async () => {
    const body = JSON.stringify({ ping: true });
    const request = makeRequest(body, {
      'linear-signature': signLinearBody(body),
      'linear-timestamp': 'not-a-number',
    });

    const response = await handler(request);

    expect(response.status).toBe(401);
  });

  test('forwards valid requests to the adapter', async () => {
    const body = JSON.stringify({ type: 'Issue', action: 'create' });
    const request = makeRequest(body, {
      'linear-signature': signLinearBody(body),
      'linear-timestamp': Date.now().toString(),
    });

    const response = await handler(request);

    expect(response.status).toBe(200);
    expect(linearAdapter.handleWebhook).toHaveBeenCalledTimes(1);
  });

  test('rejects requests with an invalid signature', async () => {
    const body = JSON.stringify({ ping: true });
    const request = makeRequest(body, {
      'linear-signature': 'a'.repeat(64),
      'linear-timestamp': Date.now().toString(),
    });

    const response = await handler(request);

    expect(response.status).toBe(401);
  });
});

describe('createLinearWebhookHandler OAuthApp revoked handling', () => {
  let chat: Chat;
  let linearAdapter: LinearAdapter;
  let handler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    chat = makeChatStub();
    linearAdapter = makeLinearAdapterStub();
    handler = createLinearWebhookHandler(chat, linearAdapter);
  });

  function makeRevokedRequest(organizationId: string): Request {
    const body = JSON.stringify({ type: 'OAuthApp', action: 'revoked', organizationId });
    return makeRequest(body, {
      'linear-signature': signLinearBody(body),
      'linear-timestamp': Date.now().toString(),
    });
  }

  test('cleans up local installation after upstream delete succeeds', async () => {
    const response = await handler(makeRevokedRequest('org-123'));

    expect(response.status).toBe(200);
    expect(linearAdapter.deleteInstallation).toHaveBeenCalledWith('org-123');
    expect(deleteInstallationByOrganizationId).toHaveBeenCalledWith('org-123');
    expect(unlinkTeamKiloUsers).toHaveBeenCalled();
    expect(linearAdapter.handleWebhook).not.toHaveBeenCalled();
  });

  test('preserves local installation row when upstream delete fails', async () => {
    (linearAdapter.deleteInstallation as jest.Mock).mockRejectedValueOnce(
      new Error('upstream boom')
    );

    const response = await handler(makeRevokedRequest('org-456'));

    expect(response.status).toBe(200);
    expect(linearAdapter.deleteInstallation).toHaveBeenCalledWith('org-456');
    expect(deleteInstallationByOrganizationId).not.toHaveBeenCalled();
    expect(unlinkTeamKiloUsers).not.toHaveBeenCalled();
  });
});
