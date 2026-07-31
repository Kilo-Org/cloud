import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@/lib/config.server', () => ({
  CLOUDFLARE_ACCOUNT_ID: '',
  CLOUDFLARE_ANALYTICS_API_TOKEN: '',
}));

import { queryContainerMetricsAnalytics } from './container-metrics-analytics';

const REQUIRED_FIELDS = [
  'dimensions_datetimeMinute',
  'dimensions_applicationId',
  'dimensions_instanceId',
  'dimensions_placementId',
  'dimensions_location',
  'dimensions_region',
  'avg_cpuUtilization',
  'avg_memory',
  'avg_rxBandwidthBps',
  'avg_txBandwidthBps',
  'avg_containerUptime',
  'max_memory',
  'max_diskUsage',
  'max_diskUsagePercentage',
  'quantiles_cpuUtilizationP95',
  'quantiles_memoryP95',
  'sum_cpuTimeSec',
  'sum_rxBytes',
  'sum_txBytes',
];

const input = {
  windows: [
    {
      key: 'interval-1',
      instanceId: 'durable-object-id',
      start: '2026-07-31T08:43:00.000Z',
      end: '2026-07-31T08:51:00.000Z',
    },
  ],
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function settingsBody(availableFields = REQUIRED_FIELDS) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            settings: {
              containersMetricsAdaptiveGroups: {
                enabled: true,
                availableFields,
                maxPageSize: 1_000,
                maxNumberOfFields: 30,
                notOlderThan: 2_678_400,
                maxDuration: 86_400,
              },
            },
          },
        ],
      },
    },
    errors: null,
  };
}

describe('queryContainerMetricsAnalytics', () => {
  it('queries workload metrics by Durable Object ID and normalizes minute samples', async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      requests.push(body);
      if (requests.length === 1) return response(settingsBody());
      return response({
        data: {
          viewer: {
            accounts: [
              {
                m0: [
                  {
                    dimensions: {
                      datetimeMinute: '2026-07-31T08:49:00.000Z',
                      applicationId: 'application-id',
                      instanceId: 'durable-object-id',
                      placementId: 'placement-id',
                      location: 'ord02',
                      region: 'WNAM',
                    },
                    avg: {
                      cpuUtilization: 0.72,
                      memory: 4_000,
                      rxBandwidthBps: 10,
                      txBandwidthBps: 20,
                      containerUptime: 300,
                    },
                    max: { memory: 5_000, diskUsage: 6_000, diskUsagePercentage: 12 },
                    quantiles: { cpuUtilizationP95: 0.9, memoryP95: 4_800 },
                    sum: { cpuTimeSec: 30, rxBytes: 100, txBytes: 200 },
                  },
                ],
              },
            ],
          },
        },
        errors: null,
      });
    }) as typeof globalThis.fetch;

    const result = await queryContainerMetricsAnalytics(input, {
      fetch,
      accountId: 'account-id',
      apiToken: 'analytics-token',
      now: () => new Date('2026-08-01T00:00:00.000Z'),
    });

    expect(requests[1]?.query).toContain('containersMetricsAdaptiveGroups');
    expect(requests[1]?.query).toContain('orderBy: [datetimeMinute_ASC]');
    expect(requests[1]?.variables).toEqual({
      accountTag: 'account-id',
      datetimeStart0: input.windows[0]?.start,
      datetimeEnd0: input.windows[0]?.end,
      instanceIds0: ['durable-object-id'],
    });
    expect(result).toEqual({
      partial: false,
      issues: [],
      rows: [
        expect.objectContaining({
          windowKey: 'interval-1',
          timestamp: '2026-07-31T08:49:00.000Z',
          instanceId: 'durable-object-id',
          placementId: 'placement-id',
          max: expect.objectContaining({ memory: 5_000 }),
        }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain('analytics-token');
  });

  it('fails before the workload query when required fields are unavailable', async () => {
    const fetch = jest.fn(async () =>
      response(settingsBody(REQUIRED_FIELDS.slice(1)))
    ) as typeof globalThis.fetch;

    await expect(
      queryContainerMetricsAnalytics(input, {
        fetch,
        accountId: 'account-id',
        apiToken: 'analytics-token',
      })
    ).rejects.toMatchObject({ code: 'fields_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
