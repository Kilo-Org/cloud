import { describe, expect, it, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { SLACK_SIGNING_SECRET } from '@/lib/config.server';

const mockCaptureException = jest.fn();
jest.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException }));

import {
  createSlackWebhookHandler,
  getSlackTeamId,
  runSlackMaintenanceBestEffort,
} from './slack-webhook';

describe('getSlackTeamId', () => {
  it('uses the enterprise ID for an org-wide uninstall event', () => {
    expect(getSlackTeamId({ team_id: null, enterprise_id: 'E_GRID' })).toBe('E_GRID');
  });

  it('uses the enterprise installation ID when both enterprise and team IDs are present', () => {
    expect(
      getSlackTeamId({
        team_id: 'T_WORKSPACE',
        enterprise_id: 'E_GRID',
        authorizations: [{ enterprise_id: 'E_GRID', is_enterprise_install: true }],
      })
    ).toBe('E_GRID');
  });

  it('uses the workspace ID for a workspace uninstall event', () => {
    expect(getSlackTeamId({ team_id: 'T_WORKSPACE', enterprise_id: null })).toBe('T_WORKSPACE');
  });

  it('reads Chat SDK inner message and interactive team shapes', () => {
    expect(getSlackTeamId({ team: 'T_MESSAGE' })).toBe('T_MESSAGE');
    expect(getSlackTeamId({ team: { id: 'T_INTERACTIVE' } })).toBe('T_INTERACTIVE');
  });
});

function signedRequest(body: string, options: { timestamp?: number; signatureBody?: string } = {}) {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${options.signatureBody ?? body}`)
    .digest('hex')}`;
  return new Request('https://example.test/slack', {
    method: 'POST',
    headers: {
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': signature,
    },
    body,
  });
}

describe('createSlackWebhookHandler', () => {
  it('verifies the raw body before initializing and forwards it unchanged', async () => {
    const body = JSON.stringify({ type: 'event_callback', team_id: 'T_TEAM', event: {} });
    const initialize = jest.fn(async () => undefined);
    const handleWebhook = jest.fn(async (request: Request) => {
      expect(await request.text()).toBe(body);
      return new Response('ok');
    });
    const handler = createSlackWebhookHandler(
      { initialize, getState: jest.fn() } as never,
      { handleWebhook, deleteInstallation: jest.fn(), setInstallation: jest.fn() } as never,
      { cleanup: jest.fn(async () => true), recover: jest.fn(async () => true) }
    );

    await expect(handler(signedRequest(body))).resolves.toMatchObject({ status: 200 });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(handleWebhook).toHaveBeenCalledTimes(1);
  });

  it('rejects tampered and stale requests before initialization', async () => {
    const initialize = jest.fn(async () => undefined);
    const handleWebhook = jest.fn();
    const handler = createSlackWebhookHandler(
      { initialize, getState: jest.fn() } as never,
      { handleWebhook } as never
    );
    const body = JSON.stringify({ type: 'event_callback', team_id: 'T_TEAM' });
    await expect(
      handler(signedRequest(body, { signatureBody: `${body}tampered` }))
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      handler(signedRequest(body, { timestamp: Math.floor(Date.now() / 1000) - 600 }))
    ).resolves.toMatchObject({ status: 401 });
    expect(initialize).not.toHaveBeenCalled();
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('dispatches after sanitized maintenance failures and propagates adapter failures', async () => {
    const body = JSON.stringify({ type: 'event_callback', team_id: 'T_TEAM', event: {} });
    const adapterError = new Error('adapter unavailable');
    const handler = createSlackWebhookHandler(
      { initialize: jest.fn(async () => undefined), getState: jest.fn() } as never,
      {
        handleWebhook: jest.fn(async () => {
          throw adapterError;
        }),
      } as never,
      {
        cleanup: jest.fn(async () => {
          throw new Error('secret xoxb-hidden');
        }),
        recover: jest.fn(async () => {
          throw new Error('recovery failed');
        }),
      }
    );
    await expect(handler(signedRequest(body))).rejects.toBe(adapterError);
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain('xoxb-hidden');
  });
});

describe('runSlackMaintenanceBestEffort', () => {
  it('continues to activation recovery when deletion maintenance fails', async () => {
    const recover = jest.fn(async () => undefined);
    await expect(
      runSlackMaintenanceBestEffort(
        'T_TEAM',
        async () => {
          throw new Error('database unavailable token=xoxb-secret');
        },
        recover
      )
    ).resolves.toBeUndefined();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain('xoxb-secret');
  });
});
