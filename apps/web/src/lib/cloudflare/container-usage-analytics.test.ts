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
  runs: [
    {
      key: 'run-1',
      instanceId: 'instance-1',
      start: '2026-07-01T00:00:00.000Z',
      end: '2026-07-01T01:00:00.000Z',
    },
  ],
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

type UsageGroup = {
  dimensions: { applicationId: string; instanceId: string };
  sum: { cpuTimeSec: number; allocatedMemory: number; allocatedDisk: number; txBytes: number };
};

function usageBody(
  groups: UsageGroup[] = [],
  errors: Array<{ message: string }> | null = null,
  extra: Record<string, unknown> = {}
) {
  return {
    data: { viewer: { accounts: [{ u0: groups }] } },
    errors,
    ...extra,
  };
}

function usageBatchBody(
  aliases: Record<string, UsageGroup[]>,
  errors: Array<{ message: string; path?: Array<string | number> }> | null = null
) {
  return { data: { viewer: { accounts: [aliases] } }, errors };
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
    expect(requests[1]?.body.query).toContain('u0: containersUsageAdaptiveGroups');
    expect(requests[1]?.body.query).toContain('datetime_lt: $datetimeEnd0');
    expect(requests[1]?.body.query).toContain('instanceId_in: $instanceIds0');
    expect(requests[1]?.body.variables).toEqual({
      accountTag: ACCOUNT_ID,
      datetimeStart0: input.runs[0]?.start,
      datetimeEnd0: input.runs[0]?.end,
      instanceIds0: ['instance-1'],
    });
    expect(result.rows).toEqual([
      {
        runKey: 'run-1',
        applicationId: 'observed-app',
        instanceId: 'instance-1',
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

  it('keeps reused instance IDs isolated by alias and marks only the errored run partial', async () => {
    const runs = [
      input.runs[0]!,
      {
        key: 'run-2',
        instanceId: 'instance-1',
        start: '2026-07-01T02:00:00.000Z',
        end: '2026-07-01T03:00:00.000Z',
      },
    ];
    const { fetch } = requestCapture((_request, index) =>
      response(
        index === 0
          ? settingsBody()
          : usageBatchBody(
              {
                u0: [
                  {
                    dimensions: { applicationId: 'app', instanceId: 'instance-1' },
                    sum: { cpuTimeSec: 1, allocatedMemory: 10, allocatedDisk: 20, txBytes: 30 },
                  },
                ],
                u1: [
                  {
                    dimensions: { applicationId: 'app', instanceId: 'instance-1' },
                    sum: { cpuTimeSec: 2, allocatedMemory: 100, allocatedDisk: 200, txBytes: 300 },
                  },
                ],
              },
              [{ message: 'run 2 partial', path: ['ContainerUsage', 'u1'] }]
            )
      )
    );

    const result = await queryContainerUsageAnalytics({ runs }, { ...options, fetch });

    expect(result.rows).toEqual([
      expect.objectContaining({
        runKey: 'run-1',
        usage: expect.objectContaining({ allocatedMemory: 10 }),
      }),
      expect.objectContaining({
        runKey: 'run-2',
        usage: expect.objectContaining({ allocatedMemory: 100 }),
      }),
    ]);
    expect(result.usagePartialRunKeys).toEqual(['run-2']);
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
    expect(result.usagePartialRunKeys).toEqual(['run-1']);
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

  it('batches up to 15 independently filtered run windows per usage request', async () => {
    const runs = Array.from({ length: 16 }, (_, index) => ({
      key: index === 0 ? 'interval:with:colons' : `run-${index}`,
      instanceId: `instance-${index}`,
      start: '2026-07-01T00:00:00.000Z',
      end: '2026-07-01T01:00:00.000Z',
    }));
    const { fetch, requests } = requestCapture((_request, index) =>
      response(
        index === 0
          ? settingsBody({ maxDuration: 3_600, maxPageSize: 100 })
          : usageBatchBody(
              Object.fromEntries(
                Array.from({ length: index === 1 ? 15 : 1 }, (_, aliasIndex) => [
                  `u${aliasIndex}`,
                  [],
                ])
              )
            )
      )
    );

    const result = await queryContainerUsageAnalytics({ runs }, { ...options, fetch });

    expect(fetch).toHaveBeenCalledTimes(3);
    const queries = requests.slice(1);
    expect(queries[0]?.body.variables.instanceIds14).toEqual(['instance-14']);
    expect(queries[1]?.body.variables.instanceIds0).toEqual(['instance-15']);
    expect(queries[0]?.body.query).not.toContain('interval:with:colons');
    expect(result.rawResponses).toHaveLength(3);
    expect(result.rawResponses[1]?.queries).toHaveLength(15);
    expect(result.rawResponses[1]?.queries[0]?.runKey).toBe('interval:with:colons');
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
    expect(partial.usagePartialRunKeys).toEqual(['run-1']);

    const requestCap = requestCapture((_request, index) =>
      response(index === 0 ? settingsBody({ maxPageSize: 2, maxDuration: 3_600 }) : usageBody())
    );
    await expect(
      queryContainerUsageAnalytics(
        {
          runs: Array.from({ length: 5 }, (_, index) => ({
            key: `run-${index}`,
            instanceId: `instance-${index}`,
            start: '2026-07-01T00:00:00.000Z',
            end: '2026-07-02T00:00:00.000Z',
          })),
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
                      u0: [
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

  it('marks retention clipping partial and skips fully expired runs without blocking valid runs', async () => {
    const retained = requestCapture((_request, index) =>
      response(index === 0 ? settingsBody({ notOlderThan: 84_600 }) : usageBody())
    );
    const partial = await queryContainerUsageAnalytics(input, {
      ...options,
      fetch: retained.fetch,
    });
    expect(partial.partial).toBe(true);
    expect(partial.usagePartialRunKeys).toEqual(['run-1']);

    const validProviderRow = {
      dimensions: { applicationId: 'app', instanceId: 'instance-2' },
      sum: { cpuTimeSec: 1, allocatedMemory: 2, allocatedDisk: 3, txBytes: 4 },
    };
    const expired = requestCapture((_request, index) =>
      response(index === 0 ? settingsBody({ notOlderThan: 3_600 }) : usageBody([validProviderRow]))
    );
    const result = await queryContainerUsageAnalytics(
      {
        runs: [
          input.runs[0]!,
          {
            key: 'valid-run',
            instanceId: 'instance-2',
            start: '2026-07-01T23:30:00.000Z',
            end: '2026-07-01T23:45:00.000Z',
          },
        ],
      },
      { ...options, fetch: expired.fetch }
    );
    expect(expired.fetch).toHaveBeenCalledTimes(2);
    expect(result.usageUnavailableRuns).toEqual([{ runKey: 'run-1', reason: 'outside_retention' }]);
    expect(result.rows).toEqual([
      expect.objectContaining({ runKey: 'valid-run', instanceId: 'instance-2' }),
    ]);
  });
});
