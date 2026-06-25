import { getWorkerDb, snowflake_query_log } from '@kilocode/db';
import { importPKCS8, SignJWT } from 'jose';

import type { BillingLogFields } from './logger.js';
import type { BillingWorkerEnv } from './types.js';

const SNOWFLAKE_JWT_ALGORITHM = 'RS256';
const SNOWFLAKE_JWT_LIFETIME_SECONDS = 59 * 60;
const SNOWFLAKE_MAX_SUBMIT_ATTEMPTS = 3;
const SNOWFLAKE_MAX_POLL_ATTEMPTS = 10;
const SNOWFLAKE_RETRY_BASE_DELAY_MS = 1_000;
const SNOWFLAKE_ERROR_RESPONSE_MAX_LENGTH = 1_000;
const SNOWFLAKE_USER_AGENT = 'kiloclaw-billing/1.0';

export type SnowflakeConfig = {
  accountHost: string;
  jwtAccountIdentifier: string;
  username: string;
  role: string;
  warehouse: string;
  database: string;
  schema: string;
  privateKeyPem: string;
  publicKeyFingerprint: string;
};

export type SnowflakeLogFn = (
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: BillingLogFields
) => void;

type SnowflakeStatementResponse = {
  code?: string;
  message?: string;
  statementHandle?: string;
  statementStatusUrl?: string;
  data?: unknown[];
};

type SnowflakeErrorDetails = {
  code?: string;
  message?: string;
  responseBody?: string;
};

type SnowflakeQueryMetrics = {
  statementHandle: string | null;
  statusCode: number | null;
  submitRequestCount: number;
  pollRequestCount: number;
  http202Count: number;
  http429Count: number;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
};

type SnowflakeQueryLogRecord = {
  createdAt: string;
  requestId: string;
  succeeded: boolean;
  durationMs: number;
  rowCount: number | null;
  metrics: SnowflakeQueryMetrics;
};

type RecordSnowflakeQuery = (record: SnowflakeQueryLogRecord) => Promise<void>;

function trackStatus(metrics: SnowflakeQueryMetrics, statusCode: number): void {
  metrics.statusCode = statusCode;
  if (statusCode === 202) metrics.http202Count++;
  if (statusCode === 429) metrics.http429Count++;
}

function trackPayload(metrics: SnowflakeQueryMetrics, payload: SnowflakeStatementResponse): void {
  if (payload.statementHandle) metrics.statementHandle = payload.statementHandle;
  if (payload.code && payload.code !== '090001') metrics.errorCode = payload.code;
}

function trackClientError(metrics: SnowflakeQueryMetrics, error: unknown): void {
  if (error instanceof SyntaxError) {
    metrics.errorCode = 'INVALID_RESPONSE';
    metrics.errorMessage = 'Snowflake returned an invalid response';
    return;
  }
  if (error instanceof TypeError) {
    metrics.errorCode = 'NETWORK_ERROR';
    metrics.errorMessage = 'Snowflake request failed at the network boundary';
    return;
  }
  metrics.errorCode = metrics.errorCode ?? 'CLIENT_ERROR';
  metrics.errorMessage = metrics.errorMessage ?? 'Query failed before completion';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function upper(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeJwtAccountIdentifier(value: string): string {
  return upper(value).replaceAll('.', '-');
}

function normalizePublicKeyFingerprint(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('SHA256:') ? trimmed : `SHA256:${trimmed}`;
}

function sanitizeAccountHost(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

function createSnowflakeBindings(
  values: string[]
): Record<string, { type: 'TEXT'; value: string }> {
  return Object.fromEntries(
    values.map((value, index) => [String(index + 1), { type: 'TEXT' as const, value }])
  );
}

function createUsageStatement(batchSize: number): string {
  const placeholders = Array.from({ length: batchSize }, () => '?').join(', ');
  return `select distinct kilo_user_id
from microdollar_usage_hourly
where usage_hour >= dateadd('day', -2, current_date())
  and feature = 'kilo_claw'
  and not is_heartbeat
  and kilo_user_id in (${placeholders})`;
}

function parseActiveUserIds(response: SnowflakeStatementResponse): Set<string> {
  const rows = Array.isArray(response.data) ? response.data : [];
  const userIds = new Set<string>();

  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length === 0) {
      continue;
    }
    userIds.add(row[0]);
  }

  return userIds;
}

async function buildJwt(config: SnowflakeConfig): Promise<string> {
  const qualifiedUsername = `${normalizeJwtAccountIdentifier(config.jwtAccountIdentifier)}.${upper(config.username)}`;
  const publicKeyFingerprint = normalizePublicKeyFingerprint(config.publicKeyFingerprint);
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(config.privateKeyPem, SNOWFLAKE_JWT_ALGORITHM);

  return await new SignJWT({})
    .setProtectedHeader({ alg: SNOWFLAKE_JWT_ALGORITHM })
    .setIssuer(`${qualifiedUsername}.${publicKeyFingerprint}`)
    .setSubject(qualifiedUsername)
    .setIssuedAt(now)
    .setExpirationTime(now + SNOWFLAKE_JWT_LIFETIME_SECONDS)
    .sign(privateKey);
}

async function readJson(response: Response): Promise<SnowflakeStatementResponse> {
  return await response.json();
}

function truncateResponseBody(value: string): string {
  if (value.length <= SNOWFLAKE_ERROR_RESPONSE_MAX_LENGTH) {
    return value;
  }

  return `${value.slice(0, SNOWFLAKE_ERROR_RESPONSE_MAX_LENGTH)}…`;
}

async function readErrorDetails(response: Response): Promise<SnowflakeErrorDetails> {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    try {
      const payload = await readJson(response);
      return {
        code: payload.code,
        message: payload.message,
        responseBody: truncateResponseBody(JSON.stringify(payload)),
      };
    } catch {
      // Fall through and try reading plain text below.
    }
  }

  try {
    const responseBody = truncateResponseBody(await response.text());
    return {
      responseBody: responseBody.length > 0 ? responseBody : undefined,
    };
  } catch {
    return {};
  }
}

function formatSnowflakeApiError(
  fallbackMessage: string,
  details: SnowflakeErrorDetails | null | undefined
): string {
  if (!details) {
    return fallbackMessage;
  }

  if (details.message && details.code) {
    return `${fallbackMessage}: ${details.message} (code: ${details.code})`;
  }

  if (details.message) {
    return `${fallbackMessage}: ${details.message}`;
  }

  if (details.responseBody) {
    return `${fallbackMessage}: ${details.responseBody}`;
  }

  return fallbackMessage;
}

function createSnowflakeQueryRecorder(
  env: BillingWorkerEnv,
  log: SnowflakeLogFn
): RecordSnowflakeQuery {
  return async record => {
    try {
      const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
      await db.insert(snowflake_query_log).values({
        created_at: record.createdAt,
        source: 'kiloclaw-billing',
        query_label: 'trial_inactivity.active_users',
        request_id: record.requestId,
        statement_handle: record.metrics.statementHandle,
        succeeded: record.succeeded,
        status_code: record.metrics.statusCode,
        duration_ms: record.durationMs,
        submit_request_count: record.metrics.submitRequestCount,
        poll_request_count: record.metrics.pollRequestCount,
        partition_request_count: 0,
        http_202_count: record.metrics.http202Count,
        http_429_count: record.metrics.http429Count,
        retry_count: record.metrics.retryCount,
        partition_count: 0,
        row_count: record.rowCount,
        error_code: record.succeeded ? null : record.metrics.errorCode?.slice(0, 100),
        error_message: record.succeeded ? null : record.metrics.errorMessage?.slice(0, 200),
      });
    } catch (error) {
      log('warn', 'Failed to record Snowflake query metrics', {
        event: 'snowflake_query_log_failed',
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

async function submitStatement(params: {
  config: SnowflakeConfig;
  statement: string;
  bindings: Record<string, { type: 'TEXT'; value: string }>;
  jwt: string;
  requestId: string;
  log: SnowflakeLogFn;
  batchSize: number;
  retry: boolean;
  metrics: SnowflakeQueryMetrics;
}): Promise<Response> {
  const startedAt = performance.now();
  params.metrics.submitRequestCount++;
  const url = new URL(`https://${params.config.accountHost}/api/v2/statements`);
  url.searchParams.set('requestId', params.requestId);
  if (params.retry) {
    url.searchParams.set('retry', 'true');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${params.jwt}`,
      'content-type': 'application/json',
      'user-agent': SNOWFLAKE_USER_AGENT,
      'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
    },
    body: JSON.stringify({
      statement: params.statement,
      bindings: params.bindings,
      warehouse: params.config.warehouse,
      database: params.config.database,
      schema: params.config.schema,
      role: params.config.role,
    }),
  });

  trackStatus(params.metrics, response.status);
  const errorDetails = response.ok ? undefined : await readErrorDetails(response.clone());
  if (errorDetails?.code) params.metrics.errorCode = errorDetails.code;

  params.log(response.ok ? 'info' : 'warn', 'Snowflake SQL API submit completed', {
    event: 'downstream_call',
    outcome: response.ok ? 'completed' : 'failed',
    action: 'POST',
    path: '/api/v2/statements',
    statusCode: response.status,
    durationMs: performance.now() - startedAt,
    batchSize: params.batchSize,
    retry: params.retry,
    snowflakeCode: errorDetails?.code,
  });

  return response;
}

async function pollStatement(params: {
  config: SnowflakeConfig;
  jwt: string;
  statementStatusUrl: string;
  statementHandle?: string;
  log: SnowflakeLogFn;
  batchSize: number;
  metrics: SnowflakeQueryMetrics;
}): Promise<SnowflakeStatementResponse> {
  const statusUrl = new URL(params.statementStatusUrl, `https://${params.config.accountHost}`);
  if (statusUrl.protocol !== 'https:' || statusUrl.host !== params.config.accountHost) {
    params.metrics.errorCode = 'UNEXPECTED_POLL_URL';
    params.metrics.errorMessage = 'Snowflake returned an unexpected poll URL';
    throw new Error('Snowflake returned an unexpected statement status URL');
  }

  for (let attempt = 1; attempt <= SNOWFLAKE_MAX_POLL_ATTEMPTS; attempt++) {
    const startedAt = performance.now();
    params.metrics.pollRequestCount++;
    const response = await fetch(statusUrl, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${params.jwt}`,
        'user-agent': SNOWFLAKE_USER_AGENT,
        'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
      },
    });

    trackStatus(params.metrics, response.status);
    const logErrorDetails = response.ok ? undefined : await readErrorDetails(response.clone());
    if (logErrorDetails?.code) params.metrics.errorCode = logErrorDetails.code;

    params.log(response.ok ? 'info' : 'warn', 'Snowflake SQL API poll completed', {
      event: 'downstream_call',
      outcome: response.ok ? 'completed' : 'failed',
      action: 'GET',
      path: '/api/v2/statements/{statementHandle}',
      statusCode: response.status,
      durationMs: performance.now() - startedAt,
      batchSize: params.batchSize,
      pollAttempt: attempt,
      statementHandle: params.statementHandle,
      snowflakeCode: logErrorDetails?.code,
    });

    if (response.status === 200) {
      const payload = await readJson(response);
      trackPayload(params.metrics, payload);
      return payload;
    }

    if (response.status === 202 || response.status === 429) {
      if (response.status === 429) params.metrics.retryCount++;
      await sleep(SNOWFLAKE_RETRY_BASE_DELAY_MS * attempt);
      continue;
    }

    if (response.status === 422) {
      const payload = await readJson(response);
      trackPayload(params.metrics, payload);
      return payload;
    }

    const errorDetails = await readErrorDetails(response);
    throw new Error(
      formatSnowflakeApiError(`Snowflake statement poll failed (${response.status})`, errorDetails)
    );
  }

  params.metrics.errorCode = 'POLL_TIMEOUT';
  params.metrics.errorMessage = 'Statement poll timed out';
  throw new Error('Snowflake statement poll timed out');
}

export function getMissingSnowflakeConfig(env: BillingWorkerEnv): string[] {
  const configEntries = [
    ['SNOWFLAKE_ACCOUNT_HOST', env.SNOWFLAKE_ACCOUNT_HOST],
    ['SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER', env.SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER],
    ['SNOWFLAKE_USERNAME', env.SNOWFLAKE_USERNAME],
    ['SNOWFLAKE_ROLE', env.SNOWFLAKE_ROLE],
    ['SNOWFLAKE_WAREHOUSE', env.SNOWFLAKE_WAREHOUSE],
    ['SNOWFLAKE_DATABASE', env.SNOWFLAKE_DATABASE],
    ['SNOWFLAKE_SCHEMA', env.SNOWFLAKE_SCHEMA],
    ['SNOWFLAKE_PRIVATE_KEY_PEM', env.SNOWFLAKE_PRIVATE_KEY_PEM],
    ['SNOWFLAKE_PUBLIC_KEY_FINGERPRINT', env.SNOWFLAKE_PUBLIC_KEY_FINGERPRINT],
  ] as const;

  return configEntries
    .filter(([, value]) => !value || value.trim().length === 0)
    .map(([key]) => key);
}

export function resolveSnowflakeConfig(env: BillingWorkerEnv): SnowflakeConfig | null {
  if (getMissingSnowflakeConfig(env).length > 0) {
    return null;
  }

  return {
    accountHost: sanitizeAccountHost(env.SNOWFLAKE_ACCOUNT_HOST ?? ''),
    jwtAccountIdentifier: env.SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER ?? '',
    username: env.SNOWFLAKE_USERNAME ?? '',
    role: env.SNOWFLAKE_ROLE ?? '',
    warehouse: env.SNOWFLAKE_WAREHOUSE ?? '',
    database: env.SNOWFLAKE_DATABASE ?? '',
    schema: env.SNOWFLAKE_SCHEMA ?? '',
    privateKeyPem: env.SNOWFLAKE_PRIVATE_KEY_PEM ?? '',
    publicKeyFingerprint: env.SNOWFLAKE_PUBLIC_KEY_FINGERPRINT ?? '',
  };
}

export async function queryKiloclawActiveUserIds(params: {
  env: BillingWorkerEnv;
  userIds: string[];
  log: SnowflakeLogFn;
  recordQuery?: RecordSnowflakeQuery;
  defer?: (promise: Promise<void>) => void;
}): Promise<Set<string>> {
  if (params.userIds.length === 0) {
    return new Set();
  }

  const createdAt = new Date().toISOString();
  const startedAt = performance.now();
  const requestId = crypto.randomUUID();
  const metrics: SnowflakeQueryMetrics = {
    statementHandle: null,
    statusCode: null,
    submitRequestCount: 0,
    pollRequestCount: 0,
    http202Count: 0,
    http429Count: 0,
    retryCount: 0,
    errorCode: null,
    errorMessage: null,
  };
  const recordQuery = params.recordQuery ?? createSnowflakeQueryRecorder(params.env, params.log);
  let succeeded = false;
  let rowCount: number | null = null;

  try {
    const config = resolveSnowflakeConfig(params.env);
    if (!config) {
      metrics.errorCode = 'INCOMPLETE_CONFIG';
      metrics.errorMessage = 'Snowflake configuration is incomplete';
      throw new Error('Snowflake configuration is incomplete');
    }

    const statement = createUsageStatement(params.userIds.length);
    const bindings = createSnowflakeBindings(params.userIds);
    const jwt = await buildJwt(config);

    for (let attempt = 1; attempt <= SNOWFLAKE_MAX_SUBMIT_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await submitStatement({
          config,
          statement,
          bindings,
          jwt,
          requestId,
          log: params.log,
          batchSize: params.userIds.length,
          retry: attempt > 1,
          metrics,
        });
      } catch (error) {
        if (attempt === SNOWFLAKE_MAX_SUBMIT_ATTEMPTS) {
          throw error;
        }
        metrics.retryCount++;
        await sleep(SNOWFLAKE_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      if (response.status === 200) {
        const payload = await readJson(response);
        trackPayload(metrics, payload);
        const activeUserIds = parseActiveUserIds(payload);
        succeeded = true;
        rowCount = activeUserIds.size;
        return activeUserIds;
      }

      if (response.status === 202) {
        const payload = await readJson(response);
        trackPayload(metrics, payload);
        if (!payload.statementStatusUrl) {
          metrics.errorCode = 'MISSING_STATUS_URL';
          metrics.errorMessage = 'Async response missing statement status URL';
          throw new Error('Snowflake response missing statementStatusUrl');
        }
        const completedPayload = await pollStatement({
          config,
          jwt,
          statementStatusUrl: payload.statementStatusUrl,
          statementHandle: payload.statementHandle,
          log: params.log,
          batchSize: params.userIds.length,
          metrics,
        });

        if (completedPayload.code === '090001' || Array.isArray(completedPayload.data)) {
          const activeUserIds = parseActiveUserIds(completedPayload);
          succeeded = true;
          rowCount = activeUserIds.size;
          return activeUserIds;
        }

        metrics.errorCode = completedPayload.code ?? 'ASYNC_QUERY_FAILED';
        metrics.errorMessage = 'Statement failed after polling';
        throw new Error(completedPayload.message ?? 'Snowflake statement failed after polling');
      }

      if (response.status === 429) {
        if (attempt === SNOWFLAKE_MAX_SUBMIT_ATTEMPTS) {
          metrics.errorCode = 'HTTP_429';
          metrics.errorMessage = 'SQL API submit was rate limited';
          throw new Error('Snowflake SQL API submit was rate limited');
        }
        metrics.retryCount++;
        await sleep(SNOWFLAKE_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      if (response.status === 422) {
        const payload = await readJson(response);
        trackPayload(metrics, payload);
        metrics.errorCode = payload.code ?? 'QUERY_FAILED';
        metrics.errorMessage = 'Snowflake rejected the query';
        throw new Error(payload.message ?? 'Snowflake statement failed');
      }

      const errorDetails = await readErrorDetails(response);
      metrics.errorCode = errorDetails.code ?? `HTTP_${response.status}`;
      metrics.errorMessage = `Submit failed with status ${response.status}`;
      throw new Error(
        formatSnowflakeApiError(
          `Snowflake SQL API submit failed (${response.status})`,
          errorDetails
        )
      );
    }

    metrics.errorCode = 'SUBMIT_RETRIES_EXHAUSTED';
    metrics.errorMessage = 'SQL API submit exhausted retries';
    throw new Error('Snowflake SQL API submit exhausted retries');
  } catch (error) {
    trackClientError(metrics, error);
    throw error;
  } finally {
    const persistence = Promise.resolve()
      .then(() =>
        recordQuery({
          createdAt,
          requestId,
          succeeded,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          rowCount,
          metrics,
        })
      )
      .catch(error => {
        params.log('warn', 'Snowflake query metrics recorder failed unexpectedly', {
          event: 'snowflake_query_log_failed',
          outcome: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      });

    if (params.defer) {
      try {
        params.defer(persistence);
      } catch (error) {
        params.log('warn', 'Could not defer Snowflake query metrics persistence', {
          event: 'snowflake_query_log_defer_failed',
          outcome: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        await persistence;
      }
    } else {
      await persistence;
    }
  }
}
