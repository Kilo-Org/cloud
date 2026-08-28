import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-secret',
  WEBHOOK_AGENT_URL: 'https://webhook-agent.test',
}));

import {
  createWorkerTrigger,
  getWorkerTrigger,
  invokeWorkerScheduledTrigger,
  updateWorkerTrigger,
} from './webhook-agent-client';

describe('webhook agent client variant forwarding', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('omits variant from create requests when it is not configured', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ data: { triggerId: 'trigger', inboundUrl: 'https://inbound' } }),
        {
          status: 200,
        }
      )
    );

    await createWorkerTrigger('user-1', undefined, 'trigger', { promptTemplate: 'Run task' });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).not.toHaveProperty('variant');
  });

  it('forwards configured create variants', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ data: { triggerId: 'trigger', inboundUrl: 'https://inbound' } }),
        {
          status: 200,
        }
      )
    );

    await createWorkerTrigger('user-1', undefined, 'trigger', {
      promptTemplate: 'Run task',
      variant: 'high',
    });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      variant: 'high',
    });
  });

  it('omits variant from update requests when it is not configured', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            triggerId: 'trigger',
            namespace: 'user/user-1',
            userId: 'user-1',
            orgId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            isActive: true,
            targetType: 'cloud_agent',
            githubRepo: 'owner/repo',
            mode: 'code',
            model: 'model',
            promptTemplate: 'Run task',
            webhookAuthConfigured: false,
            activationMode: 'webhook',
          },
        }),
        { status: 200 }
      )
    );

    await updateWorkerTrigger('user-1', undefined, 'trigger', { isActive: true });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).not.toHaveProperty('variant');
  });

  it.each([
    ['sets', 'high'],
    ['clears', null],
  ])('%s update variants', async (_operation, variant) => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            triggerId: 'trigger',
            namespace: 'user/user-1',
            userId: 'user-1',
            orgId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            isActive: true,
            targetType: 'cloud_agent',
            githubRepo: 'owner/repo',
            mode: 'code',
            model: 'model',
            promptTemplate: 'Run task',
            webhookAuthConfigured: false,
            activationMode: 'webhook',
            variant,
          },
        }),
        { status: 200 }
      )
    );

    await updateWorkerTrigger('user-1', undefined, 'trigger', { variant });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ variant });
  });
});

describe('webhook agent client sandbox allocation forwarding', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serializes omitted, configured, and cleared allocation values', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ data: { triggerId: 'trigger', inboundUrl: 'https://inbound' } }),
          {
            status: 200,
          }
        )
    );

    await createWorkerTrigger('user-1', undefined, 'trigger', { promptTemplate: 'Run task' });
    await createWorkerTrigger('user-1', undefined, 'trigger', {
      promptTemplate: 'Run task',
      sandboxAllocation: 'isolated-standard',
    });
    await updateWorkerTrigger('user-1', undefined, 'trigger', { sandboxAllocation: null });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
      'sandboxAllocation'
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toMatchObject({
      sandboxAllocation: 'isolated-standard',
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body))).toEqual({
      sandboxAllocation: null,
    });
  });

  it('returns sandbox allocation from worker configuration responses', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            triggerId: 'trigger',
            namespace: 'user/user-1',
            userId: 'user-1',
            orgId: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            isActive: true,
            targetType: 'cloud_agent',
            githubRepo: 'owner/repo',
            mode: 'code',
            model: 'model',
            promptTemplate: 'Run task',
            webhookAuthConfigured: false,
            activationMode: 'webhook',
            sandboxAllocation: 'isolated-standard',
          },
        }),
        { status: 200 }
      )
    );

    await expect(getWorkerTrigger('user-1', undefined, 'trigger')).resolves.toMatchObject({
      found: true,
      config: { sandboxAllocation: 'isolated-standard' },
    });
  });
});

describe('scheduled trigger invocation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts an invocation without a body and validates the accepted response', async () => {
    const requestId = '00000000-0000-4000-8000-000000000001';
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { requestId } }), { status: 202 })
      );

    await expect(
      invokeWorkerScheduledTrigger('oauth/google:123', undefined, 'scheduled-trigger')
    ).resolves.toEqual({ success: true, requestId });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /\/api\/triggers\/user\/o-b2F1dGgvZ29vZ2xlOjEyMw\/scheduled-trigger\/invoke$/
      ),
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns sanitized worker failures', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));

    await expect(
      invokeWorkerScheduledTrigger(
        undefined,
        '00000000-0000-4000-8000-000000000002',
        'scheduled-trigger'
      )
    ).resolves.toEqual({
      success: false,
      error: 'Scheduled trigger invocation failed',
      status: 404,
    });
  });

  it('handles malformed successful responses safely', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { requestId: 'not-a-uuid' } }), {
        status: 202,
      })
    );

    await expect(
      invokeWorkerScheduledTrigger('user-1', undefined, 'scheduled-trigger')
    ).resolves.toEqual({
      success: false,
      error: 'Scheduled trigger invocation failed',
      status: 502,
    });
  });

  it('makes one request when the network fails', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('network unavailable'));

    await expect(
      invokeWorkerScheduledTrigger('user-1', undefined, 'scheduled-trigger')
    ).resolves.toEqual({
      success: false,
      error: 'Scheduled trigger invocation failed',
      status: 502,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
