import { execFileSync } from 'node:child_process';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq, or } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildToolPartItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';
import { seedTokenSigningParams } from '../lib/token-signing';
import { isValidEmail } from '../lib/users';

export const usage = '<email>';

export const SESSION_ID = 'ses_000000000021ToolAttachFix1';
export const SESSION_TITLE = 'Tool attachments for the mirror';

/**
 * The image one completed `send_file` call returned. A `data:` URL carries the
 * bytes, so the mirror's tool-attachment path materializes the file without
 * object storage, the same way the top-level file part of `app:artifact-picker`
 * does.
 */
export const IMAGE_ATTACHMENT_ID = 'prtToolAttachImage01';
export const IMAGE_ATTACHMENT_URL = 'data:image/png;base64,QUJD';

/**
 * A second attachment on the same tool part with no URL. Both the live sink
 * (`isToolAttachment` then its own `url === ''` skip) and the mirror's walk drop
 * it, so it proves the skip rather than a materialization.
 */
export const EMPTY_ATTACHMENT_ID = 'prtToolAttachEmpty02';

const TOKEN_EXPIRES_SECONDS = 3600;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const BASE_CREATED_AT = 1_700_500_000_000;

const USER_MESSAGE_ID = 'msgToolAttachUser0001';
const ASSISTANT_MESSAGE_ID = 'msgToolAttachAssist01';
const TOOL_PART_ID = 'prtToolAttachPart00001';
const TOOL_CALL_ID = 'callToolAttachSendFile01';
const TOOL_START = BASE_CREATED_AT + 2_000;
const TOOL_END = TOOL_START + 500;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:artifact-tool-attachment ${usage}`);
  console.log('');
  console.log('Seeds one read-only cloud-agent session whose assistant message holds a');
  console.log('completed send_file tool part with two attachments:');
  console.log(`  ${SESSION_TITLE} — one image (a data: URL) and one entry with no URL.`);
  console.log('The app mirrors the session through the real sync, so the tool-attachment');
  console.log('path writes the image into the "Kilo" location and skips the empty entry.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:artifact-tool-attachment drain-attach@example.com');
  console.log('  pnpm -s dev:seed app:artifact-tool-attachment drain-attach@example.com --json');
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

export function buildToolAttachmentIngestItems(): SessionIngestItem[] {
  const userCreated = BASE_CREATED_AT;
  const assistantCreated = BASE_CREATED_AT + 1_000;
  return [
    buildSessionItem({
      sessionId: SESSION_ID,
      slug: 'artifact-tool-attachment-fixture',
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
    buildToolPartItem({
      partId: TOOL_PART_ID,
      sessionId: SESSION_ID,
      messageId: ASSISTANT_MESSAGE_ID,
      callId: TOOL_CALL_ID,
      tool: 'send_file',
      status: 'completed',
      input: { path: 'reports/quarterly-chart.png' },
      output: 'Sent quarterly-chart.png',
      title: 'Sent a file',
      metadata: {},
      start: TOOL_START,
      end: TOOL_END,
      attachments: [
        {
          id: IMAGE_ATTACHMENT_ID,
          sessionID: SESSION_ID,
          messageID: ASSISTANT_MESSAGE_ID,
          type: 'file',
          mime: 'image/png',
          url: IMAGE_ATTACHMENT_URL,
        },
        {
          id: EMPTY_ATTACHMENT_ID,
          sessionID: SESSION_ID,
          messageID: ASSISTANT_MESSAGE_ID,
          type: 'file',
          mime: 'image/png',
          url: '',
        },
      ],
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
  assertLocalSeedDatabase('app:artifact-tool-attachment');
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
    throw new Error(`No user found for email ${email}.`);
  }
  const exact = matches.filter(match => match.email === email);
  const resolved = exact.length > 0 ? exact : matches;
  if (resolved.length > 1) {
    const listed = resolved.map(match => `${match.email} (${match.userId})`).join(', ');
    throw new Error(`Multiple users matched ${email}: ${listed}`);
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
    extra: user.isAdmin ? { isAdmin: true } : undefined,
  });

  const serviceStatus = parseSessionIngestServiceStatus(readSessionIngestStatusJson());
  if (serviceStatus.status !== 'up') {
    throw new Error('cloudflare-session-ingest is not up. Start the local stack first.');
  }
  const sessionIngestUrl = `http://localhost:${serviceStatus.port}`;

  await db
    .delete(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, user.userId),
        eq(cli_sessions_v2.session_id, SESSION_ID)
      )
    );

  await db.insert(cli_sessions_v2).values({
    session_id: SESSION_ID,
    kilo_user_id: user.userId,
    title: SESSION_TITLE,
    created_on_platform: 'cloud-agent-web',
  });

  await ingestSession(sessionIngestUrl, SESSION_ID, token, buildToolAttachmentIngestItems());
  const messageCount = await pollForHistory(sessionIngestUrl, SESSION_ID, token);

  console.log('');
  console.log('Seeded the tool-attachment fixture.');
  console.log(`The session "${SESSION_TITLE}" holds one completed send_file call with an`);
  console.log('image attachment and one attachment that has no URL.');
  console.log(
    'Bring the app to the foreground so the mirror sync materializes it; the session folder appears in the phone\'s Kilo file location.'
  );
  console.log('');

  return {
    userId: user.userId,
    email: user.email,
    sessionId: SESSION_ID,
    sessionTitle: SESSION_TITLE,
    messageCount,
    sessionIngestUrl,
  };
}
