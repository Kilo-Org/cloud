import { execFileSync } from 'node:child_process';

import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';
import { seedTokenSigningParams } from '../lib/token-signing';
import { isValidEmail } from '../lib/users';

export const usage = '<email>';

const SESSION_ID = 'ses_wcznvhxjre0wq479o73fthedp3';
const TITLE = 'Stopped response fixture';
const USER_MESSAGE_ID = 'msgStopFictureUser0001';
const ASSISTANT_MESSAGE_ID = 'msgStopFictureAsst0001';
const TEXT_PART_ID = 'prtStopFictureText0001';
const TOKEN_EXPIRES_SECONDS = 3600;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:stopped-response-fixture ${usage}`);
  console.log('');
  console.log('Seeds one agent session whose assistant message carries a');
  console.log('MessageAbortedError and ends with a stopped text response, through');
  console.log('the local cloudflare-session-ingest worker. Resets only its own session.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:stopped-response-fixture ada@example.com');
  console.log('  pnpm -s dev:seed app:stopped-response-fixture ada@example.com --json');
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const StoredMessageSchema = z.object({
  info: z.object({ id: z.string() }),
  parts: z.array(z.object({ id: z.string(), type: z.string() })),
});

const MessagesResponseSchema = z.object({
  success: z.boolean(),
  history: z
    .object({
      kind: z.string().optional(),
      messages: z.array(StoredMessageSchema).optional(),
    })
    .nullable(),
});

type MessagesResponse = z.infer<typeof MessagesResponseSchema>;

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

function hasAssistantTextPart(page: MessagesResponse): boolean {
  const assistant = page.history?.messages?.find(
    message => message.info.id === ASSISTANT_MESSAGE_ID
  );
  if (!assistant) return false;
  return assistant.parts.some(part => part.id === TEXT_PART_ID && part.type === 'text');
}

function describeHistory(page: MessagesResponse | null): string {
  if (!page) return 'a body that does not match the messages response schema';
  if (!page.success) return 'success=false';
  const history = page.history;
  if (history === null) return 'history=null';
  if (history.kind !== undefined) return `history.kind=${history.kind}`;
  if (!history.messages) return 'a history without messages';
  return `${history.messages.length} message(s) without the assistant text part`;
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
    const parsed = MessagesResponseSchema.safeParse(await response.json());
    const page: MessagesResponse | null = parsed.success ? parsed.data : null;
    if (page?.success) {
      if (page.history?.kind === 'too_large') {
        throw new Error(`session-ingest reported too_large for ${sessionId}`);
      }
      if (hasAssistantTextPart(page)) {
        return page.history?.messages?.length ?? 0;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the transcript of ${sessionId}; saw ${describeHistory(page)}`
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
  const { email } = parseArgs(args);

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is not set for this worktree.');
  }

  const normalizedEmail = normalizeSeedEmail(email);
  assertLocalSeedDatabase('app:stopped-response-fixture');
  const db = getSeedDb();
  const matches = await db
    .select({
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
      apiTokenPepper: kilocode_users.api_token_pepper,
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
  const exactMatches = matches.filter(match => match.email === email);
  const resolvedMatches = exactMatches.length > 0 ? exactMatches : matches;
  if (resolvedMatches.length > 1) {
    const matchList = resolvedMatches.map(match => `${match.email} (${match.userId})`).join(', ');
    throw new Error(`Multiple users matched ${email}: ${matchList}`);
  }
  const [user] = resolvedMatches;
  if (!user) {
    throw new Error(`No user found for email ${email}.`);
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
      and(eq(cli_sessions_v2.kilo_user_id, user.userId), eq(cli_sessions_v2.session_id, SESSION_ID))
    );
  await db.insert(cli_sessions_v2).values({
    session_id: SESSION_ID,
    kilo_user_id: user.userId,
    title: TITLE,
    created_on_platform: 'cli',
  });

  const { token } = await signKiloToken({
    userId: user.userId,
    pepper: user.apiTokenPepper,
    secret,
    ...seedTokenSigningParams(TOKEN_EXPIRES_SECONDS),
  });

  const startedAt = Date.now();
  const items: SessionIngestItem[] = [
    buildSessionItem({ sessionId: SESSION_ID, slug: 'stopped-response-fixture', title: TITLE }),
    buildUserMessageItem({
      messageId: USER_MESSAGE_ID,
      sessionId: SESSION_ID,
      createdAt: startedAt,
    }),
    {
      type: 'message',
      data: {
        ...buildAssistantMessageItem({
          messageId: ASSISTANT_MESSAGE_ID,
          sessionId: SESSION_ID,
          parentId: USER_MESSAGE_ID,
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
      id: TEXT_PART_ID,
      sessionID: SESSION_ID,
      messageID: ASSISTANT_MESSAGE_ID,
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

  const messageCount = await pollForMessages(baseUrl, SESSION_ID, token);

  console.log(
    'This fixture represents: one agent session whose stopped assistant turn carries MessageAbortedError and a neutral text response.'
  );
  console.log(
    'Suggested next step: open the session on a signed-in dev build and check the stopped status line.'
  );
  return {
    userId: user.userId,
    email: user.email,
    sessionId: SESSION_ID,
    messageCount,
    deepLink: `kiloapp:///(app)/agent-chat/${SESSION_ID}`,
  };
}
