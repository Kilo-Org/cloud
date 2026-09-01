import { execFileSync } from 'node:child_process';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq, inArray, or } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import {
  normalizedGitHubUrl,
  readFixtureIntegration,
} from '../lib/frequent-repository-order-fixture';
import type { SeedResult } from '../index';
import {
  buildChildIngestItems,
  buildChildPerformanceFixtures,
  buildEmptyIngestItems,
  buildMobileSheetFixtureResult,
  buildRootIngestItems,
  buildUnsupportedIngestItems,
  CHILD_SESSION_ID,
  CHILD_SESSION_TITLE,
  EMPTY_SESSION_ID,
  EMPTY_SESSION_TITLE,
  expectedPartIdsFor,
  fixtureCleanupSessionIds,
  fixtureSessionIds,
  parseSessionIngestServiceStatus,
  pollForChildPerformanceFixture,
  ROOT_SESSION_ID,
  ROOT_SESSION_TITLE,
  UNSUPPORTED_SESSION_ID,
  UNSUPPORTED_SESSION_TITLE,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';

export const usage = '<email> [options]';

const TOKEN_EXPIRES_SECONDS = 3600;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-sheet-fixtures ${usage}`);
  console.log('');
  console.log('Seeds deterministic mobile transcripts for sheet hit-area E2E.');
  console.log('Resets only the four fixture session IDs, then ingests history');
  console.log('through the local cloudflare-session-ingest worker.');
  console.log('Use --child-performance to also reset and seed a separate tree');
  console.log('with 24 direct children, paged history, and one nested child.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:mobile-sheet-fixtures ada@example.com');
  console.log('  pnpm -s dev:seed app:mobile-sheet-fixtures ada@example.com --json');
  console.log(
    '  pnpm -s dev:seed app:mobile-sheet-fixtures ada@example.com --child-performance --json'
  );
}

function isValidEmail(email: string): boolean {
  // Intentionally permissive; we only guard against obvious nonsense in dev.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArgs(args: string[]): string {
  const positionals: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    positionals.push(arg.trim());
  }

  const [email, ...rest] = positionals;
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (rest.length > 0) {
    printUsage();
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }
  return email;
}

function readSessionIngestStatusJson(): string {
  try {
    return execFileSync('pnpm', ['-s', 'dev:status', '--json'], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(
      `dev:status --json failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function ingestSession(
  baseUrl: string,
  sessionId: string,
  token: string,
  items: SessionIngestItem[]
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/session/${sessionId}/ingest?v=1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: items }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ingest of ${sessionId} failed (${response.status}): ${body}`);
  }
}

async function pollForParts(baseUrl: string, sessionId: string, token: string): Promise<void> {
  const expected = expectedPartIdsFor(sessionId);
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  for (;;) {
    const response = await fetch(`${baseUrl}/api/session/${sessionId}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Messages read of ${sessionId} failed (${response.status})`);
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.success !== true || !isRecord(payload.history)) {
      throw new Error(`Messages read of ${sessionId} returned an unexpected shape`);
    }

    const history = payload.history;
    if (history.kind !== undefined) {
      throw new Error(`session-ingest reported ${String(history.kind)} for ${sessionId}`);
    }
    if (!Array.isArray(history.messages)) {
      throw new Error(`Messages read of ${sessionId} returned an unexpected history shape`);
    }

    const seen = new Set<string>();
    for (const message of history.messages) {
      if (!isRecord(message) || !Array.isArray(message.parts)) continue;
      for (const part of message.parts) {
        if (isRecord(part) && typeof part.id === 'string') {
          seen.add(part.id);
        }
      }
    }

    const missing = expected.filter(id => !seen.has(id));
    if (missing.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for parts of ${sessionId}; missing: ${missing.join(', ')}`
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const childPerformance = args.includes('--child-performance');
  const email = parseArgs(args.filter(arg => arg !== '--child-performance'));
  const performanceFixtures = childPerformance ? buildChildPerformanceFixtures() : [];

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      'NEXTAUTH_SECRET is not set for this worktree. Ensure local env is prepared (pnpm dev:worktree:prepare).'
    );
  }

  const normalizedEmail = normalizeSeedEmail(email);
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
        eq(kilocode_users.google_user_email, email),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );

  if (matches.length === 0) {
    throw new Error(
      `No user found for email ${email}. Sign in locally first, or seed a user (pnpm dev:seed app:create-user).`
    );
  }

  const exactMatches = matches.filter(match => match.email === email);
  const resolvedMatches = exactMatches.length > 0 ? exactMatches : matches;
  if (resolvedMatches.length > 1) {
    const matchList = resolvedMatches.map(match => `${match.email} (${match.userId})`).join(', ');
    throw new Error(`Multiple users matched ${email}: ${matchList}`);
  }

  const [user] = resolvedMatches;

  const { usedRepository } = await readFixtureIntegration(user.userId);
  const rootGitUrl = normalizedGitHubUrl(usedRepository);
  const unsupportedGitUrl = normalizedGitHubUrl('kilo-org/missing-e2e-repo');

  const { token } = await signKiloToken({
    userId: user.userId,
    pepper: user.apiTokenPepper,
    secret,
    expiresInSeconds: TOKEN_EXPIRES_SECONDS,
    env: process.env.NODE_ENV ?? 'development',
    extra: user.isAdmin ? { isAdmin: true } : undefined,
  });

  const serviceStatus = parseSessionIngestServiceStatus(readSessionIngestStatusJson());
  if (serviceStatus.status !== 'up') {
    throw new Error(
      `cloudflare-session-ingest is not up (status=${serviceStatus.status}). Start the local stack first.`
    );
  }
  const sessionIngestUrl = `http://localhost:${serviceStatus.port}`;

  // Reset only fixture IDs, with every descendant before its parent.
  for (const sessionId of fixtureCleanupSessionIds(childPerformance)) {
    await db
      .delete(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, user.userId),
          eq(cli_sessions_v2.session_id, sessionId)
        )
      );
  }

  const remaining = await db
    .select({ sessionId: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, user.userId),
        inArray(cli_sessions_v2.session_id, fixtureSessionIds(childPerformance))
      )
    );
  if (remaining.length > 0) {
    throw new Error(
      `Fixture sessions still present after delete: ${remaining.map(row => row.sessionId).join(', ')}`
    );
  }

  const rows = [
    {
      session_id: ROOT_SESSION_ID,
      kilo_user_id: user.userId,
      title: ROOT_SESSION_TITLE,
      created_on_platform: 'cli',
      git_url: rootGitUrl,
    },
    {
      session_id: CHILD_SESSION_ID,
      kilo_user_id: user.userId,
      title: CHILD_SESSION_TITLE,
      parent_session_id: ROOT_SESSION_ID,
      created_on_platform: 'cli',
    },
    {
      session_id: UNSUPPORTED_SESSION_ID,
      kilo_user_id: user.userId,
      title: UNSUPPORTED_SESSION_TITLE,
      created_on_platform: 'cli',
      git_url: unsupportedGitUrl,
    },
    {
      session_id: EMPTY_SESSION_ID,
      kilo_user_id: user.userId,
      title: EMPTY_SESSION_TITLE,
      created_on_platform: 'cli',
    },
    ...performanceFixtures.map(fixture => ({
      session_id: fixture.sessionId,
      kilo_user_id: user.userId,
      title: fixture.title,
      parent_session_id: fixture.parentId,
      created_on_platform: 'cli',
      git_url: fixture.parentId === undefined ? rootGitUrl : undefined,
    })),
  ] satisfies Array<typeof cli_sessions_v2.$inferInsert>;

  await db.insert(cli_sessions_v2).values(rows);

  await ingestSession(sessionIngestUrl, ROOT_SESSION_ID, token, buildRootIngestItems());
  await ingestSession(sessionIngestUrl, CHILD_SESSION_ID, token, buildChildIngestItems());
  await ingestSession(
    sessionIngestUrl,
    UNSUPPORTED_SESSION_ID,
    token,
    buildUnsupportedIngestItems()
  );
  await ingestSession(sessionIngestUrl, EMPTY_SESSION_ID, token, buildEmptyIngestItems());
  for (const fixture of performanceFixtures) {
    await ingestSession(sessionIngestUrl, fixture.sessionId, token, fixture.items);
  }

  await pollForParts(sessionIngestUrl, ROOT_SESSION_ID, token);
  await pollForParts(sessionIngestUrl, CHILD_SESSION_ID, token);
  for (const fixture of performanceFixtures) {
    await pollForChildPerformanceFixture(sessionIngestUrl, token, fixture);
  }

  console.log('');
  console.log('Seeded four mobile transcripts for sheet hit-area E2E.');
  if (childPerformance) {
    console.log('Also seeded a performance tree with 24 direct children and one nested child.');
  }
  console.log('All fixtures are read-only history: no cloud-agent session ID is set.');

  return buildMobileSheetFixtureResult(
    {
      userId: user.userId,
      email: user.email,
      usedRepository,
      sessionIngestPort: serviceStatus.port,
      sessionIngestUrl,
    },
    childPerformance
  );
}
