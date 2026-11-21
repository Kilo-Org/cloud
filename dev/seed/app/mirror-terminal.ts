import { execFileSync } from 'node:child_process';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq, or } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import {
  buildAssistantMessageItem,
  buildFilePartItem,
  buildSessionItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';
import { seedTokenSigningParams } from '../lib/token-signing';
import { isValidEmail } from '../lib/users';

export const usage = '<email>';

/**
 * Fixture for the artifact mirror's terminal-outcome crawl.
 *
 * The mirror advances at most `MAX_SESSIONS_PER_RUN` sessions per run, one
 * stored page each, and it holds the cursor of a page whose download failed.
 * A page whose artifact can never arrive therefore used to hold its cursor
 * forever and spend one of those slots on every run, and a session that kept
 * changing kept the slots ahead of older ones.
 *
 * Every artifact here is a stored `https` URL on the artifact storage origin
 * family, so the crawl downloads through its real path. One local TLS fixture
 * answers them, and the emulator reaches it by pointing the artifact storage
 * origin at a local TLS server: a CA trusted from the emulator's system store,
 * and a DNAT rule sending port 443 to the server, so the crawl's own URL checks
 * and TLS stack both accept the response:
 *
 * - `OVER_CAP_PATH` declares a length over the mirror's cap, so the crawl must
 *   write the artifact off once and move its cursor past the page;
 * - `MISSING_PATH` answers 404, the same write-off from a permanent status;
 * - `FLAKY_PATH` answers 500 every time, so the temporary-failure budget runs
 *   out and the artifact becomes terminal for that session revision;
 * - `tailPath()` answers a small document, so the sessions behind the first
 *   three still materialize once the budget reaches them.
 *
 * Ingest itself never carries the artifact bytes: a part over ~1.9 MiB is
 * skipped by the session-ingest worker, so a `data:` payload cannot stand in
 * for an over-cap download. Ingest also stamps each session's `updated_at`, so
 * the seed rewrites that column once every history is readable and fails when
 * the resulting order is not the one below; the crawl's budget walks that order.
 */
export const OVER_CAP_SESSION_ID = 'ses_00000000011MirrorCapTermnl';
export const OVER_CAP_SESSION_TITLE = 'Mirror over-cap artifact';
export const MISSING_SESSION_ID = 'ses_00000000012MirrorGoneTermn';
export const MISSING_SESSION_TITLE = 'Mirror missing artifact';
export const FLAKY_SESSION_ID = 'ses_00000000017MirrorFlakyTerm';
export const FLAKY_SESSION_TITLE = 'Mirror flaky artifact';
export const TAIL_SESSION_IDS = [
  'ses_00000000013MirrorTailTerm1',
  'ses_00000000014MirrorTailTerm2',
  'ses_00000000015MirrorTailTerm3',
  'ses_00000000016MirrorTailTerm4',
] as const;

/** The three sessions whose artifact can never be materialized, in list order. */
const TERMINAL_SESSION_IDS = [OVER_CAP_SESSION_ID, MISSING_SESSION_ID, FLAKY_SESSION_ID] as const;

/** Non-fetchable fixtures picked for the crawl's download path. */
export const OVER_CAP_PATH = '/mirror-fixture/over-cap.bin';
export const MISSING_PATH = '/mirror-fixture/missing.bin';
export const FLAKY_PATH = '/mirror-fixture/flaky.bin';
export function tailPath(index: number): string {
  return `/mirror-fixture/tail-${index + 1}.txt`;
}

/** The storage endpoint the crawl accepts: R2's S3 host with a 32-hex account label. */
export const STORAGE_ORIGIN = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';

const TOKEN_EXPIRES_SECONDS = 3600;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const BASE_TIME = Date.UTC(2026, 0, 2, 0, 0, 0);

const INSERTED_AT = '2000-01-01T00:00:00.000Z';
/** Rounds of stamp-and-verify the order tolerates before failing. */
const STAMP_ROUNDS = 6;
/** Gap between a stamp and its verifying read, so a throttled ingest write can land. */
const STAMP_SETTLE_MS = 4_000;

/**
 * Ordered newest first. Stamped only after every ingest write has landed,
 * because ingest overwrites this column with the time it processed the session.
 */
const SESSION_UPDATED_AT = [
  '2099-01-01T00:00:07.000Z',
  '2099-01-01T00:00:06.000Z',
  '2099-01-01T00:00:05.000Z',
  '2099-01-01T00:00:04.000Z',
  '2099-01-01T00:00:03.000Z',
  '2099-01-01T00:00:02.000Z',
  '2099-01-01T00:00:01.000Z',
] as const;

function printUsage(): void {
  console.log('Seed the artifact mirror terminal-outcome fixture for one user.');
  console.log('');
  console.log(`Usage: pnpm dev:seed app:mirror-terminal ${usage}`);
  console.log('');
  console.log('Seven sessions: one over-cap artifact, one 404, one always-500, and');
  console.log('four ordinary ones. Every artifact URL points at');
  console.log(`  ${STORAGE_ORIGIN}`);
  console.log('so start the local TLS fixture and trust its CA on the emulator first.');
  console.log('');
  console.log('Needs the local stack: cloudflare-session-ingest must be up.');
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

function parseArgs(args: string[]): { email: string } {
  const positionals = args.filter(arg => !arg.startsWith('--')).map(arg => arg.trim());
  const unknown = args.filter(arg => arg.startsWith('--'));
  if (unknown.length > 0) {
    throw new Error(`Unknown arguments: ${unknown.join(' ')}`);
  }
  const [email, ...rest] = positionals;
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (rest.length > 0) {
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }
  return { email };
}

/** One session with one assistant message carrying one file part. */
function buildSessionWithArtifact(params: {
  sessionId: string;
  title: string;
  mime: string;
  filename: string;
  path: string;
  createdAt: number;
}): SessionIngestItem[] {
  const userMessageId = `msgMirror${params.sessionId.slice(-6)}User`;
  const assistantMessageId = `msgMirror${params.sessionId.slice(-6)}Asst`;
  return [
    buildSessionItem({ sessionId: params.sessionId, slug: params.sessionId, title: params.title }),
    buildUserMessageItem({
      messageId: userMessageId,
      sessionId: params.sessionId,
      createdAt: params.createdAt,
    }),
    buildAssistantMessageItem({
      messageId: assistantMessageId,
      sessionId: params.sessionId,
      parentId: userMessageId,
      createdAt: params.createdAt + 1_000,
      completedAt: params.createdAt + 2_000,
      cost: 0.01,
      tokens: { total: 10, input: 8, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    buildFilePartItem({
      partId: `prtMirror${params.sessionId.slice(-6)}File`,
      sessionId: params.sessionId,
      messageId: assistantMessageId,
      mime: params.mime,
      filename: params.filename,
      url: `${STORAGE_ORIGIN}${params.path}`,
    }),
  ];
}

/** Every ingest item this fixture writes, by session id, with its session title. */
export function buildMirrorTerminalIngestItems(): Map<
  string,
  { items: SessionIngestItem[]; title: string }
> {
  const sessions = new Map<string, { items: SessionIngestItem[]; title: string }>();

  const add = (
    sessionId: string,
    title: string,
    params: { mime: string; filename: string; path: string; createdAt: number }
  ) => {
    sessions.set(sessionId, {
      items: buildSessionWithArtifact({ sessionId, title, ...params }),
      title,
    });
  };

  add(OVER_CAP_SESSION_ID, OVER_CAP_SESSION_TITLE, {
    mime: 'application/octet-stream',
    filename: 'over-cap.bin',
    path: OVER_CAP_PATH,
    createdAt: BASE_TIME + 70_000,
  });
  add(MISSING_SESSION_ID, MISSING_SESSION_TITLE, {
    mime: 'application/pdf',
    filename: 'gone.pdf',
    path: MISSING_PATH,
    createdAt: BASE_TIME + 60_000,
  });
  add(FLAKY_SESSION_ID, FLAKY_SESSION_TITLE, {
    mime: 'text/plain',
    filename: 'flaky.txt',
    path: FLAKY_PATH,
    createdAt: BASE_TIME + 50_000,
  });

  for (const [index, sessionId] of TAIL_SESSION_IDS.entries()) {
    add(sessionId, `Mirror tail ${index + 1}`, {
      mime: 'text/plain',
      filename: `tail-${index + 1}.txt`,
      path: tailPath(index),
      createdAt: BASE_TIME + 40_000 - index * 1_000,
    });
  }

  return sessions;
}

function readSessionIngestStatusJson(): string {
  return execFileSync('pnpm', ['-s', 'dev:status', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

async function ingestSession(
  baseUrl: string,
  sessionId: string,
  token: string,
  items: SessionIngestItem[]
): Promise<void> {
  const response = await fetch(
    `${baseUrl}/api/session/${encodeURIComponent(sessionId)}/ingest?v=1`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: items }),
    }
  );
  if (!response.ok) {
    throw new Error(`Ingest of ${sessionId} failed (${response.status}): ${await response.text()}`);
  }
}

async function pollForHistory(baseUrl: string, sessionId: string, token: string): Promise<number> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const response = await fetch(
      `${baseUrl}/api/session/${encodeURIComponent(sessionId)}/messages?limit=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      throw new Error(`Messages read of ${sessionId} failed (${response.status})`);
    }
    const payload: unknown = await response.json();
    const history =
      typeof payload === 'object' && payload !== null && 'history' in payload
        ? payload.history
        : null;
    if (typeof history === 'object' && history !== null && 'messages' in history) {
      const messages = history.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        return messages.length;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for history of ${sessionId}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const { email } = parseArgs(args);

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is not set for this worktree.');
  }

  const normalizedEmail = normalizeSeedEmail(email);
  assertLocalSeedDatabase('app:mirror-terminal');
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

  const exact = matches.filter(match => match.email === email);
  const resolved = exact.length > 0 ? exact : matches;
  if (resolved.length !== 1) {
    throw new Error(
      resolved.length === 0
        ? `No user found for email ${email}.`
        : `Multiple users matched ${email}.`
    );
  }
  const [user] = resolved;
  if (!user) {
    throw new Error(`No user found for email ${email}.`);
  }

  const { token } = await signKiloToken({
    userId: user.userId,
    pepper: user.apiTokenPepper,
    secret,
    ...seedTokenSigningParams(TOKEN_EXPIRES_SECONDS),
    ...(user.isAdmin ? { extra: { isAdmin: true } } : {}),
  });

  const serviceStatus = parseSessionIngestServiceStatus(readSessionIngestStatusJson());
  if (serviceStatus.status !== 'up') {
    throw new Error('cloudflare-session-ingest is not up. Start the local stack first.');
  }
  const sessionIngestUrl = `http://localhost:${serviceStatus.port}`;

  const fixtures = buildMirrorTerminalIngestItems();
  const sessionIds = [...fixtures.keys()];

  for (const sessionId of sessionIds) {
    await db
      .delete(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, user.userId),
          eq(cli_sessions_v2.session_id, sessionId)
        )
      );
  }

  for (const sessionId of sessionIds) {
    await db.insert(cli_sessions_v2).values({
      session_id: sessionId,
      kilo_user_id: user.userId,
      title: fixtures.get(sessionId)?.title ?? sessionId,
      created_on_platform: 'cloud-agent-web',
      updated_at: INSERTED_AT,
    });
  }

  for (const [sessionId, fixture] of fixtures) {
    await ingestSession(sessionIngestUrl, sessionId, token, fixture.items);
  }

  let messageCount = 0;
  for (const sessionId of sessionIds) {
    messageCount += await pollForHistory(sessionIngestUrl, sessionId, token);
  }

  // Ingest rewrites `updated_at` with the time it processed a session, and it
  // does so asynchronously, so a late write can land after this function. Rather
  // than wait for a signal ingest does not promise — its activity persist is
  // throttled per session, and a fast rerun can leave it closed with no write
  // pending at all — stamp the order and then keep re-stamping until a follow-up
  // read shows it held. A late write is then absorbed by another round instead
  // of failing the run or inverting the fixture.
  //
  // `SESSION_UPDATED_AT` is newest first, which is the order the crawl's budget
  // walks: the artifacts that can never be materialized must lead, or the
  // fixture does not demonstrate the starvation. The stamped values are fixed,
  // so a reseed is not a change the mirror would restart for.
  const fixtureIdSet = new Set(sessionIds);
  for (let round = 0; round < STAMP_ROUNDS; round += 1) {
    for (const [index, sessionId] of sessionIds.entries()) {
      await db
        .update(cli_sessions_v2)
        .set({ updated_at: SESSION_UPDATED_AT[index] ?? SESSION_UPDATED_AT.at(-1) })
        .where(
          and(
            eq(cli_sessions_v2.kilo_user_id, user.userId),
            eq(cli_sessions_v2.session_id, sessionId)
          )
        );
    }
    // The gap lets a throttled ingest write land between the stamp and the read,
    // so the read tests the order rather than the seed's own write.
    await sleep(STAMP_SETTLE_MS);
    const current = await db
      .select({ sessionId: cli_sessions_v2.session_id, updatedAt: cli_sessions_v2.updated_at })
      .from(cli_sessions_v2)
      .where(eq(cli_sessions_v2.kilo_user_id, user.userId));
    const leading = current
      .filter(row => fixtureIdSet.has(row.sessionId))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map(row => row.sessionId)
      .slice(0, TERMINAL_SESSION_IDS.length);
    if (leading.join(',') === TERMINAL_SESSION_IDS.join(',')) {
      break;
    }
  }
  // The loop above already broke on a verified order. Read once more so a write
  // that landed after the last round cannot pass silently: the crawl orders by
  // this column, and a stuck page behind the ordinary sessions would not
  // demonstrate the starvation.
  const finalRows = await db
    .select({ sessionId: cli_sessions_v2.session_id, updatedAt: cli_sessions_v2.updated_at })
    .from(cli_sessions_v2)
    .where(eq(cli_sessions_v2.kilo_user_id, user.userId));
  const finalLeading = finalRows
    .filter(row => fixtureIdSet.has(row.sessionId))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(row => row.sessionId)
    .slice(0, TERMINAL_SESSION_IDS.length);
  if (finalLeading.join(',') !== TERMINAL_SESSION_IDS.join(',')) {
    throw new Error(
      'Fixture order is wrong; the crawl would not meet the stuck sessions first.\n' +
        `expected leading: ${TERMINAL_SESSION_IDS.join(',')}\nactual leading:   ${finalLeading.join(',')}`
    );
  }

  console.log('');
  console.log('This fixture represents: seven sessions the artifact mirror must crawl.');
  console.log('Three of their artifacts can never be materialized (one over the size cap,');
  console.log('one answering 404, one answering 500) and four are ordinary documents.');
  console.log('The list order puts the three impossible ones first, so a run that holds');
  console.log('their pages would never reach the four behind them.');
  console.log('');
  console.log('Note: every artifact URL names the local TLS fixture origin, so start it');
  console.log('and trust its CA on the device before the app syncs.');
  console.log('Suggested next step: foreground the app so the mirror sync runs.');
  console.log('');

  return {
    userId: user.userId,
    email: user.email,
    overCapSessionId: OVER_CAP_SESSION_ID,
    missingSessionId: MISSING_SESSION_ID,
    flakySessionId: FLAKY_SESSION_ID,
    tailSessionIds: TAIL_SESSION_IDS.join(','),
    storageOrigin: STORAGE_ORIGIN,
    messageCount,
    sessionIngestUrl,
  };
}
