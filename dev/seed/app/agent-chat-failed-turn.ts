import { execFileSync } from 'node:child_process';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';

export const usage = '<email>';

// 30 chars: ses_ + 26.
const SESSION_ID = 'ses_000000000FailedTurnFixture';
const SESSION_TITLE = 'Failed turn fixture';
const USER_ID = 'msgFailedTurnUser0000001';
const USER_PART_ID = 'prtFailedTurnUserText01';
const ASSISTANT_ID = 'msgFailedTurnAsst000001';
const USER_TEXT = 'Hello there';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:agent-chat-failed-turn ${usage}`);
  console.log('');
  console.log('Seeds one finished CLI session whose last turn failed at the');
  console.log('provider with a retryable error, the way a real CLI stores it: a');
  console.log('user message with its text, then a contentless assistant message');
  console.log('carrying an `APIError` with `isRetryable: true`. The transcript row');
  console.log('shows the failure statement with Retry, and no session content.');
  console.log('Open the deep link on a signed-in dev build.');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:agent-chat-failed-turn ada@example.com');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const email = args[0]?.trim();
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is not set for this worktree.');
  }

  const db = getSeedDb();
  const [user] = await db
    .select({
      id: kilocode_users.id,
      apiTokenPepper: kilocode_users.api_token_pepper,
      isAdmin: kilocode_users.is_admin,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.google_user_email, email))
    .limit(1);
  if (!user) {
    throw new Error(`No user for ${email}.`);
  }

  const status = parseSessionIngestServiceStatus(
    execFileSync('pnpm', ['-s', 'dev:status', '--json'], { encoding: 'utf8' })
  );
  if (status.status !== 'up') {
    throw new Error(`cloudflare-session-ingest is ${status.status}.`);
  }
  const baseUrl = `http://localhost:${status.port}`;

  await db
    .delete(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, user.id), eq(cli_sessions_v2.session_id, SESSION_ID))
    );
  await db.insert(cli_sessions_v2).values({
    session_id: SESSION_ID,
    kilo_user_id: user.id,
    title: SESSION_TITLE,
    status: 'idle',
    created_on_platform: 'cli',
  });

  const { token } = await signKiloToken({
    userId: user.id,
    pepper: user.apiTokenPepper,
    secret,
    expiresInSeconds: 600,
    env: process.env.NODE_ENV ?? 'development',
    extra: user.isAdmin ? { isAdmin: true } : undefined,
  });

  const startedAt = Date.now();
  const items: SessionIngestItem[] = [
    buildSessionItem({ sessionId: SESSION_ID, slug: 'failed-turn-fixture', title: SESSION_TITLE }),
    buildUserMessageItem({ messageId: USER_ID, sessionId: SESSION_ID, createdAt: startedAt }),
    {
      type: 'part',
      data: {
        id: USER_PART_ID,
        sessionID: SESSION_ID,
        messageID: USER_ID,
        type: 'text',
        text: USER_TEXT,
      },
    },
    buildAssistantMessageItem({
      messageId: ASSISTANT_ID,
      sessionId: SESSION_ID,
      parentId: USER_ID,
      createdAt: startedAt + 1_000,
      completedAt: startedAt + 1_500,
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: {
        name: 'APIError',
        data: {
          message: 'Upstream provider returned HTTP 500',
          statusCode: 500,
          isRetryable: true,
        },
      },
    }),
  ];
  const ingest = await fetch(`${baseUrl}/api/session/${SESSION_ID}/ingest?v=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: items }),
  });
  if (!ingest.ok) {
    throw new Error(`ingest failed (${ingest.status}): ${await ingest.text()}`);
  }

  console.log(
    'This fixture represents: a CLI session whose last provider request failed with a retryable error.'
  );
  return {
    userId: user.id,
    sessionId: SESSION_ID,
    deepLink: `kiloapp:///(app)/agent-chat/${SESSION_ID}`,
  };
}
