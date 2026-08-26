import { execFileSync } from 'node:child_process';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq, or } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';

export const usage = '<email>';

export const SESSION_ID = 'ses_000000000005PagedHistory01';
export const SESSION_TITLE = '60-message pagination fixture';
export const SESSION_SLUG = 'paged-history-fixture';
export const MESSAGE_COUNT = 60;

const TOKEN_EXPIRES_SECONDS = 3600;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const BASE_CREATED_AT = 1_700_100_000_000;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:paged-history ${usage}`);
  console.log('');
  console.log('Seeds one read-only cloud-agent session with 60 tall transcript');
  console.log('messages so the first page (50) overflows and older history stays');
  console.log('behind a scroll-up. Writes the cli_sessions_v2 row, then ingests');
  console.log('through the local cloudflare-session-ingest worker.');
  console.log('No cloud-agent session ID is set, so the UI is historical/read-only.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:paged-history evgeny@kilocode.ai');
  console.log('  pnpm -s dev:seed app:paged-history evgeny@kilocode.ai --json');
}

function isValidEmail(email: string): boolean {
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

function paddedIndex(index: number): string {
  return String(index).padStart(10, '0');
}

function messageIdFor(index: number): string {
  return `msgPaged${paddedIndex(index)}`;
}

function partIdFor(index: number): string {
  return `prtPaged${paddedIndex(index)}`;
}

function messageBody(role: 'User' | 'Assistant', index: number): string {
  return [
    `${role} message ${index} of ${MESSAGE_COUNT}.`,
    '',
    'Padded so fifty messages overflow the chat viewport.',
    'Short one-liners stay on-screen, and the near-top autoload then pulls the older page immediately.',
    `Marker line A for message ${index}.`,
    `Marker line B for message ${index}.`,
    `Marker line C for message ${index}.`,
    `Marker line D for message ${index}.`,
    `Marker line E for message ${index}.`,
    `Marker line F for message ${index}.`,
    `Marker line G for message ${index}.`,
    `End of ${role.toLowerCase()} message ${index}.`,
  ].join('\n');
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

export function buildPagedHistoryIngestItems(): SessionIngestItem[] {
  const items: SessionIngestItem[] = [
    buildSessionItem({
      sessionId: SESSION_ID,
      slug: SESSION_SLUG,
      title: SESSION_TITLE,
    }),
  ];

  for (let index = 1; index <= MESSAGE_COUNT; index += 1) {
    const createdAt = BASE_CREATED_AT + index * 1_000;
    const messageId = messageIdFor(index);
    const isUser = index % 2 === 1;

    if (isUser) {
      items.push(
        buildUserMessageItem({
          messageId,
          sessionId: SESSION_ID,
          createdAt,
        }),
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
        createdAt,
        completedAt: createdAt + 200,
        cost: 0.001,
        tokens: {
          total: 40,
          input: 20,
          output: 16,
          reasoning: 0,
          cache: { read: 2, write: 2 },
        },
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
    if (!isRecord(history)) {
      throw new Error(`Messages read of ${sessionId} returned an unexpected history shape`);
    }
    if (history.kind !== undefined) {
      throw new Error(`session-ingest reported ${String(history.kind)} for ${sessionId}`);
    }
    if (!Array.isArray(history.messages)) {
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

  await ingestSession(sessionIngestUrl, SESSION_ID, token, buildPagedHistoryIngestItems());
  const messageCount = await pollForMessages(sessionIngestUrl, SESSION_ID, token);

  console.log('');
  console.log('Seeded a read-only 60-message cloud-agent transcript.');
  console.log('Hard-refresh /cloud/chat?sessionId=' + SESSION_ID + '.');
  console.log('Newest 50 should be on screen; scroll up for the older 10.');

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
