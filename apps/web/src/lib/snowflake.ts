import jwt from 'jsonwebtoken';

import { getEnvVariable } from '@/lib/dotenvx';
import { recordSnowflakeQuery } from '@/lib/snowflake-query-log';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

/**
 * A positional binding for a Snowflake SQL statement.
 * `TEXT` covers most cases; use `DATE` or `TIMESTAMP_LTZ` when you need
 * Snowflake to apply an explicit type conversion.
 */
export type SnowflakeBinding =
  | { type: 'TEXT'; value: string }
  | { type: 'DATE'; value: string }
  | { type: 'TIMESTAMP_LTZ'; value: string }
  | { type: 'FIXED'; value: string };

/** A row returned by Snowflake — values are always strings in the SQL API. */
export type SnowflakeRow = string[];

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

const REQUIRED_ENV_KEYS = [
  'SNOWFLAKE_ACCOUNT_HOST',
  'SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER',
  'SNOWFLAKE_USERNAME',
  'SNOWFLAKE_ROLE',
  'SNOWFLAKE_WAREHOUSE',
  'SNOWFLAKE_DATABASE',
  'SNOWFLAKE_SCHEMA',
  'SNOWFLAKE_PRIVATE_KEY_PEM',
  'SNOWFLAKE_PUBLIC_KEY_FINGERPRINT',
] as const;

export function getMissingSnowflakeEnvKeys(): string[] {
  return REQUIRED_ENV_KEYS.filter(k => !getEnvVariable(k));
}

/**
 * Reads Snowflake config from environment variables.
 * Returns `null` when any required variable is missing.
 */
export function resolveSnowflakeConfig(): SnowflakeConfig | null {
  if (getMissingSnowflakeEnvKeys().length > 0) return null;

  const privateKeyRaw = getEnvVariable('SNOWFLAKE_PRIVATE_KEY_PEM');
  const fingerprint = getEnvVariable('SNOWFLAKE_PUBLIC_KEY_FINGERPRINT');
  const accountHost = getEnvVariable('SNOWFLAKE_ACCOUNT_HOST');

  return {
    accountHost: accountHost
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, ''),
    jwtAccountIdentifier: getEnvVariable('SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER'),
    username: getEnvVariable('SNOWFLAKE_USERNAME'),
    role: getEnvVariable('SNOWFLAKE_ROLE'),
    warehouse: getEnvVariable('SNOWFLAKE_WAREHOUSE'),
    database: getEnvVariable('SNOWFLAKE_DATABASE'),
    schema: getEnvVariable('SNOWFLAKE_SCHEMA'),
    // Env vars often encode newlines as literal \n — normalise here.
    privateKeyPem: privateKeyRaw.replace(/\\n/g, '\n'),
    publicKeyFingerprint: fingerprint.startsWith('SHA256:') ? fingerprint : `SHA256:${fingerprint}`,
  };
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

const SNOWFLAKE_JWT_LIFETIME_SECONDS = 59 * 60;

// Cached JWT shared across requests for the same config. Refreshed only when
// within 60 seconds of expiry to avoid per-request RSA signing overhead.
let cachedJwt: { token: string; expiresAtMs: number; fingerprint: string } | null = null;

function getOrBuildJwt(config: SnowflakeConfig): string {
  const now = Date.now();
  const refreshWindowMs = 60_000; // 1 minute before expiry

  if (
    cachedJwt &&
    cachedJwt.fingerprint === config.publicKeyFingerprint &&
    cachedJwt.expiresAtMs > now + refreshWindowMs
  ) {
    return cachedJwt.token;
  }

  const token = buildJwt(config);
  cachedJwt = {
    token,
    expiresAtMs: now + SNOWFLAKE_JWT_LIFETIME_SECONDS * 1000,
    fingerprint: config.publicKeyFingerprint,
  };
  return token;
}

function buildJwt(config: SnowflakeConfig): string {
  const accountId = config.jwtAccountIdentifier.trim().toUpperCase().replaceAll('.', '-');
  const username = config.username.trim().toUpperCase();
  const qualifiedUsername = `${accountId}.${username}`;

  return jwt.sign({}, config.privateKeyPem, {
    algorithm: 'RS256',
    issuer: `${qualifiedUsername}.${config.publicKeyFingerprint}`,
    subject: qualifiedUsername,
    expiresIn: SNOWFLAKE_JWT_LIFETIME_SECONDS,
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const SNOWFLAKE_USER_AGENT = 'kilo-web/1.0';
const SNOWFLAKE_MAX_POLL_ATTEMPTS = (() => {
  const raw = typeof process !== 'undefined' ? process.env.SNOWFLAKE_MAX_POLL_ATTEMPTS : undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
})();
const SNOWFLAKE_POLL_BASE_DELAY_MS = 1_000;

type SnowflakeApiResponse = {
  code?: string;
  message?: string;
  statementHandle?: string;
  statementStatusUrl?: string;
  resultSetMetaData?: {
    partitionInfo?: unknown[];
  };
  data?: unknown[];
};

type SnowflakeQueryMetrics = {
  statementHandle: string | null;
  statusCode: number | null;
  submitRequestCount: number;
  pollRequestCount: number;
  partitionRequestCount: number;
  http202Count: number;
  http429Count: number;
  retryCount: number;
  partitionCount: number;
  errorCode: string | null;
  errorMessage: string | null;
};

type SnowflakeRequestPhase = 'submit' | 'poll' | 'partition';

function trackRequest(metrics: SnowflakeQueryMetrics, phase: SnowflakeRequestPhase): void {
  if (phase === 'submit') metrics.submitRequestCount++;
  if (phase === 'poll') metrics.pollRequestCount++;
  if (phase === 'partition') metrics.partitionRequestCount++;
}

function trackResponse(metrics: SnowflakeQueryMetrics, statusCode: number): void {
  metrics.statusCode = statusCode;
  if (statusCode === 202) metrics.http202Count++;
  if (statusCode === 429) metrics.http429Count++;
}

function trackPayload(metrics: SnowflakeQueryMetrics, payload: SnowflakeApiResponse): void {
  if (payload.statementHandle) metrics.statementHandle = payload.statementHandle;
  if (payload.code && payload.code !== '090001') metrics.errorCode = payload.code;
}

function trackErrorResponse(
  metrics: SnowflakeQueryMetrics,
  statusCode: number,
  responseBody: string,
  fallbackMessage: string
): void {
  try {
    const payload = JSON.parse(responseBody) as SnowflakeApiResponse;
    metrics.errorCode = payload.code ?? `HTTP_${statusCode}`;
  } catch {
    metrics.errorCode = `HTTP_${statusCode}`;
  }
  metrics.errorMessage = fallbackMessage;
}

function trackClientError(
  metrics: SnowflakeQueryMetrics,
  error: unknown,
  signal?: AbortSignal
): void {
  if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
    metrics.errorCode = 'ABORTED';
    metrics.errorMessage = 'Query aborted before completion';
    return;
  }
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

function parseRows(response: SnowflakeApiResponse): SnowflakeRow[] {
  if (!Array.isArray(response.data)) return [];
  return response.data.filter(Array.isArray) as SnowflakeRow[];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

function authHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'user-agent': SNOWFLAKE_USER_AGENT,
    'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
  };
}

async function parseAllRows(
  config: SnowflakeConfig,
  token: string,
  response: SnowflakeApiResponse,
  metrics: SnowflakeQueryMetrics,
  signal?: AbortSignal
): Promise<SnowflakeRow[]> {
  trackPayload(metrics, response);
  const rows = parseRows(response);
  const partitionCount = response.resultSetMetaData?.partitionInfo?.length ?? 0;
  metrics.partitionCount = partitionCount;

  if (partitionCount <= 1) return rows;

  const statusUrl =
    response.statementStatusUrl ??
    (response.statementHandle ? `/api/v2/statements/${response.statementHandle}` : null);
  if (!statusUrl) {
    throw new Error('Snowflake response missing statement URL for partitioned result');
  }

  const url = new URL(statusUrl, `https://${config.accountHost}`);
  if (url.protocol !== 'https:' || url.host !== config.accountHost) {
    metrics.errorCode = 'UNEXPECTED_RESULT_URL';
    metrics.errorMessage = 'Snowflake returned an unexpected result URL';
    throw new Error('Snowflake returned an unexpected result URL');
  }

  for (let partition = 1; partition < partitionCount; partition++) {
    url.searchParams.set('partition', String(partition));
    trackRequest(metrics, 'partition');
    const partitionResponse = await fetch(url, {
      headers: authHeaders(token),
      signal,
    });
    trackResponse(metrics, partitionResponse.status);

    if (partitionResponse.status !== 200) {
      const body = await partitionResponse.text().catch(() => '');
      trackErrorResponse(
        metrics,
        partitionResponse.status,
        body,
        `Partition ${partition} request failed`
      );
      throw new Error(
        `Snowflake partition ${partition} failed (${partitionResponse.status}): ${body.slice(0, 500)}`
      );
    }

    const payload = (await partitionResponse.json()) as SnowflakeApiResponse;
    trackPayload(metrics, payload);
    rows.push(...parseRows(payload));
  }

  return rows;
}

async function pollStatement(
  config: SnowflakeConfig,
  token: string,
  statusUrl: string,
  metrics: SnowflakeQueryMetrics,
  signal?: AbortSignal
): Promise<SnowflakeApiResponse> {
  const url = new URL(statusUrl, `https://${config.accountHost}`);

  if (url.protocol !== 'https:' || url.host !== config.accountHost) {
    metrics.errorCode = 'UNEXPECTED_POLL_URL';
    metrics.errorMessage = 'Snowflake returned an unexpected poll URL';
    throw new Error('Snowflake returned an unexpected poll URL');
  }

  for (let attempt = 1; attempt <= SNOWFLAKE_MAX_POLL_ATTEMPTS; attempt++) {
    trackRequest(metrics, 'poll');
    const response = await fetch(url, { headers: authHeaders(token), signal });
    trackResponse(metrics, response.status);

    if (response.status === 200) {
      const payload = (await response.json()) as SnowflakeApiResponse;
      trackPayload(metrics, payload);
      return payload;
    }

    if (response.status === 202 || response.status === 429) {
      if (response.status === 429) metrics.retryCount++;
      await sleep(SNOWFLAKE_POLL_BASE_DELAY_MS * attempt, signal);
      continue;
    }

    const body = await response.text().catch(() => '');
    trackErrorResponse(
      metrics,
      response.status,
      body,
      `Poll request failed with status ${response.status}`
    );
    throw new Error(`Snowflake poll failed (${response.status}): ${body.slice(0, 500)}`);
  }

  metrics.errorCode = 'POLL_TIMEOUT';
  metrics.errorMessage = 'Query timed out after polling';
  throw new Error('Snowflake query timed out after polling');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a SQL statement against Snowflake via the SQL API v2.
 *
 * `bindings` are positional (`?` placeholders in `statement`).
 * `timeoutSeconds` maps to the Snowflake `timeout` request field.
 *
 * Returns an array of rows; each row is an array of string values in
 * column-declaration order.
 */
export async function executeSnowflakeStatement(params: {
  config: SnowflakeConfig;
  source: string;
  queryLabel: string;
  statement: string;
  bindings?: SnowflakeBinding[];
  timeoutSeconds?: number;
  signal?: AbortSignal;
}): Promise<SnowflakeRow[]> {
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  const requestId = crypto.randomUUID();
  const metrics: SnowflakeQueryMetrics = {
    statementHandle: null,
    statusCode: null,
    submitRequestCount: 0,
    pollRequestCount: 0,
    partitionRequestCount: 0,
    http202Count: 0,
    http429Count: 0,
    retryCount: 0,
    partitionCount: 0,
    errorCode: null,
    errorMessage: null,
  };
  let succeeded = false;
  let rowCount: number | null = null;

  try {
    const token = getOrBuildJwt(params.config);
    const url = new URL(`https://${params.config.accountHost}/api/v2/statements`);
    url.searchParams.set('requestId', requestId);

    const body: Record<string, unknown> = {
      statement: params.statement,
      warehouse: params.config.warehouse,
      database: params.config.database,
      schema: params.config.schema,
      role: params.config.role,
    };

    if (params.bindings && params.bindings.length > 0) {
      body.bindings = Object.fromEntries(
        params.bindings.map((binding, index) => [String(index + 1), binding])
      );
    }

    if (params.timeoutSeconds !== undefined) {
      body.timeout = params.timeoutSeconds;
    }

    trackRequest(metrics, 'submit');
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: params.signal,
    });
    trackResponse(metrics, response.status);

    let rows: SnowflakeRow[];
    if (response.status === 200) {
      const payload = (await response.json()) as SnowflakeApiResponse;
      trackPayload(metrics, payload);
      rows = await parseAllRows(params.config, token, payload, metrics, params.signal);
    } else if (response.status === 202) {
      const payload = (await response.json()) as SnowflakeApiResponse;
      trackPayload(metrics, payload);
      if (!payload.statementStatusUrl) {
        metrics.errorCode = 'MISSING_STATUS_URL';
        metrics.errorMessage = 'Async response missing statement status URL';
        throw new Error('Snowflake response missing statementStatusUrl');
      }
      const completed = await pollStatement(
        params.config,
        token,
        payload.statementStatusUrl,
        metrics,
        params.signal
      );
      if (completed.code !== '090001' && !Array.isArray(completed.data)) {
        metrics.errorCode = completed.code ?? 'ASYNC_QUERY_FAILED';
        metrics.errorMessage = 'Async query failed';
        throw new Error(completed.message ?? 'Snowflake async query failed');
      }
      rows = await parseAllRows(params.config, token, completed, metrics, params.signal);
    } else {
      const responseBody = await response.text().catch(() => '');
      trackErrorResponse(
        metrics,
        response.status,
        responseBody,
        `Submit request failed with status ${response.status}`
      );
      throw new Error(
        `Snowflake statement failed (${response.status}): ${responseBody.slice(0, 500)}`
      );
    }

    succeeded = true;
    rowCount = rows.length;
    return rows;
  } catch (error) {
    trackClientError(metrics, error, params.signal);
    throw error;
  } finally {
    try {
      await recordSnowflakeQuery({
        createdAt: startedAt,
        source: params.source,
        queryLabel: params.queryLabel,
        requestId,
        statementHandle: metrics.statementHandle,
        succeeded,
        statusCode: metrics.statusCode,
        durationMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
        submitRequestCount: metrics.submitRequestCount,
        pollRequestCount: metrics.pollRequestCount,
        partitionRequestCount: metrics.partitionRequestCount,
        http202Count: metrics.http202Count,
        http429Count: metrics.http429Count,
        retryCount: metrics.retryCount,
        partitionCount: metrics.partitionCount,
        rowCount,
        errorCode: metrics.errorCode,
        errorMessage: metrics.errorMessage,
      });
    } catch (error) {
      console.error('Snowflake query metrics recorder failed unexpectedly', {
        source: params.source,
        queryLabel: params.queryLabel,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
