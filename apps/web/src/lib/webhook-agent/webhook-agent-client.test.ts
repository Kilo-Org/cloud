import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

const mockConfig = { WEBHOOK_AGENT_URL: 'https://webhook-agent.test' };
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-secret',
  get WEBHOOK_AGENT_URL() {
    return mockConfig.WEBHOOK_AGENT_URL;
  },
}));

import type * as WebhookAgentClient from './webhook-agent-client';

type Client = typeof WebhookAgentClient;
let buildInboundUrl!: Client['buildInboundUrl'];
let createWorkerTrigger!: Client['createWorkerTrigger'];
let deleteWorkerTrigger!: Client['deleteWorkerTrigger'];
let getWorkerTrigger!: Client['getWorkerTrigger'];
let getWorkerRequest!: Client['getWorkerRequest'];
let invokeWorkerScheduledTrigger!: Client['invokeWorkerScheduledTrigger'];
let isWebhookAgentConfigured!: Client['isWebhookAgentConfigured'];
let listWorkerRequests!: Client['listWorkerRequests'];
let updateWorkerTrigger!: Client['updateWorkerTrigger'];

// `jest` comes from '@jest/globals', so the mock above is not hoisted above a static import.
// Loading the client here makes it read the mocked config instead of the real one.
beforeAll(async () => {
  ({
    buildInboundUrl,
    createWorkerTrigger,
    deleteWorkerTrigger,
    getWorkerTrigger,
    getWorkerRequest,
    invokeWorkerScheduledTrigger,
    isWebhookAgentConfigured,
    listWorkerRequests,
    updateWorkerTrigger,
  } = await import('./webhook-agent-client'));
});

describe('webhook agent client variant forwarding', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['oauth/owner', undefined, '/user/'],
    [undefined, 'org-id', '/org/org-id/'],
  ])('fetches an individual request in the selected namespace', async (userId, orgId, path) => {
    const data = { id: 'request-id', processStatus: 'success', cloudAgentSessionId: 'cloud-id' };
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 }));
    expect(await getWorkerRequest(userId, orgId, 'trigger', 'request-id')).toMatchObject({
      success: true,
      data,
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(expect.stringContaining(path));
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('/trigger/requests/request-id')
    );
  });

  it('rejects a mismatched worker request ID', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { id: 'other', processStatus: 'success', cloudAgentSessionId: 'cloud-id' },
        }),
        { status: 200 }
      )
    );
    expect(await getWorkerRequest('owner', undefined, 'trigger', 'request-id')).toMatchObject({
      success: false,
      status: 502,
    });
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

  it('forwards widened flat allocation keys unchanged', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ data: { triggerId: 'trigger', inboundUrl: 'https://inbound' } }),
            { status: 200 }
          )
      );

    await createWorkerTrigger('user-1', undefined, 'trigger', {
      promptTemplate: 'Run task',
      sandboxAllocation: 'cloudflare-containers-standard-4',
    });
    await updateWorkerTrigger('user-1', undefined, 'trigger', {
      sandboxAllocation: 'vercel-large',
    });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      sandboxAllocation: 'cloudflare-containers-standard-4',
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({
      sandboxAllocation: 'vercel-large',
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

describe('webhook agent client environment forwarding', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serializes omitted, configured, and cleared environment values', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ data: { triggerId: 'trigger', inboundUrl: 'https://inbound' } }),
            { status: 200 }
          )
      );

    await createWorkerTrigger('user-1', undefined, 'trigger', { promptTemplate: 'Run task' });
    await createWorkerTrigger('user-1', undefined, 'trigger', {
      promptTemplate: 'Run task',
      environmentId: '11111111-1111-4111-8111-111111111111',
    });
    await createWorkerTrigger('user-1', undefined, 'trigger', {
      promptTemplate: 'Run task',
      environmentId: null,
    });
    await updateWorkerTrigger('user-1', undefined, 'trigger', { environmentId: null });
    await updateWorkerTrigger('user-1', undefined, 'trigger', { isActive: true });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
      'environmentId'
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toMatchObject({
      environmentId: '11111111-1111-4111-8111-111111111111',
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body))).toEqual({
      promptTemplate: 'Run task',
      environmentId: null,
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[3]?.[1]?.body))).toEqual({
      environmentId: null,
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[4]?.[1]?.body))).not.toHaveProperty(
      'environmentId'
    );
  });

  it('returns environment selection from worker configuration responses', async () => {
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
            environmentId: '11111111-1111-4111-8111-111111111111',
          },
        }),
        { status: 200 }
      )
    );

    await expect(getWorkerTrigger('user-1', undefined, 'trigger')).resolves.toMatchObject({
      found: true,
      config: { environmentId: '11111111-1111-4111-8111-111111111111' },
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

describe('unconfigured webhook agent worker', () => {
  afterEach(() => {
    mockConfig.WEBHOOK_AGENT_URL = 'https://webhook-agent.test';
    jest.restoreAllMocks();
  });

  // '' is what config.server resolves outside production when the URL is unset or production.
  it.each(['', 'http://webhook-agent.test', '/relative'])(
    'sends nothing and builds no URL for %j',
    async value => {
      mockConfig.WEBHOOK_AGENT_URL = value;
      const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no network'));
      const unavailable = {
        success: false,
        error: 'Webhook agent worker is not configured',
        status: 503,
      };

      expect(isWebhookAgentConfigured()).toBe(false);
      await expect(
        createWorkerTrigger('user-1', undefined, 'trigger', {
          targetType: 'cloud_agent',
          githubRepo: 'owner/repo',
          mode: 'code',
          model: 'model',
          promptTemplate: 'Run task',
        })
      ).resolves.toEqual({ ...unavailable, isConflict: false });
      // Not 404: callers delete their PostgreSQL row on a confirmed missing trigger.
      await expect(getWorkerTrigger('user-1', undefined, 'trigger')).resolves.toEqual({
        found: 'error',
        error: unavailable.error,
        status: 503,
      });
      await expect(
        updateWorkerTrigger('user-1', undefined, 'trigger', { isActive: false })
      ).resolves.toEqual({ ...unavailable, isNotFound: false });
      await expect(deleteWorkerTrigger('user-1', undefined, 'trigger')).resolves.toEqual({
        success: false,
        error: unavailable.error,
      });
      await expect(listWorkerRequests('user-1', undefined, 'trigger')).resolves.toEqual({
        ...unavailable,
        isNotFound: false,
      });
      await expect(getWorkerRequest('user-1', undefined, 'trigger', 'request')).resolves.toEqual(
        unavailable
      );
      await expect(invokeWorkerScheduledTrigger('user-1', undefined, 'trigger')).resolves.toEqual(
        unavailable
      );
      expect(() => buildInboundUrl('user-1', undefined, 'trigger')).toThrow(
        expect.objectContaining({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Webhook triggers are unavailable',
        })
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it('builds inbound URLs from a configured nonproduction origin', () => {
    mockConfig.WEBHOOK_AGENT_URL = 'http://localhost:8793';
    expect(buildInboundUrl(undefined, 'org-id', 'trigger')).toBe(
      'http://localhost:8793/inbound/org/org-id/trigger'
    );
  });
});
