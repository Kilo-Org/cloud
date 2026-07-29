import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@/lib/config.server', () => ({
  CLOUDFLARE_ACCOUNT_ID: '',
  CLOUDFLARE_ANALYTICS_API_TOKEN: '',
}));

import {
  queryContainerUsageAnalytics,
  type ContainerUsageAnalyticsOptions,
} from './container-usage-analytics';

const ACCOUNT_ID = 'account-id';
const API_TOKEN = 'analytics-token';
const USAGE_FIELDS = [
  'dimensions_applicationId',
  'dimensions_instanceId',
  'sum_cpuTimeSec',
  'sum_allocatedMemory',
  'sum_allocatedDisk',
  'sum_txBytes',
];
const input = {
  instanceIds: ['instance-1'],
  start: '2026-07-01T00:00:00.000Z',
  end: '2026-07-01T01:00:00.000Z',
};
const options: ContainerUsageAnalyticsOptions = {
  accountId: ACCOUNT_ID,
  apiToken: API_TOKEN,
  now: () => new Date('2026-07-02T00:00:00.000Z'),
};

function settingsBody(
  overrides: Partial<{
    enabled: boolean;
    availableFields: string[];
    maxPageSize: number;
    maxNumberOfFields: number;
    notOlderThan: number;
    maxDuration: number;
  }> = {},
  extra: Record<string, unknown> = {}
) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            settings: {
              containersUsageAdaptiveGroups: {
                enabled: true,
                availableFields: USAGE_FIELDS,
                maxPageSize: 100,
                maxNumberOfFields: 30,
                notOlderThan: 2_678_400,
                maxDuration: 86_400,
                ...overrides,
              },
            },
          },
        ],
      },
    },
    errors: null,
    ...extra,
  };
}

function usageBody(
  groups: Array<{
    dimensions: { applicationId: string; instanceId: string };
    sum: { cpuTimeSec: number; allocatedMemory: number; allocatedDisk: number; txBytes: number };
  }> = [],
  errors: Array<{ message: string }> | null = null,
  extra: Record<string, unknown> = {}
) {
  return {
    data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: groups }] } },
    errors,
    ...extra,
  };
}

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function requestCapture(
  handler: (request: { body: Record<string, any>; headers: Headers }, index: number) => Response
) {
  const requests: Array<{ body: Record<string, any>; headers: Headers }> = [];
  const fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = {
      body: JSON.parse(String(init?.body)) as Record<string, any>,
      headers: new Headers(init?.headers),
    };
    requests.push(request);
    return handler(request, requests.length - 1);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe('queryContainerUsageAnalytics', () => {
  it('sends the scoped billing-usage query and returns labeled raw data without auth material', async () => {
    const providerRow = {
      dimensions: { applicationId: 'observed-app', instanceId: 'instance-1' },
      sum: { cpuTimeSec: 2, allocatedMemory: 3, allocatedDisk: 4, txBytes: 5 },
    };
    const { fetch, requests } = requestCapture((_request, index) =>
      response(index === 0 ? settingsBody() : usageBody([providerRow]))
    );

    const result = await queryContainerUsageAnalytics(input, { ...options, fetch });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requests[0]?.body.variables).toEqual({ accountTag: ACCOUNT_ID });
    expect(requests[1]?.headers.get('authorization')).toBe(`Bearer ${API_TOKEN}`);
    expect(requests[1]?.body.query).toContain('datetime_lt: $datetimeEnd');
    expect(requests[1]?.body.query).toContain('instanceId_in: $instanceIds');
    expect(requests[1]?.body.variables).toEqual({
      accountTag: ACCOUNT_ID,
      datetimeStart: input.start,
      datetimeEnd: input.end,
      instanceIds: ['instance-1'],
    });
    expect(result.rows).toEqual([
      {
        applicationId: 'observed-app',
        instanceId: 'instance-1',
        hasUsage: true,
        usage: providerRow.sum,
      },
    ]);
    expect(result.rawResponses.map(item => item.dataset)).toEqual([
      'settings',
      'containersUsageAdaptiveGroups',
    ]);
    expect(JSON.stringify(result)).not.toContain(API_TOKEN);
    expect(JSON.stringify(result)).not.toContain('authorization');
  });

  it.each([
    ['HTTP failure', () => response({ error: 'denied' }, { status: 403 }), 'http_error'],
    ['invalid JSON', () => response('<html>bad gateway</html>'), 'invalid_json'],
  ])('rejects %s safely', async (_name, failingResponse, code) => {
    const fetch = jest.fn(async () => failingResponse()) as typeof globalThis.fetch;
    await expect(queryContainerUsageAnalytics(input, { ...options, fetch })).rejects.toMatchObject({
      code,
    });
  });

  it('distinguishes GraphQL failure from usable partial data', async () => {
    const hardFailure = requestCapture((_request, index) =>
      response(index === 0 ? settingsBody() : { data: null, errors: [{ message: 'denied' }] })
    );
    await expect(
      queryContainerUsageAnalytics(input, { ...options, fetch: hardFailure.fetch })
    ).rejects.toMatchObject({ code: 'graphql_error' });

    const partial = requestCapture((_request, index) =>
      response(
        index === 0
          ? settingsBody()
          : usageBody(
              [
                {
                  dimensions: { applicationId: 'app', instanceId: 'instance-1' },
                  sum: { cpuTimeSec: 1, allocatedMemory: 2, allocatedDisk: 3, txBytes: 4 },
                },
              ],
              [{ message: 'partial failure' }]
            )
      )
    );
    const result = await queryContainerUsageAnalytics(input, { ...options, fetch: partial.fetch });
    expect(result.partial).toBe(true);
    expect(result.usagePartialInstanceIds).toEqual(['instance-1']);
    expect(result.rows).toHaveLength(1);
  });

  it('fails safely for missing configuration, account, dataset, and fields', async () => {
    await expect(
      queryContainerUsageAnalytics(input, { accountId: '', apiToken: '' })
    ).rejects.toMatchObject({
      code: 'missing_config',
    });
    await expect(
      queryContainerUsageAnalytics(input, { accountId: ACCOUNT_ID, apiToken: '' })
    ).rejects.toMatchObject({ code: 'missing_config' });

    const cases: Array<[unknown, string]> = [
      [{ data: { viewer: { accounts: [] } }, errors: null }, 'account_not_found'],
      [{ data: { viewer: { accounts: [{ settings: {} }] } }, errors: null }, 'dataset_unavailable'],
      [settingsBody({ enabled: false }), 'dataset_disabled'],
      [settingsBody({ availableFields: USAGE_FIELDS.slice(0, -1) }), 'fields_unavailable'],
      [settingsBody({ maxPageSize: 1 }), 'dataset_unavailable'],
    ];
    for (const [body, code] of cases) {
      const fetch = jest.fn(async () => response(body)) as typeof globalThis.fetch;
      await expect(
        queryContainerUsageAnalytics(input, { ...options, fetch })
      ).rejects.toMatchObject({ code });
    }
  });

  it('chunks by live duration and batches exact IDs below the page limit', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `instance-${index}`);
    const { fetch, requests } = requestCapture((_request, index) =>
      response(index === 0 ? settingsBody({ maxDuration: 3_600, maxPageSize: 100 }) : usageBody())
    );

    await queryContainerUsageAnalytics(
      { instanceIds: ids, start: input.start, end: '2026-07-01T02:00:00.000Z' },
      { ...options, fetch }
    );

    expect(fetch).toHaveBeenCalledTimes(5);
    const queries = requests.slice(1);
    expect(new Set(queries.map(item => item.body.variables.instanceIds.length))).toEqual(
      new Set([1, 50])
    );
    expect(new Set(queries.map(item => item.body.variables.datetimeStart))).toEqual(
      new Set(['2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z'])
    );
  });

  it('marks a full page partial and rejects request plans above the cap', async () => {
    const fullPage = requestCapture((_request, index) =>
      response(
        index === 0
          ? settingsBody({ maxPageSize: 2 })
          : usageBody([
              {
                dimensions: { applicationId: 'app-a', instanceId: 'instance-1' },
                sum: { cpuTimeSec: 1, allocatedMemory: 2, allocatedDisk: 3, txBytes: 4 },
              },
              {
                dimensions: { applicationId: 'app-b', instanceId: 'instance-1' },
                sum: { cpuTimeSec: 1, allocatedMemory: 2, allocatedDisk: 3, txBytes: 4 },
              },
            ])
      )
    );
    const partial = await queryContainerUsageAnalytics(input, {
      ...options,
      fetch: fullPage.fetch,
    });
    expect(partial.usagePartialInstanceIds).toEqual(['instance-1']);

    const requestCap = requestCapture((_request, index) =>
      response(index === 0 ? settingsBody({ maxPageSize: 2, maxDuration: 3_600 }) : usageBody())
    );
    await expect(
      queryContainerUsageAnalytics(
        {
          instanceIds: Array.from({ length: 50 }, (_, index) => `instance-${index}`),
          start: input.start,
          end: '2026-07-02T00:00:00.000Z',
        },
        { ...options, fetch: requestCap.fetch }
      )
    ).rejects.toMatchObject({ code: 'request_limit_exceeded' });
  });

  it('enforces timeout and raw response caps', async () => {
    const timeoutFetch = jest.fn(async () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    }) as typeof globalThis.fetch;
    await expect(
      queryContainerUsageAnalytics(input, { ...options, fetch: timeoutFetch, timeoutMs: 5 })
    ).rejects.toMatchObject({ code: 'timeout' });

    const oversized = jest.fn(async () =>
      response('x'.repeat(1024 * 1024 + 1))
    ) as typeof globalThis.fetch;
    await expect(
      queryContainerUsageAnalytics(input, { ...options, fetch: oversized })
    ).rejects.toMatchObject({
      code: 'raw_response_too_large',
    });
  });

  it('rejects missing billing sums instead of converting them to zero', async () => {
    const { fetch } = requestCapture((_request, index) =>
      response(
        index === 0
          ? settingsBody()
          : {
              data: {
                viewer: {
                  accounts: [
                    {
                      containersUsageAdaptiveGroups: [
                        {
                          dimensions: { applicationId: 'app', instanceId: 'instance-1' },
                          sum: { cpuTimeSec: 1, allocatedMemory: 2, txBytes: 3 },
                        },
                      ],
                    },
                  ],
                },
              },
              errors: null,
            }
      )
    );
    await expect(queryContainerUsageAnalytics(input, { ...options, fetch })).rejects.toMatchObject({
      code: 'invalid_response_shape',
    });
  });

  it('marks retention clipping partial and rejects fully expired windows', async () => {
    const retained = requestCapture((_request, index) =>
      response(index === 0 ? settingsBody({ notOlderThan: 84_600 }) : usageBody())
    );
    const partial = await queryContainerUsageAnalytics(input, {
      ...options,
      fetch: retained.fetch,
    });
    expect(partial.partial).toBe(true);
    expect(partial.usagePartialInstanceIds).toEqual(['instance-1']);

    const expired = requestCapture(() => response(settingsBody({ notOlderThan: 3_600 })));
    await expect(
      queryContainerUsageAnalytics(input, { ...options, fetch: expired.fetch })
    ).rejects.toMatchObject({ code: 'outside_retention' });
  });
});
