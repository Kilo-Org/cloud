import { kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { eq, or } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email> [options]';

// Five years, matching generateApiToken()'s default in
// apps/web/src/lib/tokens.ts (FIVE_YEARS_IN_SECONDS). The resource-delegation
// policy only accepts legacy five-year API tokens for credential exchange
// (LEGACY_API_TOKEN_LIFETIMES_SECONDS in @kilocode/worker-utils), so a token
// with any other lifetime is rejected by control-token routes such as
// cloudAgentNext.prepareSession with 403 "Unsupported legacy credential
// context".
export const DEFAULT_EXPIRES_DAYS = 1825;
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * The exact signing shape `generateApiToken()` mints in production, as the
 * local dev stack's policy expects it:
 *
 * - `expiresInSeconds` must be one of LEGACY_API_TOKEN_LIFETIMES_SECONDS, or
 *   control-token routes (cloudAgentNext.prepareSession and every other
 *   createControlTokenForRequest caller) reject the token with 403
 *   "Unsupported legacy credential context".
 * - `env` must equal the NODE_ENV of the server that verifies the token. This
 *   seed only ever feeds the local dev stack, whose server runs `next dev` —
 *   Next pins its own process.env.NODE_ENV to "development" regardless of
 *   .env files. The seed process must not copy its own dotenv-loaded NODE_ENV
 *   (root .env.local carries NODE_ENV="production" for build tooling), or
 *   getResourceDelegationAuthority rejects every request with 401
 *   "Unauthorized resource delegation request".
 */
export function apiTokenSigningParams(expiresDays: number): {
  expiresInSeconds: number;
  env: string;
} {
  return {
    expiresInSeconds: expiresDays * SECONDS_PER_DAY,
    env: 'development',
  };
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:api-token ${usage}`);
  console.log('');
  console.log('Mints a Kilo user API bearer token (HS256, version 3) for a local');
  console.log('development user, signed with this worktree NEXTAUTH_SECRET. Use it to');
  console.log('authenticate a local kilo CLI or API client as that user.');
  console.log('');
  console.log('The token carries the shape generateApiToken() mints in production: a');
  console.log('five-year legacy user API token with env="development" — the shape the');
  console.log('resource-delegation policy accepts for control-token minting on the');
  console.log('local dev stack. Override the lifetime with --expires-days only when the');
  console.log('consumer never mints resource control tokens.');
  console.log('');
  console.log('Matches either google_user_email exactly or normalized_email.');
  console.log('');
  console.log('Options:');
  console.log(
    `  --expires-days=<number>   Token lifetime in days (default: ${DEFAULT_EXPIRES_DAYS})`
  );
  console.log('  --admin                   Include isAdmin=true in the token payload');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:api-token ada@example.com');
  console.log('  pnpm -s dev:seed app:api-token ada@example.com --json | jq -r .token');
  console.log('  pnpm dev:seed app:api-token ada@example.com --expires-days=30 --admin');
}

function parsePositiveInteger(value: string, flagName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive safe integer`);
  }
  return parsed;
}

type ApiTokenOptions = {
  email: string;
  expiresDays: number;
  isAdmin: boolean;
};

function parseArgs(args: string[]): ApiTokenOptions {
  const email = args[0]?.trim();
  if (!email || email === '--help' || email === '-h') {
    printUsage();
    throw new Error('email is required');
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }

  let expiresDays = DEFAULT_EXPIRES_DAYS;
  let isAdmin = false;

  for (const arg of args.slice(1)) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      throw new Error('help requested');
    }
    if (arg === '--admin') {
      isAdmin = true;
      continue;
    }
    if (arg.startsWith('--expires-days=')) {
      expiresDays = parsePositiveInteger(
        arg.slice('--expires-days='.length).trim(),
        '--expires-days'
      );
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { email, expiresDays, isAdmin };
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseArgs(args);

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      'NEXTAUTH_SECRET is not set for this worktree. Ensure local env is prepared (pnpm dev:worktree:prepare).'
    );
  }

  const normalizedEmail = normalizeSeedEmail(options.email);
  const db = getSeedDb();
  const matches = await db
    .select({
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
      apiTokenPepper: kilocode_users.api_token_pepper,
      isAdmin: kilocode_users.is_admin,
    })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, options.email),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );

  if (matches.length === 0) {
    throw new Error(
      `No user found for email ${options.email}. Sign in locally first, or seed a user (pnpm dev:seed app:create-user).`
    );
  }

  const exactMatches = matches.filter(match => match.email === options.email);
  const resolvedMatches = exactMatches.length > 0 ? exactMatches : matches;
  if (resolvedMatches.length > 1) {
    const matchList = resolvedMatches.map(match => `${match.email} (${match.userId})`).join(', ');
    throw new Error(`Multiple users matched ${options.email}: ${matchList}`);
  }

  const [user] = resolvedMatches;

  const { token, expiresAt } = await signKiloToken({
    userId: user.userId,
    pepper: user.apiTokenPepper,
    secret,
    ...apiTokenSigningParams(options.expiresDays),
    extra: options.isAdmin || user.isAdmin ? { isAdmin: true } : undefined,
  });

  console.log('');
  console.log('This token authenticates a local client as the resolved user. Treat it as a');
  console.log('secret and use it only against this worktree local stack.');

  return {
    userId: user.userId,
    email: user.email,
    isAdmin: options.isAdmin || user.isAdmin,
    expiresAt,
    expiresDays: options.expiresDays,
    token,
  };
}
