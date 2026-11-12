import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq, or } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';
import { seedTokenSigningParams } from '../lib/token-signing';

export const usage = '<email>';

export const SESSION_ID = 'ses_anchorLongTranscript000001';
export const SESSION_TITLE = 'Transcript anchor probe';
const TOKEN_EXPIRES_SECONDS = 3600;
const MESSAGE_COUNT = 14;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const START = 1_764_000_000_000;

function messageIdFor(index: number): string {
  return `msgAnchorProbe${String(index).padStart(5, '0')}`;
}

function partIdFor(index: number): string {
  return `prtAnchorProbe${String(index).padStart(5, '0')}`;
}

function body(index: number, role: 'user' | 'assistant'): string {
  return [
    `${role === 'user' ? 'Question' : 'Answer'} ${index}: synthetic transcript text for the anchoring probe.`,
    '',
    'The deploy pipeline runs the migration before it promotes the application, so the order is fixed by the workflow file.',
    'This paragraph is long enough that the row wraps several times on a phone held upright.',
    '',
    'Nothing in this transcript comes from a repository, an account, or a real session.',
  ].join('\n');
}

export function buildItems(): SessionIngestItem[] {
  const items: SessionIngestItem[] = [
    buildSessionItem({ sessionId: SESSION_ID, slug: 'anchor-probe', title: SESSION_TITLE }),
  ];
  for (let index = 1; index <= MESSAGE_COUNT; index += 1) {
    const createdAt = START + index * 1_000;
    const messageId = messageIdFor(index);
    if (index % 2 === 1) {
      items.push(buildUserMessageItem({ messageId, sessionId: SESSION_ID, createdAt }));
    } else {
      items.push(
        buildAssistantMessageItem({
          messageId,
          sessionId: SESSION_ID,
          parentId: messageIdFor(index - 1),
          createdAt,
          completedAt: createdAt + 800,
          cost: 0.001,
          tokens: { total: 40, input: 20, output: 16, reasoning: 0, cache: { read: 2, write: 2 } },
        })
      );
    }
    items.push({
      type: 'part',
      data: {
        id: partIdFor(index),
        sessionID: SESSION_ID,
        messageID: messageId,
        type: 'text',
        text: body(index, index % 2 === 1 ? 'user' : 'assistant'),
      },
    });
  }
  return items;
}

function readSessionIngestStatusJson(): string {
  return execFileSync('pnpm', ['-s', 'dev:status', '--json'], { encoding: 'utf8' });
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  const email = args[0];
  if (!email || !isValidEmail(email)) throw new Error(`Usage: app:anchor-probe ${usage}`);
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set for this worktree.');
  const normalizedEmail = normalizeSeedEmail(email);
  assertLocalSeedDatabase('app:anchor-probe');
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
  if (matches.length === 0) throw new Error(`No user found for email ${email}`);
  const [user] = matches;
  const { token } = await signKiloToken({
    userId: user.userId,
    pepper: user.apiTokenPepper,
    secret,
    ...seedTokenSigningParams(TOKEN_EXPIRES_SECONDS),
    extra: user.isAdmin ? { isAdmin: true } : undefined,
  });
  const status = parseSessionIngestServiceStatus(readSessionIngestStatusJson());
  if (status.status !== 'up') throw new Error('cloudflare-session-ingest is not up.');
  const baseUrl = `http://localhost:${status.port}`;
  await db
    .delete(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, user.userId), eq(cli_sessions_v2.session_id, SESSION_ID))
    );
  await db.insert(cli_sessions_v2).values({
    session_id: SESSION_ID,
    kilo_user_id: user.userId,
    title: SESSION_TITLE,
    created_on_platform: 'cli',
  });
  const response = await fetch(`${baseUrl}/api/session/${SESSION_ID}/ingest?v=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: buildItems() }),
  });
  if (!response.ok) throw new Error(`ingest failed (${response.status}): ${await response.text()}`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const read = await fetch(`${baseUrl}/api/session/${SESSION_ID}/messages?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = (await read.json()) as {
      success?: boolean;
      history?: { messages?: unknown[] } | null;
    };
    const count = payload.history?.messages?.length ?? 0;
    if (count === MESSAGE_COUNT) break;
    if (Date.now() >= deadline) throw new Error(`timed out with ${count} messages`);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const seconds = Number(process.env.ANCHOR_PROBE_SECONDS ?? 600);
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/user/cli`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('CLI socket failed to open')), {
      once: true,
    });
  });
  const heartbeat = () =>
    socket.send(
      JSON.stringify({
        type: 'heartbeat',
        protocolVersion: '1',
        sessions: [{ id: SESSION_ID, status: 'idle', title: SESSION_TITLE }],
      })
    );
  heartbeat();
  const timer = setInterval(heartbeat, 5_000);
  console.log(`seeded ${MESSAGE_COUNT} messages in ${SESSION_ID}; heartbeating ${seconds}s`);
  await sleep(seconds * 1000);
  clearInterval(timer);
  socket.close();
  return { userId: user.userId, sessionId: SESSION_ID };
}