import { execFileSync } from 'node:child_process';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';
import {
  buildAssistantMessageItem,
  buildFilePartItem,
  buildSessionItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';

export const usage = '<email>';

// Two entries sanitize to the same basename, so the mirror's own deduplication
// has to give the second one a counter suffix, and one name is long enough that
// the 200-byte bound has to truncate its stem while keeping its extension.
const SESSION_ID = 'ses_00000000000ArtifactFile01';
const SESSION_TITLE = 'Artifact files fixture';
const SESSION_SLUG = 'artifact-files-fixture';
const USER_ID = 'msgArtifactFilesUsr01';
const ASSISTANT_ID = 'msgArtifactFilesAst01';

const SHORT_STEM = 'a'.repeat(240);
const OVERLONG_NAME = `${SHORT_STEM}.markdown`;

const USER_CREATED = 1_700_900_000_000;
const ASSISTANT_CREATED = USER_CREATED + 1_000;

type FixtureFile = { id: string; name: string; mime: string; content: string };

// Written in this order, which is the order the Files app shows: the first
// `report.csv` keeps its name and the second takes the suffix.
const FILES: FixtureFile[] = [
  { id: 'prtArtifactReportA001', name: 'report.csv', mime: 'text/csv', content: 'id,total\n1,10\n' },
  {
    id: 'prtArtifactReportB001',
    name: 'inbox/report.csv',
    mime: 'text/csv',
    content: 'id,total\n2,20\n',
  },
  {
    id: 'prtArtifactLongName01',
    name: OVERLONG_NAME,
    mime: 'text/markdown',
    content: '# Long name\n\nBounded stem, kept extension.\n',
  },
];

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:artifacts-file-provider ${usage}`);
  console.log('');
  console.log('Seeds one agent session whose stored messages carry three file parts,');
  console.log('through the local cloudflare-session-ingest worker. A collision pair and');
  console.log('one over-long name make the session exercise the Files location name');
  console.log('resolution. Resets only its own session.');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:artifacts-file-provider ada@example.com');
}

/** The artifacts a mirror crawl reads out of the stored file parts. */
function fixtureArtifacts(): SessionIngestItem[] {
  return FILES.map(file =>
    buildFilePartItem({
      partId: file.id,
      sessionId: SESSION_ID,
      messageId: ASSISTANT_ID,
      mime: file.mime,
      filename: file.name,
      url: `data:${file.mime};base64,${Buffer.from(file.content).toString('base64')}`,
    })
  );
}

const messagesPageSchema = z.object({
  history: z
    .object({
      messages: z.array(z.object({ parts: z.array(z.object({ id: z.string() })).optional() })),
    })
    .nullish(),
});

async function waitForParts(baseUrl: string, token: string): Promise<void> {
  const expected = FILES.map(file => file.id);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch(`${baseUrl}/api/session/${SESSION_ID}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`messages read failed (${response.status})`);
    const page = messagesPageSchema.safeParse(await response.json());
    const seen = new Set(
      (page.success ? (page.data.history?.messages ?? []) : []).flatMap(message =>
        (message.parts ?? []).map(part => part.id)
      )
    );
    if (expected.every(id => seen.has(id))) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the file parts');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
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
    buildSessionItem({ sessionId: SESSION_ID, slug: SESSION_SLUG, title: SESSION_TITLE }),
    buildUserMessageItem({ messageId: USER_ID, sessionId: SESSION_ID, createdAt: USER_CREATED }),
    buildAssistantMessageItem({
      messageId: ASSISTANT_ID,
      sessionId: SESSION_ID,
      parentId: USER_ID,
      createdAt: ASSISTANT_CREATED,
      completedAt: ASSISTANT_CREATED + 1_000,
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    ...fixtureArtifacts(),
  ];

  const response = await fetch(`${baseUrl}/api/session/${SESSION_ID}/ingest?v=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: items }),
  });
  if (!response.ok) {
    throw new Error(`ingest failed (${response.status}): ${await response.text()}`);
  }
  await waitForParts(baseUrl, token);
  console.log(
    'This fixture represents: one finished agent turn that produced three artifacts whose names exercise collision suffixes and the 200-byte bound in the Files location.'
  );
  console.log('Suggested next step: foreground the signed-in dev build so the mirror syncs.');
  return {
    userId: user.id,
    sessionId: SESSION_ID,
    files: FILES.length,
  };
}
