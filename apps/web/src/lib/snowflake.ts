import jwt from 'jsonwebtoken';

import { getEnvVariable } from '@/lib/dotenvx';

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
  data?: unknown[];
};

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

async function pollStatement(
  config: SnowflakeConfig,
  token: string,
  statusUrl: string,
  signal?: AbortSignal
): Promise<SnowflakeApiResponse> {
  const url = new URL(statusUrl, `https://${config.accountHost}`);

  if (url.hostname !== config.accountHost) {
    throw new Error(`Snowflake returned unexpected poll host: ${url.hostname}`);
  }

  for (let attempt = 1; attempt <= SNOWFLAKE_MAX_POLL_ATTEMPTS; attempt++) {
    const response = await fetch(url, { headers: authHeaders(token), signal });

    if (response.status === 200) {
      return (await response.json()) as SnowflakeApiResponse;
    }

    if (response.status === 202 || response.status === 429) {
      await sleep(SNOWFLAKE_POLL_BASE_DELAY_MS * attempt, signal);
      continue;
    }

    const body = await response.text().catch(() => '');
    throw new Error(`Snowflake poll failed (${response.status}): ${body.slice(0, 500)}`);
  }

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
  statement: string;
  bindings?: SnowflakeBinding[];
  timeoutSeconds?: number;
  signal?: AbortSignal;
}): Promise<SnowflakeRow[]> {
  const token = getOrBuildJwt(params.config);
  const requestId = crypto.randomUUID();

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
    body.bindings = Object.fromEntries(params.bindings.map((b, i) => [String(i + 1), b]));
  }

  if (params.timeoutSeconds !== undefined) {
    body.timeout = params.timeoutSeconds;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (response.status === 200) {
    const payload = (await response.json()) as SnowflakeApiResponse;
    return parseRows(payload);
  }

  if (response.status === 202) {
    const payload = (await response.json()) as SnowflakeApiResponse;
    if (!payload.statementStatusUrl) {
      throw new Error('Snowflake response missing statementStatusUrl');
    }
    const completed = await pollStatement(
      params.config,
      token,
      payload.statementStatusUrl,
      params.signal
    );
    if (completed.code === '090001' || Array.isArray(completed.data)) {
      return parseRows(completed);
    }
    throw new Error(completed.message ?? 'Snowflake async query failed');
  }

  const body2 = await response.text().catch(() => '');
  throw new Error(`Snowflake statement failed (${response.status}): ${body2.slice(0, 500)}`);
}
