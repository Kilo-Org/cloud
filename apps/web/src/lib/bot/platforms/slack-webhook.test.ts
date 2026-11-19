import crypto from 'node:crypto';
import { beforeEach, describe, expect, test } from '@jest/globals';
import type { Chat, WebhookOptions } from 'chat';
import type { SlackAdapter } from '@chat-adapter/slack';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  SLACK_SIGNING_SECRET: 'test-signing-secret',
}));

jest.mock('@/lib/bot-identity', () => ({
  unlinkTeamKiloUsers: jest.fn(async () => 0),
}));

jest.mock('@/lib/integrations/slack-service', () => ({
  deleteInstallationByTeamId: jest.fn(async () => ({ success: true, deleted: true })),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import { captureException } from '@sentry/nextjs';
import { unlinkTeamKiloUsers } from '@/lib/bot-identity';
import { deleteInstallationByTeamId } from '@/lib/integrations/slack-service';
import { createSlackWebhookHandler } from './slack-webhook';
import { MAX_WEBHOOK_BODY_BYTES } from './webhook-body';

const SIGNING_SECRET = 'test-signing-secret';

function signSlackBody(timestamp: string, body: string): string {
  const baseString = `v0:${timestamp}:${body}`;
  return `v0=${crypto.createHmac('sha256', SIGNING_SECRET).update(baseString).digest('hex')}`;
}

function makeChatStub(): Chat {
  return {
    initialize: jest.fn(async () => undefined),
    getState: jest.fn(() => ({ kind: 'state' })),
  } as unknown as Chat;
}

function makeSlackAdapterStub() {
  return {
    handleWebhook: jest.fn(async () => new Response('adapter-handled', { status: 200 })),
    deleteInstallation: jest.fn(async () => undefined),
  } as unknown as SlackAdapter;
}

function makeRequest(body: string, headers: Record<string, string>): Request {
  return new Request('http://localhost/api/webhooks/slack', {
    method: 'POST',
    headers,
    body,
  });
}

function signedHeaders(body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    'content-type': 'application/json',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signSlackBody(timestamp, body),
  };
}

describe('createSlackWebhookHandler', () => {
  let chat: Chat;
  let slackAdapter: SlackAdapter;
  let handler: (request: Request, options?: WebhookOptions) => Promise<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    chat = makeChatStub();
    slackAdapter = makeSlackAdapterStub();
    handler = createSlackWebhookHandler(chat, slackAdapter);
  });

  test('forwards a valid signed body to the adapter', async () => {
    const body = JSON.stringify({ type: 'event_callback', event: { type: 'message' } });
    const request = makeRequest(body, signedHeaders(body));

    const response = await handler(request);

    expect(response.status).toBe(200);
    expect(slackAdapter.handleWebhook).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
  });

  test('cleans up the installation for an app_uninstalled event', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event: { type: 'app_uninstalled' },
    });
    const request = makeRequest(body, signedHeaders(body));

    const response = await handler(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(slackAdapter.deleteInstallation).toHaveBeenCalledWith('T123');
    expect(deleteInstallationByTeamId).toHaveBeenCalledWith('T123');
    expect(unlinkTeamKiloUsers).toHaveBeenCalled();
    expect(slackAdapter.handleWebhook).not.toHaveBeenCalled();
  });

  test('rejects requests with an invalid signature', async () => {
    const body = JSON.stringify({ ping: true });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const request = makeRequest(body, {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': 'v0=' + 'a'.repeat(64),
    });

    const response = await handler(request);

    expect(response.status).toBe(401);
    expect(slackAdapter.handleWebhook).not.toHaveBeenCalled();
  });

  test('rejects a declared content-length over the size limit with 413 before reading the body', async () => {
    const overLimitLength = MAX_WEBHOOK_BODY_BYTES + 1;
    const request = makeRequest('', {
      'content-length': String(overLimitLength),
      ...signedHeaders(''),
    });

    const response = await handler(request);

    expect(response.status).toBe(413);
    expect(slackAdapter.handleWebhook).not.toHaveBeenCalled();
    expect(slackAdapter.deleteInstallation).not.toHaveBeenCalled();
    expect(chat.initialize).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  test('rejects a streamed body over the size limit with 413', async () => {
    const encoder = new TextEncoder();
    const half = 'a'.repeat(MAX_WEBHOOK_BODY_BYTES / 2 + 1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(half));
        controller.enqueue(encoder.encode(half));
        controller.close();
      },
    });
    const request = new Request('http://localhost/api/webhooks/slack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // @ts-expect-error duplex is required by the stream body type in Node's fetch
      duplex: 'half',
    });

    const response = await handler(request);

    expect(response.status).toBe(413);
    expect(slackAdapter.handleWebhook).not.toHaveBeenCalled();
    expect(slackAdapter.deleteInstallation).not.toHaveBeenCalled();
    expect(chat.initialize).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});
