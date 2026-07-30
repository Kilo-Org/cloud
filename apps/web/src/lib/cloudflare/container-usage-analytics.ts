import 'server-only';

import * as z from 'zod';

import { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ANALYTICS_API_TOKEN } from '@/lib/config.server';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const DATASET = 'containersUsageAdaptiveGroups' as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RAW_RESPONSE_BYTES = 1024 * 1024;
const MAX_RETAINED_RAW_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_QUERY_PLANS = 100;
const MAX_RUN_WINDOWS_PER_REQUEST = 15;

export type ContainerUsageAnalyticsInput = {
  runs: Array<{
    key: string;
    instanceId: string;
    start: string;
    end: string;
  }>;
};

export type ContainerUsageAnalyticsOptions = {
  fetch?: typeof fetch;
  accountId?: string;
  apiToken?: string;
  timeoutMs?: number;
  now?: () => Date;
};

export type ContainerDatasetSettings = {
  enabled: boolean;
  availableFields: string[];
  maxPageSize: number;
  maxNumberOfFields: number;
  notOlderThan: number;
  maxDuration: number;
};

export type ContainerUsageAnalyticsRawResponse = {
  dataset: typeof DATASET | 'settings';
  batchIndex: number;
  queries: Array<{
    alias: string;
    runKey: string;
    windowIndex: number;
    window: { start: string; end: string };
  }>;
  body: unknown;
};

export type ContainerUsageAnalyticsRow = {
  runKey: string;
  applicationId: string;
  instanceId: string;
  usage: {
    cpuTimeSec: number;
    allocatedMemory: number;
    allocatedDisk: number;
    txBytes: number;
  };
};

export type ContainerUsageAnalyticsResult = {
  rows: ContainerUsageAnalyticsRow[];
  partial: boolean;
  usagePartialRunKeys: string[];
  usageUnavailableRuns: Array<{ runKey: string; reason: 'outside_retention' }>;
  issues: string[];
  settings: { containersUsageAdaptiveGroups: ContainerDatasetSettings };
  rawResponses: ContainerUsageAnalyticsRawResponse[];
};

export class ContainerUsageAnalyticsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContainerUsageAnalyticsError';
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
                  .object({ containersUsageAdaptiveGroups: DatasetSettingsSchema.optional() })
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

const UsageGroupSchema = z.object({
  dimensions: z.object({ applicationId: z.string(), instanceId: z.string() }),
  sum: z.object({
    cpuTimeSec: z.number(),
    allocatedMemory: z.number(),
    allocatedDisk: z.number(),
    txBytes: z.number(),
  }),
});

const UsageResponseSchema = z.object({
  data: z
    .object({
      viewer: z
        .object({
          accounts: z
            .array(z.record(z.string(), z.array(UsageGroupSchema).nullable()).nullable())
            .optional(),
        })
        .optional(),
    })
    .nullish(),
  errors: GraphqlErrorsSchema,
});

const SETTINGS_QUERY = `
query ContainerUsageAnalyticsSettings($accountTag: String!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      settings {
        containersUsageAdaptiveGroups {
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

type QueryPlan = {
  run: { key: string; instanceId: string };
  window: { start: string; end: string };
  windowIndex: number;
};

function usageQuery(limit: number, plans: QueryPlan[]): string {
  const variableDefinitions = plans
    .map(
      (_plan, index) =>
        `$datetimeStart${index}: Time!\n  $datetimeEnd${index}: Time!\n  $instanceIds${index}: [String!]`
    )
    .join('\n  ');
  const fields = plans
    .map(
      (_plan, index) => `
      u${index}: containersUsageAdaptiveGroups(
        limit: ${limit}
        filter: {
          datetime_geq: $datetimeStart${index}
          datetime_lt: $datetimeEnd${index}
          instanceId_in: $instanceIds${index}
        }
      ) {
        dimensions { applicationId instanceId }
        sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }
      }`
    )
    .join('\n');
  return `
query ContainerUsage(
  $accountTag: String!
  ${variableDefinitions}
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      ${fields}
    }
  }
}`;
}

const REQUIRED_FIELDS = [
  'dimensions_applicationId',
  'dimensions_instanceId',
  'sum_cpuTimeSec',
  'sum_allocatedMemory',
  'sum_allocatedDisk',
  'sum_txBytes',
];

function graphqlErrors(errors: z.infer<typeof GraphqlErrorsSchema>): string[] {
  return (errors ?? []).map(error => error.message ?? 'Unknown GraphQL error');
}

function parseTime(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ContainerUsageAnalyticsError('invalid_input', `${name} must be an ISO datetime.`);
  }
  return parsed;
}

function windows(startMs: number, endMs: number, maxDurationSeconds: number) {
  const result: Array<{ start: string; end: string }> = [];
  const maxDurationMs = maxDurationSeconds * 1000;
  for (let cursor = startMs; cursor < endMs; cursor += maxDurationMs) {
    result.push({
      start: new Date(cursor).toISOString(),
      end: new Date(Math.min(cursor + maxDurationMs, endMs)).toISOString(),
    });
  }
  return result;
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function postGraphql(args: {
  fetchImpl: typeof fetch;
  token: string;
  timeoutMs: number;
  query: string;
  variables: Record<string, unknown>;
  retainedBytes: { value: number };
}): Promise<unknown> {
  // Error messages must never include the bearer token, response body, or request headers.
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
    throw new ContainerUsageAnalyticsError(
      timedOut ? 'timeout' : 'network_error',
      timedOut
        ? `Cloudflare Analytics request timed out after ${args.timeoutMs}ms.`
        : 'Cloudflare Analytics request failed before receiving a response.'
    );
  }

  const text = await response.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_RAW_RESPONSE_BYTES) {
    throw new ContainerUsageAnalyticsError(
      'raw_response_too_large',
      `Cloudflare Analytics response exceeded the ${MAX_RAW_RESPONSE_BYTES}-byte safety limit.`
    );
  }
  args.retainedBytes.value += bytes;
  if (args.retainedBytes.value > MAX_RETAINED_RAW_BYTES) {
    throw new ContainerUsageAnalyticsError(
      'raw_response_too_large',
      `Cloudflare Analytics responses exceeded the ${MAX_RETAINED_RAW_BYTES}-byte retained-data limit.`
    );
  }
  if (!response.ok) {
    throw new ContainerUsageAnalyticsError(
      'http_error',
      `Cloudflare Analytics returned HTTP ${response.status}. Verify the token scope and retry.`
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ContainerUsageAnalyticsError(
      'invalid_json',
      'Cloudflare Analytics returned a non-JSON response.'
    );
  }
}

function validateSettings(settings: ContainerDatasetSettings | undefined) {
  if (!settings) {
    throw new ContainerUsageAnalyticsError(
      'dataset_unavailable',
      `Cloudflare Analytics dataset ${DATASET} is unavailable for this account.`
    );
  }
  if (!settings.enabled) {
    throw new ContainerUsageAnalyticsError(
      'dataset_disabled',
      `Cloudflare Analytics dataset ${DATASET} is disabled for this account.`
    );
  }
  if (settings.maxPageSize < 2) {
    throw new ContainerUsageAnalyticsError(
      'dataset_unavailable',
      `Cloudflare Analytics dataset ${DATASET} has maxPageSize ${settings.maxPageSize}; reconciliation requires at least 2 to detect truncation safely.`
    );
  }
  if (settings.maxNumberOfFields < REQUIRED_FIELDS.length) {
    throw new ContainerUsageAnalyticsError(
      'fields_unavailable',
      `Cloudflare Analytics dataset ${DATASET} does not allow all required fields.`
    );
  }
  const missing = REQUIRED_FIELDS.filter(field => !settings.availableFields.includes(field));
  if (missing.length > 0) {
    throw new ContainerUsageAnalyticsError(
      'fields_unavailable',
      `Cloudflare Analytics dataset ${DATASET} is missing required fields: ${missing.join(', ')}.`
    );
  }
  return settings;
}

export async function queryContainerUsageAnalytics(
  input: ContainerUsageAnalyticsInput,
  options: ContainerUsageAnalyticsOptions = {}
): Promise<ContainerUsageAnalyticsResult> {
  const accountId = options.accountId ?? CLOUDFLARE_ACCOUNT_ID;
  const token = options.apiToken ?? CLOUDFLARE_ANALYTICS_API_TOKEN;
  if (!accountId) {
    throw new ContainerUsageAnalyticsError(
      'missing_config',
      'CLOUDFLARE_ACCOUNT_ID is not configured. Set it for the web app and retry.'
    );
  }
  if (!token) {
    throw new ContainerUsageAnalyticsError(
      'missing_config',
      'CLOUDFLARE_ANALYTICS_API_TOKEN is not configured. Set an Account Analytics: Read token and retry.'
    );
  }

  const runKeys = new Set<string>();
  const runs = input.runs.map(run => {
    if (!run.key || !run.instanceId) {
      throw new ContainerUsageAnalyticsError(
        'invalid_input',
        'Each run must include a key and instance ID.'
      );
    }
    if (runKeys.has(run.key)) {
      throw new ContainerUsageAnalyticsError('invalid_input', `Duplicate run key: ${run.key}`);
    }
    runKeys.add(run.key);
    const startMs = parseTime(run.start, `start for ${run.key}`);
    const endMs = parseTime(run.end, `end for ${run.key}`);
    if (endMs <= startMs) {
      throw new ContainerUsageAnalyticsError(
        'invalid_input',
        `end must be after start for ${run.key}.`
      );
    }
    return { ...run, startMs, endMs };
  });
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retainedBytes = { value: 0 };
  const rawResponses: ContainerUsageAnalyticsRawResponse[] = [];
  const issues: string[] = [];
  const partialIds = new Set<string>();
  const unavailableRuns: ContainerUsageAnalyticsResult['usageUnavailableRuns'] = [];

  const settingsBody = await postGraphql({
    fetchImpl,
    token,
    timeoutMs,
    query: SETTINGS_QUERY,
    variables: { accountTag: accountId },
    retainedBytes,
  });
  const settingsResponse = SettingsResponseSchema.safeParse(settingsBody);
  if (!settingsResponse.success) {
    throw new ContainerUsageAnalyticsError(
      'invalid_response_shape',
      'Cloudflare Analytics settings response had an unexpected shape.'
    );
  }
  rawResponses.push({
    dataset: 'settings',
    batchIndex: 0,
    queries: [],
    body: settingsBody,
  });
  const settingsErrors = graphqlErrors(settingsResponse.data.errors);
  const account = settingsResponse.data.data?.viewer?.accounts?.[0];
  if (!account) {
    throw new ContainerUsageAnalyticsError(
      settingsErrors.length > 0 ? 'graphql_error' : 'account_not_found',
      settingsErrors.length > 0
        ? `Cloudflare Analytics settings query failed: ${settingsErrors.join('; ')}`
        : 'Cloudflare Analytics returned no account for CLOUDFLARE_ACCOUNT_ID.'
    );
  }
  const settings = validateSettings(account.settings?.containersUsageAdaptiveGroups);
  if (settingsErrors.length > 0) {
    issues.push(`Settings query reported GraphQL errors: ${settingsErrors.join('; ')}`);
    for (const run of runs) partialIds.add(run.key);
  }

  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const oldestAllowedMs = nowMs - settings.notOlderThan * 1000;
  const settingsSummary = { containersUsageAdaptiveGroups: settings };
  if (runs.length === 0) {
    return {
      rows: [],
      partial: issues.length > 0,
      usagePartialRunKeys: [],
      usageUnavailableRuns: [],
      issues,
      settings: settingsSummary,
      rawResponses,
    };
  }

  const queryPlans = runs.flatMap(run => {
    if (run.endMs <= oldestAllowedMs) {
      unavailableRuns.push({ runKey: run.key, reason: 'outside_retention' });
      issues.push(`Run ${run.key} is outside Cloudflare Analytics retention.`);
      return [];
    }
    const effectiveStartMs = Math.max(run.startMs, oldestAllowedMs);
    if (effectiveStartMs !== run.startMs) {
      issues.push(`Run ${run.key} covers only retained Cloudflare Analytics data.`);
      partialIds.add(run.key);
    }
    return windows(effectiveStartMs, run.endMs, settings.maxDuration).map(
      (window, windowIndex) => ({
        run,
        window,
        windowIndex,
      })
    );
  });
  if (queryPlans.length > MAX_PROVIDER_QUERY_PLANS) {
    throw new ContainerUsageAnalyticsError(
      'request_limit_exceeded',
      `The selected runs require ${queryPlans.length} Cloudflare Analytics query plans (max ${MAX_PROVIDER_QUERY_PLANS}). Select fewer or shorter runs and retry.`
    );
  }

  const rows = new Map<string, ContainerUsageAnalyticsRow>();
  const queryBatches = batches(queryPlans, MAX_RUN_WINDOWS_PER_REQUEST);
  for (let batchIndex = 0; batchIndex < queryBatches.length; batchIndex += 1) {
    const batch = queryBatches[batchIndex];
    if (!batch) continue;
    const variables: Record<string, unknown> = { accountTag: accountId };
    for (let index = 0; index < batch.length; index += 1) {
      const plan = batch[index];
      if (!plan) continue;
      variables[`datetimeStart${index}`] = plan.window.start;
      variables[`datetimeEnd${index}`] = plan.window.end;
      variables[`instanceIds${index}`] = [plan.run.instanceId];
    }
    const body = await postGraphql({
      fetchImpl,
      token,
      timeoutMs,
      query: usageQuery(settings.maxPageSize, batch),
      variables,
      retainedBytes,
    });
    rawResponses.push({
      dataset: DATASET,
      batchIndex: batchIndex + 1,
      queries: batch.map((plan, index) => ({
        alias: `u${index}`,
        runKey: plan.run.key,
        windowIndex: plan.windowIndex,
        window: plan.window,
      })),
      body,
    });
    const response = UsageResponseSchema.safeParse(body);
    if (!response.success) {
      throw new ContainerUsageAnalyticsError(
        'invalid_response_shape',
        'Cloudflare Analytics usage response had an unexpected shape.'
      );
    }
    const errors = graphqlErrors(response.data.errors);
    const account = response.data.data?.viewer?.accounts?.[0];
    if (!account) {
      throw new ContainerUsageAnalyticsError(
        'graphql_error',
        errors.length > 0
          ? `Cloudflare Analytics usage query failed: ${errors.join('; ')}`
          : 'Cloudflare Analytics usage query returned no account data.'
      );
    }
    const errorAliases = new Set(
      (response.data.errors ?? []).flatMap(error => {
        const alias = error.path?.find(part => typeof part === 'string' && /^u\d+$/.test(part));
        return typeof alias === 'string' ? [alias] : [];
      })
    );
    const hasUnscopedError = (response.data.errors ?? []).some(
      error => !error.path?.some(part => typeof part === 'string' && /^u\d+$/.test(part))
    );
    for (let index = 0; index < batch.length; index += 1) {
      const plan = batch[index];
      if (!plan) continue;
      const alias = `u${index}`;
      const groups = account[alias];
      const aliasPartial = hasUnscopedError || errorAliases.has(alias);
      if (groups === null || groups === undefined) {
        if (!aliasPartial) {
          throw new ContainerUsageAnalyticsError(
            'invalid_response_shape',
            `Cloudflare Analytics usage response omitted ${alias}.`
          );
        }
        partialIds.add(plan.run.key);
        issues.push(
          `${DATASET} run ${plan.run.key} window ${plan.windowIndex} returned no usable data: ${errors.join('; ')}`
        );
        continue;
      }
      if (aliasPartial || groups.length >= settings.maxPageSize) {
        partialIds.add(plan.run.key);
        issues.push(
          aliasPartial
            ? `${DATASET} run ${plan.run.key} window ${plan.windowIndex} returned partial data: ${errors.join('; ')}`
            : `${DATASET} run ${plan.run.key} window ${plan.windowIndex} reached the page limit.`
        );
      }
      for (const group of groups) {
        const key = `${plan.run.key}\0${group.dimensions.applicationId}\0${group.dimensions.instanceId}`;
        const existing = rows.get(key);
        if (existing) {
          existing.usage.cpuTimeSec += group.sum.cpuTimeSec;
          existing.usage.allocatedMemory += group.sum.allocatedMemory;
          existing.usage.allocatedDisk += group.sum.allocatedDisk;
          existing.usage.txBytes += group.sum.txBytes;
        } else {
          rows.set(key, {
            runKey: plan.run.key,
            applicationId: group.dimensions.applicationId,
            instanceId: group.dimensions.instanceId,
            usage: { ...group.sum },
          });
        }
      }
    }
  }

  return {
    rows: [...rows.values()].sort(
      (a, b) =>
        a.runKey.localeCompare(b.runKey) ||
        a.applicationId.localeCompare(b.applicationId) ||
        a.instanceId.localeCompare(b.instanceId)
    ),
    partial: partialIds.size > 0 || unavailableRuns.length > 0,
    usagePartialRunKeys: [...partialIds].sort(),
    usageUnavailableRuns: unavailableRuns.sort((a, b) => a.runKey.localeCompare(b.runKey)),
    issues,
    settings: settingsSummary,
    rawResponses,
  };
}
