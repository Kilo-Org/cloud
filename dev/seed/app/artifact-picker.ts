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

export const usage = '<email> [--session <id>]';

export const SESSION_ID = 'ses_000000000006ArtifactPick01';
export const SESSION_TITLE = 'Quarterly report artifacts';

/**
 * The file one session of this fixture produced. The name is non-Latin on
 * purpose: the artifact mirror, the DocumentsProvider and the attachment
 * composer all carry this string, and a browser that mangles or drops it is
 * the defect this fixture exists to catch. The bytes are a one-page PDF, so a
 * picked row opens as a document and not as an unknown binary.
 */
export const ARTIFACT_FILENAME = 'דוח רבעוני Q3-2026.pdf';
export const ARTIFACT_MIME = 'application/pdf';
const ARTIFACT_BASE64 =
  'JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDIwMF0+PmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUj4+CiUlRU9GCg==';

/** A session with no artifacts: the empty-folder state of the Kilo location. */
export const EMPTY_SESSION_ID = 'ses_000000000007NoArtifacts001';
export const EMPTY_SESSION_TITLE = 'Rename the fixtures';

const TOKEN_EXPIRES_SECONDS = 3600;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const BASE_CREATED_AT = 1_700_400_000_000;

const USER_MESSAGE_ID = 'msgArtifactUser00001';
const ASSISTANT_MESSAGE_ID = 'msgArtifactAssist001';
const ARTIFACT_PART_ID = 'prtArtifactFile00001';
const EMPTY_USER_MESSAGE_ID = 'msgNoArtifactsUser001';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:artifact-picker ${usage}`);
  console.log('');
  console.log('Seeds two read-only cloud-agent sessions for the Kilo file location:');
  console.log(`  ${SESSION_TITLE} — one PDF artifact whose name is not Latin.`);
  console.log(`  ${EMPTY_SESSION_TITLE} — a session with no artifacts.`);
  console.log('The app mirrors them through the real sync, so DocumentsProvider lists');
  console.log('them under the "Kilo" root and the attachment picker can open them.');
  console.log('A data: URL carries the bytes, so no object storage is involved.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:artifact-picker drain-picker@example.com');
  console.log('  pnpm -s dev:seed app:artifact-picker drain-picker@example.com --json');
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

function parseArgs(args: string[]): { email: string } {
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
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }
  return { email };
}

export function buildArtifactIngestItems(): SessionIngestItem[] {
  const userCreated = BASE_CREATED_AT;
  const assistantCreated = BASE_CREATED_AT + 1_000;
  return [
    buildSessionItem({
      sessionId: SESSION_ID,
      slug: 'artifact-picker-fixture',
      title: SESSION_TITLE,
    }),
    buildUserMessageItem({
      messageId: USER_MESSAGE_ID,
      sessionId: SESSION_ID,
      createdAt: userCreated,
    }),
    buildAssistantMessageItem({
      messageId: ASSISTANT_MESSAGE_ID,
      sessionId: SESSION_ID,
      parentId: USER_MESSAGE_ID,
      createdAt: assistantCreated,
      completedAt: assistantCreated + 1_000,
      cost: 0.01,
      tokens: { total: 120, input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    buildFilePartItem({
      partId: ARTIFACT_PART_ID,
      sessionId: SESSION_ID,
      messageId: ASSISTANT_MESSAGE_ID,
      mime: ARTIFACT_MIME,
      filename: ARTIFACT_FILENAME,
      url: `data:${ARTIFACT_MIME};base64,${ARTIFACT_BASE64}`,
    }),
  ];
}

export function buildEmptySessionIngestItems(): SessionIngestItem[] {
  return [
    buildSessionItem({
      sessionId: EMPTY_SESSION_ID,
      slug: 'artifact-picker-empty-fixture',
      title: EMPTY_SESSION_TITLE,
    }),
    buildUserMessageItem({
      messageId: EMPTY_USER_MESSAGE_ID,
      sessionId: EMPTY_SESSION_ID,
      createdAt: BASE_CREATED_AT + 10_000,
    }),
  ];
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
  const response = await fetch(`${baseUrl}/api/session/${sessionId}/ingest?v=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: items }),
  });
  if (!response.ok) {
    throw new Error(`Ingest of ${sessionId} failed (${response.status}): ${await response.text()}`);
  }
}

async function pollForHistory(baseUrl: string, sessionId: string, token: string): Promise<number> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const response = await fetch(`${baseUrl}/api/session/${sessionId}/messages?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
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
  assertLocalSeedDatabase('app:artifact-picker');
  const db = getSeedDb();
  const matches = await db
    .select({
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
      apiTokenPepper: kilocode_users.api_token_pepper,
      isAdmin: kilocode_users.is_admin,
      stripeCustomerId: kilocode_users.stripe_customer_id,
    })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, email),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );

  if (matches.length === 0) {
    throw new Error(`No user found for email ${email}.`);
  }
  const exact = matches.filter(match => match.email === email);
  const [user] = exact.length > 0 ? exact : matches;
  if (!user) {
    throw new Error(`Multiple users matched ${email}.`);
  }

  if (user.stripeCustomerId?.startsWith('cus_local_')) {
    // The app reads the customer on sign-in; a local placeholder is enough for
    // this fixture, and creating a real test-mode customer needs Stripe running.
    console.log(`Note: ${user.userId} keeps its local Stripe customer placeholder.`);
  }

  const { token } = await signKiloToken({
    userId: user.userId,
    pepper: user.apiTokenPepper,
    secret,
    ...seedTokenSigningParams(TOKEN_EXPIRES_SECONDS),
    extra: user.isAdmin ? { isAdmin: true } : undefined,
  });

  const serviceStatus = parseSessionIngestServiceStatus(readSessionIngestStatusJson());
  if (serviceStatus.status !== 'up') {
    throw new Error('cloudflare-session-ingest is not up. Start the local stack first.');
  }
  const sessionIngestUrl = `http://localhost:${serviceStatus.port}`;

  for (const sessionId of [SESSION_ID, EMPTY_SESSION_ID]) {
    await db
      .delete(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, user.userId),
          eq(cli_sessions_v2.session_id, sessionId)
        )
      );
  }

  for (const row of [
    {
      session_id: SESSION_ID,
      kilo_user_id: user.userId,
      title: SESSION_TITLE,
      created_on_platform: 'cloud-agent-web',
    },
    {
      session_id: EMPTY_SESSION_ID,
      kilo_user_id: user.userId,
      title: EMPTY_SESSION_TITLE,
      created_on_platform: 'cloud-agent-web',
    },
  ]) {
    await db.insert(cli_sessions_v2).values(row);
  }

  await ingestSession(sessionIngestUrl, SESSION_ID, token, buildArtifactIngestItems());
  await ingestSession(sessionIngestUrl, EMPTY_SESSION_ID, token, buildEmptySessionIngestItems());
  const messageCount = await pollForHistory(sessionIngestUrl, SESSION_ID, token);

  console.log('');
  console.log('Seeded the Kilo file location fixture.');
  console.log(`The artifact session holds one PDF named "${ARTIFACT_FILENAME}".`);
  console.log('Bring the app to the foreground so the mirror sync materializes it,');
  console.log('then open Agents > New session > Add attachment > Files > Kilo.');
  console.log('');

  return {
    userId: user.userId,
    email: user.email,
    sessionId: SESSION_ID,
    sessionTitle: SESSION_TITLE,
    artifactFilename: ARTIFACT_FILENAME,
    emptySessionId: EMPTY_SESSION_ID,
    messageCount,
    sessionIngestUrl,
  };
}
