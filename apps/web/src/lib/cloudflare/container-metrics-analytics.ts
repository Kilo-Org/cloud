import 'server-only';

import * as z from 'zod';

import { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ANALYTICS_API_TOKEN } from '@/lib/config.server';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const DATASET = 'containersMetricsAdaptiveGroups' as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_WINDOWS = 20;
const MAX_WINDOWS_PER_REQUEST = 10;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type ContainerMetricsWindow = {
  key: string;
  instanceId: string;
  start: string;
  end: string;
};

export type ContainerMetricsRow = {
  windowKey: string;
  timestamp: string;
  applicationId: string;
  instanceId: string;
  placementId: string;
  location: string | null;
  region: string | null;
  avg: {
    cpuUtilization: number | null;
    memory: number | null;
    rxBandwidthBps: number | null;
    txBandwidthBps: number | null;
    containerUptime: number | null;
  };
  max: {
    memory: number | null;
    diskUsage: number | null;
    diskUsagePercentage: number | null;
  };
  quantiles: {
    cpuUtilizationP95: number | null;
    memoryP95: number | null;
  };
  sum: {
    cpuTimeSec: number | null;
    rxBytes: number | null;
    txBytes: number | null;
  };
};

export type ContainerMetricsResult = {
  rows: ContainerMetricsRow[];
  partial: boolean;
  issues: string[];
};

export type ContainerMetricsAnalyticsOptions = {
  fetch?: typeof fetch;
  accountId?: string;
  apiToken?: string;
  timeoutMs?: number;
  now?: () => Date;
};

export class ContainerMetricsAnalyticsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContainerMetricsAnalyticsError';
    this.code = code;
  }
}

const DatasetSettingsSchema = z.object({
  enabled: z.boolean(),
  availableFields: z.array(z.string()),
  maxPageSize: z.number().int().positive(),
  maxNumberOfFields: z.number().int().positive(),
  notOlderThan: z.number().int().nonnegative(),
  maxDuration: z.number().int().positive(),
});

const GraphqlErrorsSchema = z
  .array(
    z
      .object({
        message: z.string().optional(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      })
      .passthrough()
  )
  .nullish();

const SettingsResponseSchema = z.object({
  data: z
    .object({
      viewer: z
        .object({
          accounts: z
            .array(
              z.object({
                settings: z
                  .object({ containersMetricsAdaptiveGroups: DatasetSettingsSchema.optional() })
                  .optional(),
              })
            )
            .optional(),
        })
        .optional(),
    })
    .nullish(),
  errors: GraphqlErrorsSchema,
});

const NullableNumber = z.number().nullable();
const MetricsGroupSchema = z.object({
  dimensions: z.object({
    datetimeMinute: z.string(),
    applicationId: z.string(),
    instanceId: z.string(),
    placementId: z.string(),
    location: z.string().nullable(),
    region: z.string().nullable(),
  }),
  avg: z.object({
    cpuUtilization: NullableNumber,
    memory: NullableNumber,
    rxBandwidthBps: NullableNumber,
    txBandwidthBps: NullableNumber,
    containerUptime: NullableNumber,
  }),
  max: z.object({
    memory: NullableNumber,
    diskUsage: NullableNumber,
    diskUsagePercentage: NullableNumber,
  }),
  quantiles: z.object({
    cpuUtilizationP95: NullableNumber,
    memoryP95: NullableNumber,
  }),
  sum: z.object({
    cpuTimeSec: NullableNumber,
    rxBytes: NullableNumber,
    txBytes: NullableNumber,
  }),
});

const MetricsResponseSchema = z.object({
  data: z
    .object({
      viewer: z
        .object({ accounts: z.array(z.record(z.string(), z.array(MetricsGroupSchema).nullable())) })
        .optional(),
    })
    .nullish(),
  errors: GraphqlErrorsSchema,
});

const SETTINGS_QUERY = `
query ContainerMetricsSettings($accountTag: String!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      settings {
        containersMetricsAdaptiveGroups {
          enabled
          availableFields
          maxPageSize
          maxNumberOfFields
          notOlderThan
          maxDuration
        }
      }
    }
  }
}`;

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

type QueryPlan = ContainerMetricsWindow & { part: number };

function metricsQuery(limit: number, plans: QueryPlan[]): string {
  const variables = plans
    .map(
      (_plan, index) =>
        `$datetimeStart${index}: Time!\n  $datetimeEnd${index}: Time!\n  $instanceIds${index}: [String!]`
    )
    .join('\n  ');
  const fields = plans
    .map(
      (_plan, index) => `
      m${index}: containersMetricsAdaptiveGroups(
        limit: ${limit}
        filter: {
          datetime_geq: $datetimeStart${index}
          datetime_lt: $datetimeEnd${index}
          instanceId_in: $instanceIds${index}
        }
        orderBy: [datetimeMinute_ASC]
      ) {
        dimensions { datetimeMinute applicationId instanceId placementId location region }
        avg { cpuUtilization memory rxBandwidthBps txBandwidthBps containerUptime }
        max { memory diskUsage diskUsagePercentage }
        quantiles { cpuUtilizationP95 memoryP95 }
        sum { cpuTimeSec rxBytes txBytes }
      }`
    )
    .join('\n');
  return `
query ContainerMetrics(
  $accountTag: String!
  ${variables}
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      ${fields}
    }
  }
}`;
}

function parseTime(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ContainerMetricsAnalyticsError('invalid_input', `${field} must be an ISO datetime.`);
  }
  return parsed;
}

function errorMessages(errors: z.infer<typeof GraphqlErrorsSchema>): string[] {
  return (errors ?? []).map(error => error.message ?? 'Unknown GraphQL error');
}

async function postGraphql(args: {
  fetchImpl: typeof fetch;
  token: string;
  timeoutMs: number;
  query: string;
  variables: Record<string, unknown>;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await args.fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${args.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: args.query, variables: args.variables }),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    throw new ContainerMetricsAnalyticsError(
      timedOut ? 'timeout' : 'network_error',
      timedOut
        ? `Cloudflare Analytics request timed out after ${args.timeoutMs}ms.`
        : 'Cloudflare Analytics request failed before receiving a response.'
    );
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new ContainerMetricsAnalyticsError(
      'response_too_large',
      'Cloudflare Analytics response exceeded the safety limit.'
    );
  }
  if (!response.ok) {
    throw new ContainerMetricsAnalyticsError(
      'http_error',
      `Cloudflare Analytics returned HTTP ${response.status}. Verify the token scope and retry.`
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ContainerMetricsAnalyticsError(
      'invalid_json',
      'Cloudflare Analytics returned a non-JSON response.'
    );
  }
}

function splitWindow(
  window: ContainerMetricsWindow,
  startMs: number,
  endMs: number,
  maxDurationSeconds: number
): QueryPlan[] {
  const plans: QueryPlan[] = [];
  const durationMs = maxDurationSeconds * 1_000;
  let part = 0;
  for (let cursor = startMs; cursor < endMs; cursor += durationMs) {
    plans.push({
      ...window,
      start: new Date(cursor).toISOString(),
      end: new Date(Math.min(cursor + durationMs, endMs)).toISOString(),
      part,
    });
    part += 1;
  }
  return plans;
}

export async function queryContainerMetricsAnalytics(
  input: { windows: ContainerMetricsWindow[] },
  options: ContainerMetricsAnalyticsOptions = {}
): Promise<ContainerMetricsResult> {
  const accountId = options.accountId ?? CLOUDFLARE_ACCOUNT_ID;
  const token = options.apiToken ?? CLOUDFLARE_ANALYTICS_API_TOKEN;
  if (!accountId || !token) {
    throw new ContainerMetricsAnalyticsError(
      'missing_config',
      'Cloudflare container metrics are not configured for the web app.'
    );
  }
  if (input.windows.length > MAX_WINDOWS) {
    throw new ContainerMetricsAnalyticsError(
      'request_limit_exceeded',
      `At most ${MAX_WINDOWS} container metric windows may be queried at once.`
    );
  }
  const keys = new Set<string>();
  for (const window of input.windows) {
    if (!window.key || !window.instanceId || keys.has(window.key)) {
      throw new ContainerMetricsAnalyticsError(
        'invalid_input',
        'Container metric windows require unique keys and instance IDs.'
      );
    }
    keys.add(window.key);
    if (
      parseTime(window.end, `end for ${window.key}`) <=
      parseTime(window.start, `start for ${window.key}`)
    ) {
      throw new ContainerMetricsAnalyticsError(
        'invalid_input',
        `end must be after start for ${window.key}.`
      );
    }
  }

  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settingsBody = await postGraphql({
    fetchImpl,
    token,
    timeoutMs,
    query: SETTINGS_QUERY,
    variables: { accountTag: accountId },
  });
  const settingsResponse = SettingsResponseSchema.safeParse(settingsBody);
  if (!settingsResponse.success) {
    throw new ContainerMetricsAnalyticsError(
      'invalid_response_shape',
      'Cloudflare Analytics settings response had an unexpected shape.'
    );
  }
  const settingsErrors = errorMessages(settingsResponse.data.errors);
  const settings =
    settingsResponse.data.data?.viewer?.accounts?.[0]?.settings?.containersMetricsAdaptiveGroups;
  if (!settings || !settings.enabled) {
    throw new ContainerMetricsAnalyticsError(
      'dataset_unavailable',
      settingsErrors[0] ?? `Cloudflare Analytics dataset ${DATASET} is unavailable.`
    );
  }
  const missingFields = REQUIRED_FIELDS.filter(field => !settings.availableFields.includes(field));
  if (missingFields.length > 0 || settings.maxNumberOfFields < REQUIRED_FIELDS.length) {
    throw new ContainerMetricsAnalyticsError(
      'fields_unavailable',
      `Cloudflare Analytics dataset ${DATASET} is missing required workload fields.`
    );
  }

  const issues = [...settingsErrors];
  let partial = settingsErrors.length > 0;
  const oldestAllowed =
    (options.now ?? (() => new Date()))().getTime() - settings.notOlderThan * 1_000;
  const plans = input.windows.flatMap(window => {
    const start = parseTime(window.start, `start for ${window.key}`);
    const end = parseTime(window.end, `end for ${window.key}`);
    if (end <= oldestAllowed) {
      partial = true;
      issues.push(`Container metrics for ${window.key} are outside Cloudflare retention.`);
      return [];
    }
    const retainedStart = Math.max(start, oldestAllowed);
    if (retainedStart !== start) {
      partial = true;
      issues.push(
        `Container metrics for ${window.key} are partially outside Cloudflare retention.`
      );
    }
    return splitWindow(window, retainedStart, end, settings.maxDuration);
  });
  if (plans.length > MAX_WINDOWS) {
    throw new ContainerMetricsAnalyticsError(
      'request_limit_exceeded',
      `The requested time range requires more than ${MAX_WINDOWS} Cloudflare metric windows.`
    );
  }

  const rows: ContainerMetricsRow[] = [];
  for (let batchStart = 0; batchStart < plans.length; batchStart += MAX_WINDOWS_PER_REQUEST) {
    const batch = plans.slice(batchStart, batchStart + MAX_WINDOWS_PER_REQUEST);
    const variables: Record<string, unknown> = { accountTag: accountId };
    for (const [index, plan] of batch.entries()) {
      variables[`datetimeStart${index}`] = plan.start;
      variables[`datetimeEnd${index}`] = plan.end;
      variables[`instanceIds${index}`] = [plan.instanceId];
    }
    const body = await postGraphql({
      fetchImpl,
      token,
      timeoutMs,
      query: metricsQuery(settings.maxPageSize, batch),
      variables,
    });
    const response = MetricsResponseSchema.safeParse(body);
    if (!response.success) {
      throw new ContainerMetricsAnalyticsError(
        'invalid_response_shape',
        'Cloudflare Analytics metrics response had an unexpected shape.'
      );
    }
    const account = response.data.data?.viewer?.accounts?.[0];
    const errors = response.data.errors ?? [];
    const unscopedErrors = errors.filter(
      error => !error.path?.some(part => /^m\d+$/.test(String(part)))
    );
    if (unscopedErrors.length > 0 && batch.length > 1) {
      throw new ContainerMetricsAnalyticsError(
        'graphql_error',
        `Cloudflare Analytics returned an unscoped batch error: ${errorMessages(unscopedErrors).join('; ')}`
      );
    }
    if (!account) {
      throw new ContainerMetricsAnalyticsError(
        'graphql_error',
        errorMessages(errors)[0] ?? 'Cloudflare Analytics metrics query returned no account data.'
      );
    }
    for (const [index, plan] of batch.entries()) {
      const alias = `m${index}`;
      const aliasErrors = errors.filter(
        error => error.path?.includes(alias) || error.path === undefined
      );
      const groups = account[alias];
      if (!groups) {
        if (aliasErrors.length === 0) {
          throw new ContainerMetricsAnalyticsError(
            'invalid_response_shape',
            `Cloudflare Analytics metrics response omitted ${alias}.`
          );
        }
        partial = true;
        issues.push(...errorMessages(aliasErrors));
        continue;
      }
      if (aliasErrors.length > 0 || groups.length >= settings.maxPageSize) {
        partial = true;
        issues.push(
          ...(aliasErrors.length > 0
            ? errorMessages(aliasErrors)
            : [`Container metric window ${plan.key} reached the Cloudflare page limit.`])
        );
      }
      rows.push(
        ...groups.map(group => ({
          windowKey: plan.key,
          timestamp: new Date(group.dimensions.datetimeMinute).toISOString(),
          applicationId: group.dimensions.applicationId,
          instanceId: group.dimensions.instanceId,
          placementId: group.dimensions.placementId,
          location: group.dimensions.location,
          region: group.dimensions.region,
          avg: group.avg,
          max: group.max,
          quantiles: group.quantiles,
          sum: group.sum,
        }))
      );
    }
  }

  rows.sort(
    (left, right) =>
      left.timestamp.localeCompare(right.timestamp) || left.windowKey.localeCompare(right.windowKey)
  );
  return { rows, partial, issues };
}
