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
  and feature = 'kiloclaw'
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

async function submitStatement(params: {
  config: SnowflakeConfig;
  statement: string;
  bindings: Record<string, { type: 'TEXT'; value: string }>;
  jwt: string;
  requestId: string;
  log: SnowflakeLogFn;
  batchSize: number;
  retry: boolean;
}): Promise<Response> {
  const startedAt = performance.now();
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

  const errorDetails = response.ok ? undefined : await readErrorDetails(response.clone());

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
    snowflakeMessage: errorDetails?.message,
    responseBody: errorDetails?.responseBody,
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
}): Promise<SnowflakeStatementResponse> {
  const statusUrl = new URL(params.statementStatusUrl, `https://${params.config.accountHost}`);

  for (let attempt = 1; attempt <= SNOWFLAKE_MAX_POLL_ATTEMPTS; attempt++) {
    const startedAt = performance.now();
    const response = await fetch(statusUrl, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${params.jwt}`,
        'user-agent': SNOWFLAKE_USER_AGENT,
        'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
      },
    });

    const logErrorDetails = response.ok ? undefined : await readErrorDetails(response.clone());

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
      snowflakeMessage: logErrorDetails?.message,
      responseBody: logErrorDetails?.responseBody,
    });

    if (response.status === 200) {
      return await readJson(response);
    }

    if (response.status === 202 || response.status === 429) {
      await sleep(SNOWFLAKE_RETRY_BASE_DELAY_MS * attempt);
      continue;
    }

    if (response.status === 422) {
      return await readJson(response);
    }

    const errorDetails = await readErrorDetails(response);
    throw new Error(
      formatSnowflakeApiError(`Snowflake statement poll failed (${response.status})`, errorDetails)
    );
  }

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
}): Promise<Set<string>> {
  if (params.userIds.length === 0) {
    return new Set();
  }

  const config = resolveSnowflakeConfig(params.env);
  if (!config) {
    throw new Error('Snowflake configuration is incomplete');
  }

  const statement = createUsageStatement(params.userIds.length);
  const bindings = createSnowflakeBindings(params.userIds);
  const jwt = await buildJwt(config);
  const requestId = crypto.randomUUID();

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
      });
    } catch (error) {
      if (attempt === SNOWFLAKE_MAX_SUBMIT_ATTEMPTS) {
        throw error;
      }
      await sleep(SNOWFLAKE_RETRY_BASE_DELAY_MS * attempt);
      continue;
    }

    if (response.status === 200) {
      return parseActiveUserIds(await readJson(response));
    }

    if (response.status === 202) {
      const payload = await readJson(response);
      if (!payload.statementStatusUrl) {
        throw new Error('Snowflake response missing statementStatusUrl');
      }
      const completedPayload = await pollStatement({
        config,
        jwt,
        statementStatusUrl: payload.statementStatusUrl,
        statementHandle: payload.statementHandle,
        log: params.log,
        batchSize: params.userIds.length,
      });

      if (completedPayload.code === '090001' || Array.isArray(completedPayload.data)) {
        return parseActiveUserIds(completedPayload);
      }

      throw new Error(completedPayload.message ?? 'Snowflake statement failed after polling');
    }

    if (response.status === 429) {
      if (attempt === SNOWFLAKE_MAX_SUBMIT_ATTEMPTS) {
        throw new Error('Snowflake SQL API submit was rate limited');
      }
      await sleep(SNOWFLAKE_RETRY_BASE_DELAY_MS * attempt);
      continue;
    }

    if (response.status === 422) {
      const payload = await readJson(response);
      throw new Error(payload.message ?? 'Snowflake statement failed');
    }

    const errorDetails = await readErrorDetails(response);
    throw new Error(
      formatSnowflakeApiError(`Snowflake SQL API submit failed (${response.status})`, errorDetails)
    );
  }

  throw new Error('Snowflake SQL API submit exhausted retries');
}
