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
const SESSION_ID = 'ses_mobilesessiondiff000000001';
const SESSION_TITLE = 'Session diff fixture';
const USER_ID = 'msgDiffFixUser00001';
const ASSISTANT_ID = 'msgDiffFixAsst00001';
const T0 = 1_700_800_000_000;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-session-diff-fixture ${usage}`);
  console.log('');
  console.log('Seeds one finished agent session with a stored cumulative session diff');
  console.log('(modified, added, deleted, and binary files) through the local');
  console.log('cloudflare-session-ingest worker. Resets only its own session.');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:mobile-session-diff-fixture ada@example.com');
}

function patchFor(file: string, header: string[], hunks: string[]): string {
  return [`diff --git a/${file} b/${file}`, ...header, ...hunks, ''].join('\n');
}

function buildSessionDiff(): Array<Record<string, unknown>> {
  const addedLines = Array.from(
    { length: 24 },
    (_, index) => `+export const step${index} = ${index};`
  );
  return [
    {
      file: 'src/server/routes.ts',
      status: 'modified',
      additions: 4,
      deletions: 2,
      patch: patchFor(
        'src/server/routes.ts',
        [
          'index 1111111..2222222 100644',
          '--- a/src/server/routes.ts',
          '+++ b/src/server/routes.ts',
        ],
        [
          '@@ -1,6 +1,7 @@',
          " import { Hono } from 'hono';",
          "+import { logger } from './logger';",
          ' ',
          ' const app = new Hono();',
          '-app.get("/health", c => c.text("ok"));',
          '+app.get("/health", c => c.json({ ok: true }));',
          ' ',
          ' export default app;',
          '@@ -40,4 +41,6 @@ export function register() {',
          '   const routes = collect();',
          '-  return routes;',
          "+  logger.info('routes registered');",
          '+  return routes.sort();',
          ' }',
        ]
      ),
    },
    {
      file: 'src/server/logger.ts',
      status: 'added',
      additions: 24,
      deletions: 0,
      patch: patchFor(
        'src/server/logger.ts',
        [
          'new file mode 100644',
          'index 0000000..3333333',
          '--- /dev/null',
          '+++ b/src/server/logger.ts',
        ],
        ['@@ -0,0 +1,24 @@', ...addedLines]
      ),
    },
    {
      file: 'docs/legacy-setup.md',
      status: 'deleted',
      additions: 0,
      deletions: 3,
      patch: patchFor(
        'docs/legacy-setup.md',
        [
          'deleted file mode 100644',
          'index 4444444..0000000',
          '--- a/docs/legacy-setup.md',
          '+++ /dev/null',
        ],
        ['@@ -1,3 +0,0 @@', '-# Legacy setup', '-', '-Run the old script.']
      ),
    },
    { file: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0, patch: '' },
  ];
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
    created_on_platform: 'cli',
  });

  const { token } = await signKiloToken({
    userId: user.id,
    pepper: user.apiTokenPepper,
    secret,
    expiresInSeconds: 3600,
    env: process.env.NODE_ENV ?? 'development',
    extra: user.isAdmin ? { isAdmin: true } : undefined,
  });

  const items: SessionIngestItem[] = [
    buildSessionItem({ sessionId: SESSION_ID, slug: 'session-diff-fixture', title: SESSION_TITLE }),
    buildUserMessageItem({ messageId: USER_ID, sessionId: SESSION_ID, createdAt: T0 }),
    buildAssistantMessageItem({
      messageId: ASSISTANT_ID,
      sessionId: SESSION_ID,
      parentId: USER_ID,
      createdAt: T0 + 1_000,
      completedAt: T0 + 2_000,
      cost: 0.01,
      tokens: { total: 100, input: 80, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    { type: 'session_diff', data: buildSessionDiff() },
  ];
  const response = await fetch(`${baseUrl}/api/session/${SESSION_ID}/ingest?v=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: items }),
  });
  if (!response.ok) {
    throw new Error(`ingest failed (${response.status}): ${await response.text()}`);
  }
  console.log(
    'This fixture represents: one finished agent session whose stored diff has a modified, an added, a deleted, and a binary file.'
  );
  console.log(
    'Suggested next step: open the session on a signed-in dev build, then tap View changes.'
  );
  return { userId: user.id, sessionId: SESSION_ID, deepLink: `kiloapp://agent-chat/${SESSION_ID}` };
}
