import { execFileSync } from 'node:child_process';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq, or } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';

export const usage = '<email>';

export const SESSION_ID = 'ses_markerShiftFixture00000006';
export const SESSION_TITLE = 'Transcript time markers';
export const SESSION_SLUG = 'transcript-markers-fixture';
export const MESSAGE_COUNT = 8;

const TOKEN_EXPIRES_SECONDS = 3600;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

/**
 * Every message is more than `TRANSCRIPT_TIME_MARKER_GAP_MS` (ten minutes after
 * the previous one), so the transcript renders a marker above each row and one
 * of them sits in the bottom half of the first screen — the position where a
 * transcript that settles its scroll offset late is measured.
 */
export const MESSAGE_GAP_MS = 11 * 60 * 1000;

/** Seconds before "now" of the first message, so every marker shows a time today. */
const START_OFFSET_MS = 90 * 60 * 1000;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:transcript-markers ${usage}`);
  console.log('');
  console.log('Seeds one read-only cloud-agent session whose transcript carries a');
  console.log('time marker above every message (each message is more than ten');
  console.log('minutes after the previous one), including markers inside the first');
  console.log('screen. No cloud-agent session ID is set, so the UI is');
  console.log('historical/read-only.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:transcript-markers evgeny@kilocode.ai');
  console.log('  pnpm -s dev:seed app:transcript-markers evgeny@kilocode.ai --json');
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

function paddedIndex(index: number): string {
  return String(index).padStart(10, '0');
}

function messageIdFor(index: number): string {
  return `msgMarker${paddedIndex(index)}`;
}

function partIdFor(index: number): string {
  return `prtMarker${paddedIndex(index)}`;
}

function messageBody(role: 'User' | 'Assistant', index: number): string {
  return [`${role} message ${index} of ${MESSAGE_COUNT}.`, '', `Marker row ${index}.`].join('\n');
}

function buildTextPartItem(params: {
  partId: string;
  sessionId: string;
  messageId: string;
  text: string;
}): SessionIngestItem {
  return {
    type: 'part',
    data: {
      id: params.partId,
      sessionID: params.sessionId,
      messageID: params.messageId,
      type: 'text',
      text: params.text,
    },
  };
}

export function buildTranscriptMarkersIngestItems(now: number): SessionIngestItem[] {
  const items: SessionIngestItem[] = [
    buildSessionItem({
      sessionId: SESSION_ID,
      slug: SESSION_SLUG,
      title: SESSION_TITLE,
    }),
  ];

  for (let index = 1; index <= MESSAGE_COUNT; index += 1) {
    const createdAt = now - START_OFFSET_MS + index * MESSAGE_GAP_MS;
    const messageId = messageIdFor(index);
    const isUser = index % 2 === 1;

    if (isUser) {
      items.push(
        buildUserMessageItem({ messageId, sessionId: SESSION_ID, createdAt }),
        buildTextPartItem({
          partId: partIdFor(index),
          sessionId: SESSION_ID,
          messageId,
          text: messageBody('User', index),
        })
      );
      continue;
    }

    items.push(
      buildAssistantMessageItem({
        messageId,
        sessionId: SESSION_ID,
        parentId: messageIdFor(index - 1),
        createdAt: createdAt + 500,
        completedAt: createdAt + 2_000,
        cost: 0.001,
        tokens: { total: 40, input: 20, output: 16, reasoning: 0, cache: { read: 2, write: 2 } },
      }),
      buildTextPartItem({
        partId: partIdFor(index),
        sessionId: SESSION_ID,
        messageId,
        text: messageBody('Assistant', index),
      })
    );
  }

  return items;
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
    const body = await response.text();
    throw new Error(`Ingest of ${sessionId} failed (${response.status}): ${body}`);
  }
}

async function pollForMessages(baseUrl: string, sessionId: string, token: string): Promise<number> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  for (;;) {
    const response = await fetch(`${baseUrl}/api/session/${sessionId}/messages?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Messages read of ${sessionId} failed (${response.status})`);
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.success !== true) {
      throw new Error(`Messages read of ${sessionId} returned an unexpected shape`);
    }

    const history = payload.history;
    if (history === null) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for history of ${sessionId}`);
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (!isRecord(history) || !Array.isArray(history.messages)) {
      throw new Error(`Messages read of ${sessionId} returned an unexpected history shape`);
    }
    if (history.messages.length === MESSAGE_COUNT) {
      return history.messages.length;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${MESSAGE_COUNT} messages in ${sessionId}; saw ${history.messages.length}`
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

  const email = parseArgs(args);

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

  await db
    .delete(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, user.userId), eq(cli_sessions_v2.session_id, SESSION_ID))
    );

  await db.insert(cli_sessions_v2).values({
    session_id: SESSION_ID,
    kilo_user_id: user.userId,
    title: SESSION_TITLE,
    created_on_platform: 'cloud-agent-web',
  } satisfies typeof cli_sessions_v2.$inferInsert);

  await ingestSession(
    sessionIngestUrl,
    SESSION_ID,
    token,
    buildTranscriptMarkersIngestItems(Date.now())
  );
  const messageCount = await pollForMessages(sessionIngestUrl, SESSION_ID, token);

  console.log('');
  console.log('Seeded a read-only transcript whose markers sit above every message.');
  console.log('Run the design gate on kiloapp:///agent-chat/' + SESSION_ID + '.');

  return {
    userId: user.userId,
    email: user.email,
    sessionId: SESSION_ID,
    messageCount,
    sessionIngestPort: serviceStatus.port,
    sessionIngestUrl,
    chatPath: `/cloud/chat?sessionId=${SESSION_ID}`,
  };
}
