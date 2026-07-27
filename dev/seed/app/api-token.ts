import { kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { eq, or } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

export const usage = '<email> [options]';

const DEFAULT_EXPIRES_DAYS = 7;
const SECONDS_PER_DAY = 24 * 60 * 60;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:api-token ${usage}`);
  console.log('');
  console.log('Mints a Kilo user API bearer token (HS256, version 3) for a local');
  console.log('development user, signed with this worktree NEXTAUTH_SECRET. Use it to');
  console.log('authenticate a local kilo CLI or API client as that user.');
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

function isValidEmail(email: string): boolean {
  // Intentionally permissive; we only guard against obvious nonsense in dev.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
      `No user found for email ${options.email}. Sign in locally first (see apps/mobile/e2e/login.sh) or seed a user (pnpm dev:seed app:create-user).`
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
    expiresInSeconds: options.expiresDays * SECONDS_PER_DAY,
    env: process.env.NODE_ENV ?? 'development',
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
