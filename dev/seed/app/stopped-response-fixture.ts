import { execFileSync } from 'node:child_process';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';

import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';
import { seedTokenSigningParams } from '../lib/token-signing';

const SESSION_ID = 'ses_wcznvhxjre0wq479o73fthedp3';
const EMAIL = 'drain-gate@example.com';
const TITLE = 'Stopped response fixture';

const HistoryResponseSchema = z.object({
  history: z
    .object({ messages: z.array(z.unknown()) })
    .partial()
    .optional(),
});

export async function run(): Promise<unknown> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is not set for this worktree.');
  }
  assertLocalSeedDatabase('app:stopped-response-fixture');
  const db = getSeedDb();
  const [user] = await db
    .select({
      id: kilocode_users.id,
      apiTokenPepper: kilocode_users.api_token_pepper,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.google_user_email, EMAIL))
    .limit(1);
  if (!user) {
    throw new Error(`No user for ${EMAIL}.`);
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
    title: TITLE,
    created_on_platform: 'cli',
  });

  const { token } = await signKiloToken({
    userId: user.id,
    pepper: user.apiTokenPepper,
    secret,
    ...seedTokenSigningParams(3600),
  });

  const startedAt = Date.now();
  const userId = 'msgStopFictureUser0001';
  const assistantId = 'msgStopFictureAsst0001';
  const items: SessionIngestItem[] = [
    buildSessionItem({ sessionId: SESSION_ID, slug: 'stopped-response-fixture', title: TITLE }),
    buildUserMessageItem({ messageId: userId, sessionId: SESSION_ID, createdAt: startedAt }),
    {
      type: 'message',
      data: {
        ...buildAssistantMessageItem({
          messageId: assistantId,
          sessionId: SESSION_ID,
          parentId: userId,
          createdAt: startedAt + 500,
          completedAt: startedAt + 4000,
          cost: 0,
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }).data,
        error: { name: 'MessageAbortedError', data: { message: 'Aborted by user.' } },
      },
    },
  ];
  // The stopped turn itself: prose, a list under a heading, and a fenced
  // block, so the alignment pass has real list items and code lines to keep
  // off. `MessageAbortedError` is exactly the name a real stopped generation
  // reports, and it rides on the assistant message row so ingest stores it.
  items.push({
    type: 'part',
    data: {
      id: 'prtStopFictureText0001',
      sessionID: SESSION_ID,
      messageID: assistantId,
      type: 'text',
      text: [
        'Checking the failing test before I stop.',
        '',
        '## Release notes',
        '',
        '- The settings screen now keeps its layout when the list ranks first.',
        '  - A nested item with a longer line that wraps inside the row it opens.',
        '- The stopped response line reads as one neutral status sentence.',
        '',
        '```md',
        '- this line stays code, not a list',
        '```',
      ].join('\n'),
    },
  });

  const ingest = await fetch(`${baseUrl}/api/session/${SESSION_ID}/ingest?v=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: items }),
  });
  if (!ingest.ok) {
    throw new Error(`ingest failed (${ingest.status}): ${await ingest.text()}`);
  }

  const check = await fetch(`${baseUrl}/api/session/${SESSION_ID}/messages?limit=10`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!check.ok) {
    throw new Error(`history read failed (${check.status}): ${await check.text()}`);
  }
  const history = HistoryResponseSchema.parse(await check.json());
  const messages = history.history?.messages ?? [];
  return { sessionId: SESSION_ID, messageCount: messages.length };
}
