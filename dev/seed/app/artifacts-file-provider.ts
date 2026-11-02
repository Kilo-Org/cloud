import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { kiloSdkMessageHistorySchema } from '@kilocode/session-ingest-contracts';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import {
  buildAssistantMessageItem,
  buildFilePartItem,
  buildSessionItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';
import { isValidEmail } from '../lib/users';

export const usage = '<email> [--asset-url <http(s) url>]';

// 30 chars: `ses_` + 26, the shape the app's session ids take.
const SESSION_ID = 'ses_000000000009ArtifactsFile01';
const SESSION_TITLE = 'Artifacts file provider fixture';
const SESSION_SLUG = 'artifacts-file-provider-fixture';
const USER_MESSAGE_ID = 'msgArtifactsUser00001';
const ASSISTANT_MESSAGE_ID = 'msgArtifactsAsst00001';

/**
 * The artifacts the mirror keeps, in the order the fixture ingests them. Two
 * share a name, so the phone's file browser has to disambiguate them, and one
 * carries a path separator, so it has to be sanitized into one component.
 */
const ARTIFACTS = [
  { partId: 'prtArtifactsReport001', filename: 'report.svg', mime: 'image/svg+xml' },
  { partId: 'prtArtifactsReport002', filename: 'report.svg', mime: 'image/svg+xml' },
  { partId: 'prtArtifactsPasswd0001', filename: '../../etc/passwd', mime: 'text/plain' },
  { partId: 'prtArtifactsNotes00001', filename: 'notes.md', mime: 'text/markdown' },
] as const;

/**
 * A file the local web app already serves, so the device downloads real bytes
 * without the fixture standing anything up. Pass `--asset-url` when the stack
 * runs on raised ports.
 */
const DEFAULT_ASSET_URL = 'http://localhost:3000/file.svg';

const T0 = 1_700_900_000_000;
const TOKEN_EXPIRES_SECONDS = 3600;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

/** The messages endpoint's envelope around the shared history contract. */
const messagesResponseSchema = z.object({
  success: z.literal(true),
  history: kiloSdkMessageHistorySchema,
});

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:artifacts-file-provider ${usage}`);
  console.log('');
  console.log('Seeds one agent session whose stored history holds four artifacts: two');
  console.log('that share a filename, one with a path separator in its name, and one');
  console.log('markdown file. Resets only its own session, then ingests history through');
  console.log('the local cloudflare-session-ingest worker.');
  console.log('');
  console.log('This fixture represents: the agent artifacts the phone file browser lists.');
  console.log('The Kilo app mirrors them on the next foreground sync, so sign in, bring');
  console.log('the app to the foreground, then open the Kilo location in Files.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:artifacts-file-provider ada@example.com');
  console.log(
    '  pnpm dev:seed app:artifacts-file-provider ada@example.com --asset-url http://localhost:4100/file.svg'
  );
}

function parseArgs(args: string[]): { email: string; assetUrl: string } | null {
  const positionals: string[] = [];
  let assetUrl = DEFAULT_ASSET_URL;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--asset-url') {
      const value = args[index + 1];
      if (value === undefined || !/^https?:\/\//u.test(value)) {
        throw new Error('--asset-url needs an http(s) URL');
      }
      assetUrl = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    positionals.push(arg.trim());
  }
  const [email, ...rest] = positionals;
  if (!email) {
    return null;
  }
  if (rest.length > 0) {
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }
  return { email, assetUrl };
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

function buildIngestItems(assetUrl: string): SessionIngestItem[] {
  return [
    buildSessionItem({ sessionId: SESSION_ID, slug: SESSION_SLUG, title: SESSION_TITLE }),
    buildUserMessageItem({ messageId: USER_MESSAGE_ID, sessionId: SESSION_ID, createdAt: T0 }),
    buildAssistantMessageItem({
      messageId: ASSISTANT_MESSAGE_ID,
      sessionId: SESSION_ID,
      parentId: USER_MESSAGE_ID,
      createdAt: T0 + 1_000,
      completedAt: T0 + 2_000,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    ...ARTIFACTS.map(artifact =>
      buildFilePartItem({
        partId: artifact.partId,
        sessionId: SESSION_ID,
        messageId: ASSISTANT_MESSAGE_ID,
        mime: artifact.mime,
        filename: artifact.filename,
        url: assetUrl,
      })
    ),
  ];
}

async function ingestSession(
  baseUrl: string,
  token: string,
  items: SessionIngestItem[]
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/session/${SESSION_ID}/ingest?v=1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: items }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ingest of ${SESSION_ID} failed (${response.status}): ${body}`);
  }
}

async function pollForParts(baseUrl: string, token: string): Promise<void> {
  const expected = ARTIFACTS.map(artifact => artifact.partId);
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  for (;;) {
    const response = await fetch(`${baseUrl}/api/session/${SESSION_ID}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Messages read of ${SESSION_ID} failed (${response.status})`);
    }
    const payload = messagesResponseSchema.parse(await response.json());
    // A typed failure variant means the worker has not materialized the page
    // yet, so there is nothing to look for on this pass.
    const seen =
      'messages' in payload.history
        ? new Set(payload.history.messages.flatMap(message => message.parts.map(part => part.id)))
        : new Set<string>();
    const missing = expected.filter(id => !seen.has(id));
    if (missing.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for parts of ${SESSION_ID}; missing: ${missing.join(', ')}`
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function findUser(email: string) {
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
        eq(kilocode_users.normalized_email, normalizeSeedEmail(email))
      )
    );
  if (matches.length === 0) {
    throw new Error(
      `No user found for email ${email}. Sign in locally first, or seed a user (pnpm dev:seed app:create-user).`
    );
  }
  const exact = matches.filter(match => match.email === email);
  const resolved = exact.length > 0 ? exact : matches;
  if (resolved.length > 1) {
    throw new Error(
      `Multiple users matched ${email}: ${resolved.map(m => `${m.email} (${m.userId})`).join(', ')}`
    );
  }
  return resolved[0];
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const parsed = parseArgs(args);
  if (parsed === null) {
    printUsage();
    throw new Error('email is required');
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      'NEXTAUTH_SECRET is not set for this worktree. Ensure local env is prepared (pnpm dev:worktree:prepare).'
    );
  }

  const user = await findUser(parsed.email);
  const db = getSeedDb();

  // Reset only this fixture's own session.
  await db
    .delete(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, user.userId), eq(cli_sessions_v2.session_id, SESSION_ID))
    );

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

  await db.insert(cli_sessions_v2).values({
    session_id: SESSION_ID,
    kilo_user_id: user.userId,
    title: SESSION_TITLE,
    created_on_platform: 'cli',
  } satisfies typeof cli_sessions_v2.$inferInsert);

  await ingestSession(sessionIngestUrl, token, buildIngestItems(parsed.assetUrl));
  await pollForParts(sessionIngestUrl, token);

  console.log('');
  console.log('This fixture represents: the agent artifacts the phone file browser lists.');
  console.log('Note: read-only history, no cloud-agent session ID is set.');
  console.log('Suggested next step: sign in on the device, foreground the app so the');
  console.log('mirror syncs, then open Files -> Kilo -> the session folder.');

  return {
    userId: user.userId,
    email: user.email,
    sessionId: SESSION_ID,
    sessionTitle: SESSION_TITLE,
    assetUrl: parsed.assetUrl,
    artifactCount: ARTIFACTS.length,
    sessionIngestPort: serviceStatus.port,
  };
}
