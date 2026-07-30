#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const USAGE_PAGE_LIMIT = 1000;
const DEFAULT_PADDING_SECONDS = 5;
const CREDENTIALS_FILE = join(homedir(), '.cf-read-only');
const REQUIRED_ENVIRONMENT_VARIABLES = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ANALYTICS_API_TOKEN'];
const REQUIRED_USAGE_FIELDS = [
  'dimensions_applicationId',
  'dimensions_instanceId',
  'dimensions_datetime',
  'sum_cpuTimeSec',
  'sum_allocatedMemory',
  'sum_allocatedDisk',
  'sum_txBytes',
];
const ALLOWED_ARGUMENTS = new Set([
  '--instance-id',
  '--start',
  '--end',
  '--meter-seconds',
  '--memory-mib',
  '--disk-mb',
  '--padding-seconds',
]);

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

const USAGE_QUERY = `
query ContainerUsageProbe(
  $accountTag: String!
  $datetimeStart: Time!
  $datetimeEnd: Time!
  $instanceIds: [String!]
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      containersUsageAdaptiveGroups(
        limit: ${USAGE_PAGE_LIMIT}
        filter: {
          datetime_geq: $datetimeStart
          datetime_lt: $datetimeEnd
          instanceId_in: $instanceIds
        }
      ) {
        dimensions { applicationId instanceId datetime }
        sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }
      }
    }
  }
}`;

function usage() {
  return `Usage:
  node scripts/probe-cloudflare-container-usage.mjs
    --instance-id <cloudflare-instance-id>
    --start <meter-run-start-rfc3339>
    --end <meter-run-end-rfc3339>
    --meter-seconds <accepted-seconds>
    --memory-mib <provisioned-MiB>
    --disk-mb <provisioned-MB>
    [--padding-seconds <seconds>]

Credentials file:
  ~/.cf-read-only

Expected dotenv variables:
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_ANALYTICS_API_TOKEN

Existing process environment values take precedence over the file.
The script queries one exact meter run with ${DEFAULT_PADDING_SECONDS} seconds of
boundary padding by default. It reports raw GraphQL responses plus memory/disk
allocation-equivalent seconds and their absolute and percentage variance from
accepted meter seconds. It fails on incomplete provider responses and never prints
the token, request headers, or environment values.`;
}

function loadCredentials() {
  if (REQUIRED_ENVIRONMENT_VARIABLES.every(name => process.env[name])) return;

  let values;
  try {
    values = parseEnv(readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Unable to load ${CREDENTIALS_FILE}: ${reason}`);
  }
  for (const name of REQUIRED_ENVIRONMENT_VARIABLES) {
    if (!process.env[name] && values[name]) process.env[name] = values[name];
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!argument?.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    if (!ALLOWED_ARGUMENTS.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }

  const instanceId = values.get('--instance-id');
  const start = values.get('--start');
  const end = values.get('--end');
  if (!instanceId || !start || !end) throw new Error('instance-id, start, and end are required');
  if (instanceId.length > 256) throw new Error('instance-id must be at most 256 characters');

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('start and end must form a valid, increasing RFC3339 window');
  }
  if (endMs - startMs > 31 * 24 * 60 * 60 * 1_000) {
    throw new Error('meter run must not exceed 31 days');
  }

  const meterSeconds = Number(values.get('--meter-seconds'));
  const memoryMib = Number(values.get('--memory-mib'));
  const diskMb = Number(values.get('--disk-mb'));
  const paddingSeconds = Number(values.get('--padding-seconds') ?? DEFAULT_PADDING_SECONDS);
  if (!values.has('--meter-seconds') || !Number.isFinite(meterSeconds) || meterSeconds < 0) {
    throw new Error('meter-seconds is required and must be a non-negative number');
  }
  if (
    !values.has('--memory-mib') ||
    !values.has('--disk-mb') ||
    !Number.isFinite(memoryMib) ||
    memoryMib <= 0 ||
    !Number.isFinite(diskMb) ||
    diskMb <= 0
  ) {
    throw new Error('memory-mib and disk-mb are required and must be positive numbers');
  }
  if (!Number.isFinite(paddingSeconds) || paddingSeconds < 0 || paddingSeconds > 60) {
    throw new Error('padding-seconds must be between 0 and 60');
  }

  return {
    help: false,
    instanceId,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    queryStart: new Date(startMs - paddingSeconds * 1000).toISOString(),
    queryEnd: new Date(endMs + paddingSeconds * 1000).toISOString(),
    meterSeconds,
    meterWallSeconds: (endMs - startMs) / 1000,
    memoryMib,
    diskMb,
    paddingSeconds,
  };
}

async function postGraphql(token, query, variables) {
  let response;
  try {
    response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new Error(timedOut ? 'Cloudflare request timed out' : 'Cloudflare request failed');
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > RESPONSE_LIMIT_BYTES) {
    throw new Error(`Cloudflare response exceeded ${RESPONSE_LIMIT_BYTES} bytes`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare returned HTTP ${response.status} with a non-JSON body`);
  }
  return { httpStatus: response.status, body };
}

function assertSuccessfulGraphqlResponse(label, response) {
  if (response.httpStatus < 200 || response.httpStatus >= 300) {
    throw new Error(`${label} returned HTTP ${response.httpStatus}`);
  }
  const errors = response.body?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors
      .map(error => (typeof error?.message === 'string' ? error.message : 'unknown GraphQL error'))
      .join('; ');
    throw new Error(`${label} returned GraphQL errors: ${messages}`);
  }
}

function validateUsageSettings(settingsResponse) {
  const dataset =
    settingsResponse.body?.data?.viewer?.accounts?.[0]?.settings?.containersUsageAdaptiveGroups;
  if (!dataset || dataset.enabled !== true || !Array.isArray(dataset.availableFields)) {
    throw new Error('containersUsageAdaptiveGroups is unavailable or disabled');
  }
  const missingFields = REQUIRED_USAGE_FIELDS.filter(
    field => !dataset.availableFields.includes(field)
  );
  if (missingFields.length > 0) {
    throw new Error(`Cloudflare usage dataset is missing fields: ${missingFields.join(', ')}`);
  }
  if (typeof dataset.maxPageSize !== 'number' || dataset.maxPageSize < USAGE_PAGE_LIMIT) {
    throw new Error(`Cloudflare usage page limit is below ${USAGE_PAGE_LIMIT}`);
  }
}

function summarizeUsage(usageResponse, args) {
  const groups = usageResponse.body?.data?.viewer?.accounts?.[0]?.containersUsageAdaptiveGroups;
  if (!Array.isArray(groups)) {
    throw new Error('Usage groups were not present at the expected path');
  }
  if (groups.length >= USAGE_PAGE_LIMIT) {
    throw new Error(
      `Usage query reached its ${USAGE_PAGE_LIMIT}-row limit; results may be partial`
    );
  }
  if (groups.some(group => group?.dimensions?.instanceId !== args.instanceId)) {
    throw new Error('Usage response contained an unexpected instance ID');
  }

  const provisionedMemoryBytes = args.memoryMib * 1024 ** 2;
  const provisionedDiskBytes = args.diskMb * 1_000_000;
  const totals = {
    cpuTimeSec: 0,
    allocatedMemory: 0,
    allocatedDisk: 0,
    txBytes: 0,
  };
  const rows = groups.map(group => {
    const allocatedMemory = group?.sum?.allocatedMemory;
    const allocatedDisk = group?.sum?.allocatedDisk;
    const cpuTimeSec = group?.sum?.cpuTimeSec;
    const txBytes = group?.sum?.txBytes;
    if (
      typeof allocatedMemory !== 'number' ||
      typeof allocatedDisk !== 'number' ||
      typeof cpuTimeSec !== 'number' ||
      typeof txBytes !== 'number'
    ) {
      throw new Error('A usage row contained missing or non-numeric billing sums');
    }
    totals.cpuTimeSec += cpuTimeSec;
    totals.allocatedMemory += allocatedMemory;
    totals.allocatedDisk += allocatedDisk;
    totals.txBytes += txBytes;

    const memorySeconds = allocatedMemory / provisionedMemoryBytes;
    const diskSeconds = allocatedDisk / provisionedDiskBytes;
    return {
      applicationId: group?.dimensions?.applicationId ?? null,
      datetime: group?.dimensions?.datetime ?? null,
      memorySeconds,
      diskSeconds,
      memoryDiskDifferenceSeconds: memorySeconds - diskSeconds,
    };
  });
  const applicationIds = [
    ...new Set(rows.map(row => row.applicationId).filter(applicationId => applicationId !== null)),
  ].sort();
  if (applicationIds.length > 1) {
    throw new Error(`Usage response returned multiple applications: ${applicationIds.join(', ')}`);
  }

  const memorySeconds = totals.allocatedMemory / provisionedMemoryBytes;
  const diskSeconds = totals.allocatedDisk / provisionedDiskBytes;
  const variance = providerSeconds => {
    const seconds = providerSeconds - args.meterSeconds;
    return {
      seconds,
      percent: args.meterSeconds === 0 ? null : (seconds / args.meterSeconds) * 100,
    };
  };

  return {
    status: rows.length === 0 ? 'missing_from_cloudflare' : 'compared',
    groupCount: rows.length,
    applicationIds,
    meter: {
      acceptedSeconds: args.meterSeconds,
      wallSeconds: args.meterWallSeconds,
    },
    provisioned: { memoryBytes: provisionedMemoryBytes, diskBytes: provisionedDiskBytes },
    provider: {
      memorySeconds,
      diskSeconds,
      cpuTimeSec: totals.cpuTimeSec,
      allocatedMemoryByteSeconds: totals.allocatedMemory,
      allocatedDiskByteSeconds: totals.allocatedDisk,
      txBytes: totals.txBytes,
    },
    variance: {
      memory: variance(memorySeconds),
      disk: variance(diskSeconds),
      memoryDiskDifferenceSeconds: memorySeconds - diskSeconds,
    },
    rows,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  loadCredentials();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_ANALYTICS_API_TOKEN;
  if (!accountId || !token) {
    throw new Error(
      `${CREDENTIALS_FILE} must define CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_API_TOKEN`
    );
  }

  const settings = await postGraphql(token, SETTINGS_QUERY, { accountTag: accountId });
  assertSuccessfulGraphqlResponse('Settings query', settings);
  validateUsageSettings(settings);

  const usageResponse = await postGraphql(token, USAGE_QUERY, {
    accountTag: accountId,
    datetimeStart: args.queryStart,
    datetimeEnd: args.queryEnd,
    instanceIds: [args.instanceId],
  });
  assertSuccessfulGraphqlResponse('Usage query', usageResponse);

  const output = {
    scope: {
      instanceId: args.instanceId,
      meterWindow: { start: args.start, end: args.end },
      providerQueryWindow: { start: args.queryStart, end: args.queryEnd },
      paddingSeconds: args.paddingSeconds,
    },
    reconciliation: summarizeUsage(usageResponse, args),
    responses: { settings, usage: usageResponse },
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Unknown probe failure');
  process.exitCode = 1;
});
