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
  const envPaths = [path.join(repoRootDir, '.env.local'), path.join(repoRootDir, '.env')];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
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
  options?: { funded?: boolean }
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
        is_admin: false,
        ...fundedValues,
      })
      .onConflictDoUpdate({
        target: kilocode_users.id,
        set: {
          api_token_pepper: apiTokenPepper,
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
