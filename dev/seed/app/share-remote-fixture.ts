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

export const usage = '<email> [--port <n>]';

/**
 * Fixture for the mobile app's attachment share of a remote file.
 *
 * The app materializes a file part by fetching its URL: a `data:` payload is
 * written to the cache, a `file://` attachment is presigned, and an `http(s)`
 * URL takes the `shareRemoteFile` transfer path. Every part here therefore
 * carries a plain `http://localhost:<port>` URL served by a local fixture, so a
 * tap on the attachment in the app runs the real download and the real error
 * classification instead of skipping straight to a cached file:
 *
 * - `OK_PATH` answers 200 with a small text body, the success case;
 * - `MISSING_PATH` answers 404, a definitive refusal the user is asked to stop
 *   retrying;
 * - `STALL_PATH` accepts the request and never answers, so the share's deadline
 *   is what ends it.
 *
 * Two more sessions reuse `OK_PATH` to cover the name a share carries: an
 * accented filename (`Rechnung-März.pdf`) and a filename that arrived as a
 * relative path (`../../Rechnung März.pdf`), of which only the basename may
 * survive.
 *
 * The device reaches this host through `adb reverse tcp:<port> tcp:<port>`:
 * the URL is `localhost` from the phone's own point of view, so no tunnel and
 * no non-loopback address are involved.
 *
 * Each case is its own session so the app list offers one row per case and a
 * tap selects exactly one URL. Session ids are exactly thirty characters:
 * session-ingest rejects any other length, so the trailing name carries the
 * case.
 */
export const OK_SESSION_ID = 'ses_00000000021ShareRemoteFile';
export const OK_SESSION_TITLE = 'Share fixture: ok.txt';
export const MISSING_SESSION_ID = 'ses_00000000022ShareRemoteGone';
export const MISSING_SESSION_TITLE = 'Share fixture: missing.pdf';
export const STALL_SESSION_ID = 'ses_00000000023ShareRemoteHang';
export const STALL_SESSION_TITLE = 'Share fixture: stall.txt';
export const NAME_SESSION_ID = 'ses_00000000024ShareRemoteName';
export const NAME_SESSION_TITLE = 'Share fixture: Rechnung-März.pdf';
export const PATH_SESSION_ID = 'ses_00000000025ShareRemotePath';
export const PATH_SESSION_TITLE = 'Share fixture: ../Rechnung März.pdf';

/** The paths the local fixture server answers, one per transfer outcome. */
export const OK_PATH = '/ok';
export const MISSING_PATH = '/missing';
export const STALL_PATH = '/stall';

/** The port the local fixture server listens on unless `--port` moves it. */
export const DEFAULT_FIXTURE_PORT = 8099;

const TOKEN_EXPIRES_SECONDS = 3600;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const BASE_CREATED_AT = Date.UTC(2026, 0, 2, 0, 0, 0);

const INSERTED_AT = '2000-01-01T00:00:00.000Z';

type ShareFixtureCase = {
  sessionId: string;
  title: string;
  /** Names the case inside its message and part ids, which stay short. */
  tag: string;
  mime: string;
  filename: string;
  path: string;
  createdAt: number;
};

/**
 * One session per outcome, oldest last. The order only decides the seeded
 * timestamps; ingest restamps `updated_at`, so the app list can show them in
 * any order and each stays selectable on its own.
 */
const CASES = [
  {
    sessionId: OK_SESSION_ID,
    title: OK_SESSION_TITLE,
    tag: 'Ok',
    mime: 'text/plain',
    filename: 'ok.txt',
    path: OK_PATH,
    createdAt: BASE_CREATED_AT + 3_000,
  },
  {
    sessionId: MISSING_SESSION_ID,
    title: MISSING_SESSION_TITLE,
    tag: 'Gone',
    mime: 'application/pdf',
    filename: 'missing.pdf',
    path: MISSING_PATH,
    createdAt: BASE_CREATED_AT + 2_000,
  },
  {
    sessionId: STALL_SESSION_ID,
    title: STALL_SESSION_TITLE,
    tag: 'Hang',
    mime: 'text/plain',
    filename: 'stall.txt',
    path: STALL_PATH,
    createdAt: BASE_CREATED_AT + 1_000,
  },
  {
    // The name a person gets from an accountant: accents and a space must
    // reach the share sheet unchanged.
    sessionId: NAME_SESSION_ID,
    title: NAME_SESSION_TITLE,
    tag: 'Name',
    mime: 'application/pdf',
    filename: 'Rechnung-März.pdf',
    path: OK_PATH,
    createdAt: BASE_CREATED_AT + 500,
  },
  {
    // A name that arrived as a relative path: only its basename may survive.
    sessionId: PATH_SESSION_ID,
    title: PATH_SESSION_TITLE,
    tag: 'Path',
    mime: 'application/pdf',
    filename: '../../Rechnung März.pdf',
    path: OK_PATH,
    createdAt: BASE_CREATED_AT,
  },
] satisfies readonly ShareFixtureCase[];

function printUsage(): void {
  console.log('Seed the mobile attachment share fixture for one user.');
  console.log('');
  console.log(`Usage: pnpm dev:seed app:share-remote-fixture ${usage}`);
  console.log('');
  console.log('Five sessions, one attachment each. Every attachment URL is a');
  console.log(`  http://localhost:${DEFAULT_FIXTURE_PORT}<path>`);
  console.log('address: three answer 200, one answers 404, and one never answers.');
  console.log('The two name cases cover what a share carries: an accented');
  console.log('filename (`Rechnung-März.pdf`) and a filename that arrived as a');
  console.log('relative path (`../../Rechnung März.pdf`), which keeps only its');
  console.log('basename.');
  console.log('Serve those paths on the VM and map the port onto the device first:');
  console.log(`  adb reverse tcp:${DEFAULT_FIXTURE_PORT} tcp:${DEFAULT_FIXTURE_PORT}`);
  console.log('');
  console.log('Needs the local stack: cloudflare-session-ingest must be up.');
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

function parseFixturePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port is not a usable port number: ${value}`);
  }
  return port;
}

function parseArgs(args: string[]): { email: string; port: number } {
  const positionals: string[] = [];
  let port = DEFAULT_FIXTURE_PORT;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error('--port needs a value');
      }
      port = parseFixturePort(value);
      index += 1;
      continue;
    }
    if (arg?.startsWith('--port=')) {
      port = parseFixturePort(arg.slice('--port='.length));
      continue;
    }
    if (arg?.startsWith('--')) {
      throw new Error(`Unknown arguments: ${arg}`);
    }
    if (arg !== undefined) {
      positionals.push(arg.trim());
    }
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
  return { email, port };
}

function fixtureUrl(port: number, path: string): string {
  return `http://localhost:${port}${path}`;
}

/** One session with one assistant message carrying one file part. */
function buildSessionWithArtifact(params: {
  sessionId: string;
  title: string;
  tag: string;
  mime: string;
  filename: string;
  url: string;
  createdAt: number;
}): SessionIngestItem[] {
  const userMessageId = `msgShare${params.tag}User`;
  const assistantMessageId = `msgShare${params.tag}Asst`;
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
      partId: `prtShare${params.tag}File`,
      sessionId: params.sessionId,
      messageId: assistantMessageId,
      mime: params.mime,
      filename: params.filename,
      url: params.url,
    }),
  ];
}

/** Every ingest item this fixture writes, by session id, with its title. */
export function buildShareRemoteFixtureItems(
  port: number = DEFAULT_FIXTURE_PORT
): Map<string, { items: SessionIngestItem[]; title: string }> {
  const sessions = new Map<string, { items: SessionIngestItem[]; title: string }>();
  for (const entry of CASES) {
    sessions.set(entry.sessionId, {
      title: entry.title,
      items: buildSessionWithArtifact({
        sessionId: entry.sessionId,
        title: entry.title,
        tag: entry.tag,
        mime: entry.mime,
        filename: entry.filename,
        url: fixtureUrl(port, entry.path),
        createdAt: entry.createdAt,
      }),
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
  const { email, port } = parseArgs(args);

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is not set for this worktree.');
  }

  const normalizedEmail = normalizeSeedEmail(email);
  assertLocalSeedDatabase('app:share-remote-fixture');
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

  const fixtures = buildShareRemoteFixtureItems(port);
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

  const counts = new Map<string, number>();
  for (const sessionId of sessionIds) {
    counts.set(sessionId, await pollForHistory(sessionIngestUrl, sessionId, token));
  }

  let messageCount = 0;
  for (const count of counts.values()) {
    messageCount += count;
  }

  console.log('');
  console.log('This fixture represents: five sessions, one attachment each, every');
  console.log(`attachment URL a http://localhost:${port} address on this VM.`);
  console.log('Three answer 200, one answers 404, and one never answers, so the app');
  console.log('runs the share download success path and both of its failure paths.');
  console.log('The two name cases differ in the name they carry: an accented one');
  console.log('(`Rechnung-März.pdf`) and one that arrived as a relative path');
  console.log('(`../../Rechnung März.pdf`, which keeps only its basename).');
  console.log('');
  console.log(`Note: the device only reaches this host through adb reverse tcp:${port}.`);
  console.log('Suggested next step: foreground the app, open the session for the case');
  console.log('under test, and choose "Open in external app" on its attachment.');
  console.log('');

  return {
    userId: user.userId,
    email: user.email,
    okSessionId: OK_SESSION_ID,
    missingSessionId: MISSING_SESSION_ID,
    stallSessionId: STALL_SESSION_ID,
    nameSessionId: NAME_SESSION_ID,
    pathSessionId: PATH_SESSION_ID,
    port,
    baseUrl: `http://localhost:${port}`,
    okMessageCount: counts.get(OK_SESSION_ID) ?? 0,
    missingMessageCount: counts.get(MISSING_SESSION_ID) ?? 0,
    stallMessageCount: counts.get(STALL_SESSION_ID) ?? 0,
    nameMessageCount: counts.get(NAME_SESSION_ID) ?? 0,
    pathMessageCount: counts.get(PATH_SESSION_ID) ?? 0,
    messageCount,
    sessionIngestUrl,
  };
}
