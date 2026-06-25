/**
 * Auth helpers for the local E2E driver.
 *
 * - Loads `NEXTAUTH_SECRET` from `services/cloud-agent-next/.dev.vars`.
 * - Ensures a test user row exists in Postgres (direct insert via
 *   `@kilocode/db`; no reliance on the Next.js fake-login HTTP flow).
 * - Mints Kilo user JWTs for tRPC and short-lived `stream_ticket` JWTs for
 *   the `/stream` WebSocket — same shapes as `apps/web/src/lib/tokens.ts`
 *   and `apps/web/src/lib/cloud-agent/stream-ticket.ts`.
 *
 * Dev-only — never run against a production DB.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import jwt from 'jsonwebtoken';
import { computeDatabaseUrl, createDrizzleClient, kilocode_users, sql } from '@kilocode/db';
import { encryptWithPublicKey } from '@kilocode/encryption';

export const DRIVER_USER_EMAIL_SUFFIX = '@cloud-agent-next-e2e.example.com';
export const FUNDED_DRIVER_BALANCE_MICRODOLLARS = 10_000_000;
const JWT_TOKEN_VERSION = 3;

// ---------------------------------------------------------------------------
// .dev.vars loader
// ---------------------------------------------------------------------------

/**
 * Parse a `.dev.vars` file — same format as `.env`, with `KEY=value` pairs.
 * Trims surrounding quotes and ignores comments/blank lines.
 */
export function parseDotDevVars(contents: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/**
 * Load `.dev.vars` from the cloud-agent-next package root. Throws if the file
 * is missing or `NEXTAUTH_SECRET` is not set — the driver can't continue
 * without it.
 */
export function loadDevVars(servicePackageDir: string): Record<string, string> {
  const devVarsPath = path.join(servicePackageDir, '.dev.vars');
  let contents: string;
  try {
    contents = readFileSync(devVarsPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to read ${devVarsPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Copy .dev.vars.example to .dev.vars and fill in local values.`
    );
  }
  const vars = parseDotDevVars(contents);
  if (!vars.NEXTAUTH_SECRET) {
    throw new Error(`${devVarsPath} does not define NEXTAUTH_SECRET — can't mint JWTs`);
  }
  return vars;
}

/** Load repo database env for standalone `tsx` driver processes. */
export function loadRepoEnvFiles(servicePackageDir: string): void {
  const repoRootDir = path.resolve(servicePackageDir, '../..');
  const envPaths = [
    path.join(repoRootDir, 'apps/web/.env.development.local'),
    path.join(repoRootDir, 'apps/web/.env.local'),
    path.join(repoRootDir, 'apps/web/.env'),
    path.join(repoRootDir, '.env.local'),
    path.join(repoRootDir, '.env'),
  ];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      for (const [key, value] of Object.entries(parseDotDevVars(readFileSync(envPath, 'utf8')))) {
        process.env[key] ??= value;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// User ensure
// ---------------------------------------------------------------------------

export type TestUser = {
  id: string;
  email: string;
  api_token_pepper: string;
};

/**
 * Create (or reuse) a Postgres user row for the E2E driver. Users are keyed
 * by a stable email so repeated runs reuse the same row. The api_token_pepper
 * is derived from the email so the same user always produces the same JWT.
 */
export async function ensureTestUser(
  databaseUrl: string | undefined,
  email: string,
  options?: { funded?: boolean; admin?: boolean }
): Promise<TestUser> {
  const resolvedUrl = databaseUrl ?? computeDatabaseUrl();
  const driver = createDrizzleClient({
    connectionString: resolvedUrl,
    poolConfig: { application_name: 'cloud-agent-next-e2e-driver', max: 1 },
  });
  try {
    const apiTokenPepper = createHash('sha256').update(email).digest('hex').slice(0, 32);
    const userId = 'usr_e2e_' + createHash('sha256').update(email).digest('hex').slice(0, 16);
    const fundedValues = options?.funded
      ? {
          microdollars_used: 0,
          total_microdollars_acquired: FUNDED_DRIVER_BALANCE_MICRODOLLARS,
        }
      : {};

    // Upsert via INSERT ... ON CONFLICT DO UPDATE so we can return the row.
    const db = driver.db;
    await db
      .insert(kilocode_users)
      .values({
        id: userId,
        google_user_email: email,
        google_user_name: 'E2E Driver',
        google_user_image_url: 'https://example.com/avatar.png',
        stripe_customer_id: 'cus_e2e_' + userId,
        api_token_pepper: apiTokenPepper,
        is_admin: options?.admin ?? false,
        ...fundedValues,
      })
      .onConflictDoUpdate({
        target: kilocode_users.id,
        set: {
          api_token_pepper: apiTokenPepper,
          is_admin: options?.admin ?? false,
          ...fundedValues,
          updated_at: sql`now()`,
        },
      });

    return { id: userId, email, api_token_pepper: apiTokenPepper };
  } finally {
    await driver.pool.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// JWT minting
// ---------------------------------------------------------------------------

export type MintedTokens = {
  apiToken: string;
};

/**
 * Mint a Kilo user JWT for tRPC authentication. Mirrors
 * `apps/web/src/lib/tokens.ts:generateApiToken` but with a short expiry
 * since the driver is ephemeral.
 */
export function mintApiToken(user: TestUser, nextAuthSecret: string): string {
  return jwt.sign(
    {
      env: 'development',
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      version: JWT_TOKEN_VERSION,
      tokenSource: 'cloud-agent',
    },
    nextAuthSecret,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

type GatewayJwtKey = {
  keyId: string;
  privateKeyPem?: string;
};

type GatewayJwtKeyset = {
  issuer: string;
  activeKeyId: string;
  keys: GatewayJwtKey[];
};

function parseJsonOrBase64JsonEnv(value: string | undefined, name: string): unknown {
  if (!value) throw new Error(`${name} is required for Ask Usage e2e`);
  try {
    return JSON.parse(value);
  } catch {
    try {
      return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    } catch (error) {
      throw new Error(`${name} must contain valid JSON or base64-encoded JSON`, { cause: error });
    }
  }
}

function readGatewayJwtKeyset(): GatewayJwtKeyset {
  const parsed = parseJsonOrBase64JsonEnv(
    process.env.MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON,
    'MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON'
  );
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON must decode to an object');
  }
  const candidate = parsed as Partial<GatewayJwtKeyset>;
  if (
    typeof candidate.issuer !== 'string' ||
    typeof candidate.activeKeyId !== 'string' ||
    !Array.isArray(candidate.keys)
  ) {
    throw new Error('MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON has an invalid shape');
  }
  return {
    issuer: candidate.issuer,
    activeKeyId: candidate.activeKeyId,
    keys: candidate.keys.map(key => {
      if (typeof key !== 'object' || key === null) {
        throw new Error('MCP gateway JWT key must be an object');
      }
      const record = key as Partial<GatewayJwtKey>;
      if (typeof record.keyId !== 'string') {
        throw new Error('MCP gateway JWT key is missing keyId');
      }
      return {
        keyId: record.keyId,
        privateKeyPem: typeof record.privateKeyPem === 'string' ? record.privateKeyPem : undefined,
      };
    }),
  };
}

export function mintNativeMcpAccessToken(params: {
  user: TestUser;
  appBaseUrl: string;
  clientId: string;
  ttlSeconds?: number;
}): string {
  const keyset = readGatewayJwtKeyset();
  const activeKey = keyset.keys.find(key => key.keyId === keyset.activeKeyId);
  if (!activeKey?.privateKeyPem) {
    throw new Error('MCP gateway active private key is required for Ask Usage e2e');
  }
  const now = Math.floor(Date.now() / 1000);
  const resourceUrl = new URL('/mcp', params.appBaseUrl).toString();
  return jwt.sign(
    {
      iss: keyset.issuer,
      sub: params.user.id,
      aud: resourceUrl,
      exp: now + (params.ttlSeconds ?? 900),
      iat: now,
      scope: 'mcp:access',
      token_use: 'native_mcp',
      client_id: params.clientId,
    },
    activeKey.privateKeyPem,
    { algorithm: 'RS256', keyid: activeKey.keyId }
  );
}

export function encryptAgentHeaderValue(value: string) {
  const publicKey = process.env.AGENT_ENV_VARS_PUBLIC_KEY;
  if (!publicKey) throw new Error('AGENT_ENV_VARS_PUBLIC_KEY is required for Ask Usage e2e');
  return encryptWithPublicKey(value, Buffer.from(publicKey, 'base64'));
}

/**
 * Mint a short-lived `stream_ticket` for the `/stream` WebSocket. Mirrors
 * `apps/web/src/lib/cloud-agent/stream-ticket.ts:signStreamTicket`.
 */
export function mintStreamTicket(
  user: TestUser,
  cloudAgentSessionId: string,
  nextAuthSecret: string,
  expiresInSeconds = 120
): string {
  return jwt.sign(
    {
      type: 'stream_ticket',
      userId: user.id,
      cloudAgentSessionId,
      nonce: randomUUID(),
    },
    nextAuthSecret,
    { algorithm: 'HS256', expiresIn: expiresInSeconds }
  );
}
