import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  evaluateContainerAllocations,
  NATIVE_CONTAINER_APP,
  queryContainerAllocations,
} from '../src/alerting/container-allocations';
import { buildSlackMessage, type AlertPayload } from '../src/alerting/notify';

const application = {
  id: 'production-id',
  name: 'cloud-agent-next-sandboxcontainers',
  scheduling_policy: 'durable_object',
};

function page(result: unknown[], nextPageToken?: string) {
  return new Response(
    JSON.stringify({ success: true, result, result_info: { next_page_token: nextPageToken } })
  );
}

function instance(id: string, state: string) {
  return { id, status: { state } };
}

function makeEnv() {
  const store = new Map<string, string>();
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string, _options?: KVNamespacePutOptions) => {
    store.set(key, value);
  });
  const secret = { get: async () => 'test-token' } as SecretsStoreSecret;
  return {
    env: {
      O11Y_CF_ACCOUNT_ID: 'test-account',
      O11Y_CF_CONTAINERS_API_TOKEN: secret,
      O11Y_ALERT_STATE: { get, put } as unknown as KVNamespace,
      O11Y_SLACK_WEBHOOK_PAGE: secret,
      O11Y_SLACK_WEBHOOK_TICKET: secret,
    },
    store,
    get,
    put,
  };
}

describe('queryContainerAllocations', () => {
  it('discovers only the exact production app, paginates both lists, and counts unique allocations', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        page([{ ...application, id: 'staging-id', name: `${application.name}-staging` }], 'apps/+2')
      )
      .mockResolvedValueOnce(page([application]))
      .mockResolvedValueOnce(
        page([instance('a', 'running'), instance('b', 'provisioning')], 'instances/+2')
      )
      .mockResolvedValueOnce(
        page([instance('a', 'running'), instance('c', 'stopping'), instance('c', 'stopping')])
      );

    await expect(queryContainerAllocations(makeEnv().env, fetchFn)).resolves.toEqual({
      running: 1,
      provisioning: 1,
      stopping: 1,
    });
    const urls = fetchFn.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map(url => url.pathname)).toEqual([
      '/client/v4/accounts/test-account/containers/applications',
      '/client/v4/accounts/test-account/containers/applications',
      '/client/v4/accounts/test-account/containers/applications/production-id/instances-v2',
      '/client/v4/accounts/test-account/containers/applications/production-id/instances-v2',
    ]);
    expect(urls.map(url => Object.fromEntries(url.searchParams))).toEqual([
      { name: application.name, per_page: '100' },
      { name: application.name, per_page: '100', page_token: 'apps/+2' },
      { state: 'active', per_page: '1000' },
      { state: 'active', per_page: '1000', page_token: 'instances/+2' },
    ]);
    for (const [, init] of fetchFn.mock.calls) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('returns zero allocations for an application without instances or max_instances fields', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page([application]))
      .mockResolvedValueOnce(page([]));
    await expect(queryContainerAllocations(makeEnv().env, fetchFn)).resolves.toEqual({
      running: 0,
      provisioning: 0,
      stopping: 0,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('rejects staging-only discovery instead of querying staging allocations', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page([{ ...application, name: `${application.name}-staging` }]));
    await expect(queryContainerAllocations(makeEnv().env, fetchFn)).rejects.toThrow(
      `Container application not found: ${application.name}`
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects an application not managed by Durable Objects', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page([{ ...application, scheduling_policy: 'default' }]));
    await expect(queryContainerAllocations(makeEnv().env, fetchFn)).rejects.toThrow(
      'not a Durable Object-managed application'
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each(['applications', 'instances'])('rejects HTTP errors from %s', async stage => {
    const fetchFn = vi.fn<typeof fetch>();
    if (stage === 'instances') fetchFn.mockResolvedValueOnce(page([application]));
    fetchFn.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(queryContainerAllocations(makeEnv().env, fetchFn)).rejects.toThrow(
      'Container allocations request failed (503)'
    );
  });

  it.each([
    ['applications', { success: false, result: [], result_info: {} }],
    ['instances', { success: false, result: [], result_info: {} }],
    ['applications', { success: true, result: [{ id: 'missing-name' }], result_info: {} }],
    ['instances', { success: true, result: [instance('a', 'unknown')], result_info: {} }],
    ['instances', { success: true, result: [] }],
  ])('rejects unsuccessful or invalid %s data: %j', async (stage, body) => {
    const fetchFn = vi.fn<typeof fetch>();
    if (stage === 'instances') fetchFn.mockResolvedValueOnce(page([application]));
    fetchFn.mockResolvedValueOnce(new Response(JSON.stringify(body)));
    await expect(queryContainerAllocations(makeEnv().env, fetchFn)).rejects.toThrow();
  });

  it.each(['applications', 'instances'])('bounds %s pagination to 50 pages', async stage => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => page([], 'more'));
    if (stage === 'instances') fetchFn.mockResolvedValueOnce(page([application]));
    await expect(queryContainerAllocations(makeEnv().env, fetchFn)).rejects.toThrow(
      stage === 'instances' ? 'pagination exceeded 50 pages' : 'Container application not found'
    );
    expect(fetchFn).toHaveBeenCalledTimes(stage === 'instances' ? 51 : 50);
  });

  it('fails before fetching when the API token is missing', async () => {
    const { env } = makeEnv();
    env.O11Y_CF_CONTAINERS_API_TOKEN = { get: async () => '' } as SecretsStoreSecret;
    const fetchFn = vi.fn<typeof fetch>();
    await expect(queryContainerAllocations(env, fetchFn)).rejects.toThrow(
      'O11Y_CF_CONTAINERS_API_TOKEN secret is not configured'
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('evaluateContainerAllocations', () => {
  let log: MockInstance<typeof console.log>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [499, null, null, null],
    [500, 'info', 500, 14400],
    [999, 'info', 500, 14400],
    [1000, 'ticket', 1000, 14400],
    [1499, 'ticket', 1000, 14400],
    [1500, 'page', 1500, 900],
  ] as const)(
    'evaluates %i allocations at the exact severity boundary',
    async (total, severity, threshold, ttl) => {
      const { env, get, put } = makeEnv();
      const counts = { running: total - 3, provisioning: 2, stopping: 1 };
      const notify = vi.fn(async (_alert: AlertPayload) => {});
      await evaluateContainerAllocations(env, async () => counts, notify);

      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0][0])).toEqual({
        metric: 'container_allocations',
        application: application.name,
        observedAt: expect.any(String),
        allocatedInstances: total,
        ...counts,
      });
      if (severity === null) {
        expect(notify).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
        expect(put).not.toHaveBeenCalled();
        return;
      }
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        {
          alertType: 'container_capacity',
          severity,
          provider: 'cloudflare',
          model: application.name,
          clientName: 'containers',
          allocatedInstances: total,
          thresholdCount: threshold,
          counts,
        },
        env
      );
      expect(put).toHaveBeenCalledExactlyOnceWith(
        `o11y:alert:${severity}:container_capacity:cloudflare:${application.name}:containers`,
        expect.any(String),
        { expirationTtl: ttl }
      );
    }
  );

  it('allows escalation but suppresses repeat and lower-severity alerts during cooldown', async () => {
    const { env, put } = makeEnv();
    const notify = vi.fn(async (_alert: AlertPayload) => {});
    for (const total of [500, 500, 1000, 500, 1500, 1500, 1000, 500]) {
      await evaluateContainerAllocations(
        env,
        async () => ({ running: total, provisioning: 0, stopping: 0 }),
        notify
      );
    }
    expect(notify.mock.calls.map(([alert]) => alert.severity)).toEqual(['info', 'ticket', 'page']);
    expect(put).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(8);
  });

  it('does not write a cooldown marker after notification failure and allows retry', async () => {
    const { env, put } = makeEnv();
    const query = async () => ({ running: 1500, provisioning: 0, stopping: 0 });
    const notify = vi.fn(async (_alert: AlertPayload) => {});
    notify.mockRejectedValueOnce(new Error('Slack unavailable'));
    await expect(evaluateContainerAllocations(env, query, notify)).rejects.toThrow(
      'Slack unavailable'
    );
    expect(put).not.toHaveBeenCalled();
    await evaluateContainerAllocations(env, query, notify);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe('buildSlackMessage for container allocations', () => {
  it('shows actual allocations, operational threshold, and state breakdown without invented utilization or max', () => {
    const message = buildSlackMessage({
      alertType: 'container_capacity',
      severity: 'page',
      provider: 'cloudflare',
      model: NATIVE_CONTAINER_APP,
      clientName: 'containers',
      allocatedInstances: 1512,
      thresholdCount: 1500,
      counts: { running: 1400, provisioning: 100, stopping: 12 },
    }) as { blocks: { text?: { text: string }; fields?: { text: string }[] }[] };
    const text = message.blocks
      .flatMap(block => [block.text?.text ?? '', ...(block.fields?.map(field => field.text) ?? [])])
      .join('\n');
    expect(text).toContain('PAGE');
    expect(text).toContain(application.name);
    expect(text).toContain('*Allocated containers:*\n1512');
    expect(text).toContain('*Alert threshold:*\n1500 containers');
    expect(text).toContain('*Running:*\n1400');
    expect(text).toContain('Provisioning: 100');
    expect(text).toContain('Stopping: 12');
    expect(text).toContain('Threshold is operational, not a Cloudflare limit.');
    expect(text).not.toMatch(/utilization|maximum|max_instances|\bmax\b|%|1512\s*\//i);
  });
});
