import { execFileSync } from 'node:child_process';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildToolPartItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';
import { seedTokenSigningParams } from '../lib/token-signing';

export const usage = '<email>';

// 30 chars: ses_ + 26.
const SESSION_ID = 'ses_00000000000SharedFence0001';
const SESSION_TITLE = 'Shared transcript fixture';

const PROMPT_ONE_ID = 'msgSharedFenceUser00001';
const PLAIN_ASSISTANT_ID = 'msgSharedFenceAsst0001';
const PROMPT_TWO_ID = 'msgSharedFenceUser00002';
const FENCE_ASSISTANT_ID = 'msgSharedFenceAsst0002';
const PROMPT_THREE_ID = 'msgSharedFenceUser00003';
const TOOL_ASSISTANT_ID = 'msgSharedFenceAsst0003';

const PROMPT_ONE_PART = 'prtSharedFencePrompt01';
const PLAIN_PART = 'prtSharedFencePlain001';
const PROMPT_TWO_PART = 'prtSharedFencePrompt02';
const FENCE_PART = 'prtSharedFenceCode0001';
const PROMPT_THREE_PART = 'prtSharedFencePrompt03';
const TOOL_PART = 'prtSharedFenceBash0001';
const EXPECTED = [
  PROMPT_ONE_PART,
  PLAIN_PART,
  PROMPT_TWO_PART,
  FENCE_PART,
  PROMPT_THREE_PART,
  TOOL_PART,
];

const T0 = 1_700_500_000_000;

const PLAIN_TEXT = [
  'The helper takes one name and returns one line of text.',
  '',
  'It trims the name first, so extra spaces never reach the greeting.',
].join('\n');

const FENCE_TEXT = [
  'Here is the same helper as code:',
  '',
  '```ts',
  'export function greet(name: string): string {',
  '  return `Hello, ${name.trim()}`;',
  '}',
  '```',
  '',
  'It returns one line, so the transcript renders a single code block.',
].join('\n');

const PROMPT_THREE_TEXT = 'Check the ingest log for the failing shard.';

// Frozen as the tool output the shared viewer reads: long enough that the row
// cannot inline it, and carrying one marker the snapshot assertion can find.
const BASH_OUTPUT = [
  '2026-11-17T09:12:01.114Z INFO  ingest.worker boot pid=4821 version=1.14.2',
  '2026-11-17T09:12:01.118Z INFO  ingest.queue connected stream=session.parts',
  '2026-11-17T09:12:01.204Z INFO  ingest.shard claim shard=us-central1-a consumers=4',
  '2026-11-17T09:12:01.310Z INFO  ingest.shard claim shard=us-central1-b consumers=4',
  '2026-11-17T09:12:01.402Z INFO  ingest.shard claim shard=eu-west-1 consumers=2',
  '2026-11-17T09:12:02.006Z INFO  ingest.batch start batch=batch_9f2c docs=512 bytes=1884112',
  '2026-11-17T09:12:02.114Z INFO  ingest.batch persist batch=batch_9f2c rows=512 ms=108',
  '2026-11-17T09:12:02.201Z INFO  ingest.batch ack batch=batch_9f2c',
  '2026-11-17T09:12:02.309Z INFO  ingest.batch start batch=batch_9f2d docs=498 bytes=1802112',
  '2026-11-17T09:12:02.412Z INFO  ingest.batch persist batch=batch_9f2d rows=498 ms=103',
  '2026-11-17T09:12:02.518Z INFO  ingest.batch ack batch=batch_9f2d',
  '2026-11-17T09:12:03.011Z WARN  ingest.chunk retry attempt=1 batch=batch_9f2e',
  '2026-11-17T09:12:03.148Z WARN  ingest.chunk retry attempt=2 batch=batch_9f2e',
  '2026-11-17T09:12:03.302Z ERROR ingest.chunk failed batch=batch_9f2e cause=queue_timeout',
  '2026-11-17T09:12:03.401Z WARN  ingest.shard backlog shard=eu-west-1 depth=128',
  '2026-11-17T09:12:03.512Z WARN  ingest.shard backlog shard=eu-west-1 depth=256',
  '2026-11-17T09:12:03.604Z WARN  ingest.shard backlog shard=eu-west-1 depth=384',
  '2026-11-17T09:12:04.002Z INFO  ingest.shard.rebalance from=us-central1-a to=eu-west-1',
  '2026-11-17T09:12:04.111Z INFO  ingest.consumer start shard=eu-west-1 id=consumer-17',
  '2026-11-17T09:12:04.208Z INFO  ingest.consumer start shard=eu-west-1 id=consumer-18',
  '2026-11-17T09:12:04.319Z INFO  ingest.batch start batch=batch_9f2f docs=512 bytes=1901224',
  '2026-11-17T09:12:04.427Z INFO  ingest.batch persist batch=batch_9f2f rows=512 ms=108',
  '2026-11-17T09:12:04.533Z INFO  ingest.batch ack batch=batch_9f2f',
  '2026-11-17T09:12:05.011Z INFO  ingest.batch start batch=batch_9f30 docs=512 bytes=1897440',
  '2026-11-17T09:12:05.118Z INFO  ingest.batch persist batch=batch_9f30 rows=512 ms=107',
  '2026-11-17T09:12:05.226Z INFO  ingest.batch ack batch=batch_9f30',
  '2026-11-17T09:12:05.341Z INFO  ingest.shard backlog shard=eu-west-1 depth=192',
  '2026-11-17T09:12:05.455Z INFO  ingest.shard backlog shard=eu-west-1 depth=64',
  '2026-11-17T09:12:05.602Z INFO  ingest.shard backlog shard=eu-west-1 depth=0',
  '2026-11-17T09:12:06.004Z INFO  ingest.chunk replay batch=batch_9f2e attempt=3',
  '2026-11-17T09:12:06.121Z INFO  ingest.batch persist batch=batch_9f2e rows=311 ms=117',
  '2026-11-17T09:12:06.230Z INFO  ingest.batch ack batch=batch_9f2e',
  '2026-11-17T09:12:06.402Z INFO  ingest.shard report shard=us-central1-a lag_ms=4',
  '2026-11-17T09:12:06.511Z INFO  ingest.shard report shard=us-central1-b lag_ms=3',
  '2026-11-17T09:12:06.620Z INFO  ingest.shard report shard=eu-west-1 lag_ms=0',
  '2026-11-17T09:12:07.002Z INFO  ingest.queue heartbeat consumers=10 inflight=0',
  '2026-11-17T09:12:07.118Z INFO  ingest.worker usage rss_mb=214 heap_mb=96',
  '2026-11-17T09:12:07.402Z INFO  ingest.shard audit shard=eu-west-1 lag_ms=0 — healthy',
  '2026-11-17T09:12:07.511Z INFO  ingest.queue heartbeat consumers=10 inflight=0',
  '2026-11-17T09:12:07.620Z INFO  ingest.worker usage rss_mb=214 heap_mb=96',
  '2026-11-17T09:12:08.004Z INFO  ingest.batch start batch=batch_9f31 docs=88 bytes=320144',
  '2026-11-17T09:12:08.112Z INFO  ingest.batch persist batch=batch_9f31 rows=88 ms=82',
  '2026-11-17T09:12:08.221Z INFO  ingest.batch ack batch=batch_9f31',
  '2026-11-17T09:12:08.330Z INFO  ingest.worker idle shards=3 consumers=10',
].join('\n');

const PROMPT_THREE_AT = T0 + 120_000;
const TOOL_ASSISTANT_AT = T0 + 121_000;
const TOOL_START = T0 + 121_500;
const TOOL_END = T0 + 128_500;
const TOOL_ASSISTANT_DONE = T0 + 129_000;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-shared-transcript ${usage}`);
  console.log('');
  console.log('Seeds one public shared transcript through the local cloudflare-session-ingest');
  console.log(
    'worker: three assistant replies — one plain, one with a fenced ts code block, and one'
  );
  console.log('with a completed bash tool call whose frozen output is too long to read inline.');
  console.log('Resets only its own session.');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:mobile-shared-transcript ada@example.com');
}

function textPart(id: string, text: string, messageID: string): SessionIngestItem {
  return {
    type: 'part',
    data: { id, sessionID: SESSION_ID, messageID, type: 'text', text },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function waitForParts(baseUrl: string, token: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch(`${baseUrl}/api/session/${SESSION_ID}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`messages read failed (${response.status})`);
    const payload: unknown = await response.json();
    const seen = new Set<string>();
    if (isRecord(payload) && isRecord(payload.history) && Array.isArray(payload.history.messages)) {
      for (const message of payload.history.messages) {
        if (!isRecord(message) || !Array.isArray(message.parts)) continue;
        for (const part of message.parts) {
          if (isRecord(part) && typeof part.id === 'string') seen.add(part.id);
        }
      }
    }
    if (EXPECTED.every(id => seen.has(id))) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for shared transcript parts');
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

  assertLocalSeedDatabase('app:mobile-shared-transcript');
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

  // The share capability lives on the session row (`public_id`), so deleting the
  // row retires the link a previous run minted.
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
    ...seedTokenSigningParams(3600),
    extra: user.isAdmin ? { isAdmin: true } : undefined,
  });

  const items: SessionIngestItem[] = [
    buildSessionItem({
      sessionId: SESSION_ID,
      slug: 'shared-transcript-fixture',
      title: SESSION_TITLE,
    }),
    buildUserMessageItem({
      messageId: PROMPT_ONE_ID,
      sessionId: SESSION_ID,
      createdAt: T0,
    }),
    buildAssistantMessageItem({
      messageId: PLAIN_ASSISTANT_ID,
      sessionId: SESSION_ID,
      parentId: PROMPT_ONE_ID,
      createdAt: T0 + 1_000,
      completedAt: T0 + 2_000,
      cost: 0.01,
      tokens: { total: 90, input: 70, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    textPart(
      PROMPT_ONE_PART,
      'Describe the helper you would write for this fixture.',
      PROMPT_ONE_ID
    ),
    textPart(PLAIN_PART, PLAIN_TEXT, PLAIN_ASSISTANT_ID),
    buildUserMessageItem({
      messageId: PROMPT_TWO_ID,
      sessionId: SESSION_ID,
      createdAt: T0 + 60_000,
    }),
    buildAssistantMessageItem({
      messageId: FENCE_ASSISTANT_ID,
      sessionId: SESSION_ID,
      parentId: PROMPT_TWO_ID,
      createdAt: T0 + 61_000,
      completedAt: T0 + 62_000,
      cost: 0.01,
      tokens: { total: 120, input: 90, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    textPart(PROMPT_TWO_PART, 'Now show the same helper as code.', PROMPT_TWO_ID),
    textPart(FENCE_PART, FENCE_TEXT, FENCE_ASSISTANT_ID),
    buildUserMessageItem({
      messageId: PROMPT_THREE_ID,
      sessionId: SESSION_ID,
      createdAt: PROMPT_THREE_AT,
    }),
    buildAssistantMessageItem({
      messageId: TOOL_ASSISTANT_ID,
      sessionId: SESSION_ID,
      parentId: PROMPT_THREE_ID,
      createdAt: TOOL_ASSISTANT_AT,
      completedAt: TOOL_ASSISTANT_DONE,
      cost: 0.01,
      tokens: { total: 210, input: 150, output: 60, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    textPart(PROMPT_THREE_PART, PROMPT_THREE_TEXT, PROMPT_THREE_ID),
    buildToolPartItem({
      partId: TOOL_PART,
      sessionId: SESSION_ID,
      messageId: TOOL_ASSISTANT_ID,
      callId: 'callSharedFenceBash01',
      tool: 'bash',
      status: 'completed',
      input: { command: 'tail -n 40 /workspace/logs/ingest.log' },
      output: BASH_OUTPUT,
      title: 'Read the ingest log tail',
      metadata: { exitCode: 0, lines: 44 },
      start: TOOL_START,
      end: TOOL_END,
    }),
  ];

  const ingestResponse = await fetch(`${baseUrl}/api/session/${SESSION_ID}/ingest?v=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: items }),
  });
  if (!ingestResponse.ok) {
    throw new Error(`ingest failed (${ingestResponse.status}): ${await ingestResponse.text()}`);
  }
  await waitForParts(baseUrl, token);

  // Publish through the real path: the worker freezes nothing at all for a live
  // share, sets `cli_sessions_v2.public_id` and mints the capability token.
  const shareResponse = await fetch(`${baseUrl}/api/session/${SESSION_ID}/share`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ duration: 'forever', include_new_messages: true }),
  });
  if (!shareResponse.ok) {
    throw new Error(`share failed (${shareResponse.status}): ${await shareResponse.text()}`);
  }
  const sharePayload: unknown = await shareResponse.json();
  if (!isRecord(sharePayload) || typeof sharePayload.share_token !== 'string') {
    throw new Error('share response did not include a share token');
  }
  const shareToken = sharePayload.share_token;

  // Prove the read the app performs resolves: same URLs and headers the shared
  // viewer uses, with no session of its own.
  const metadataResponse = await fetch(
    `${baseUrl}/session/${encodeURIComponent(shareToken)}/metadata`
  );
  if (!metadataResponse.ok) {
    throw new Error(`shared metadata read failed (${metadataResponse.status})`);
  }
  const metadata: unknown = await metadataResponse.json();
  if (
    !isRecord(metadata) ||
    metadata.title !== SESSION_TITLE ||
    typeof metadata.owner_name !== 'string' ||
    metadata.owner_name === ''
  ) {
    throw new Error('shared metadata did not describe the fixture session');
  }
  const snapshotResponse = await fetch(`${baseUrl}/session/${encodeURIComponent(shareToken)}`);
  if (!snapshotResponse.ok) {
    throw new Error(`shared snapshot read failed (${snapshotResponse.status})`);
  }
  const snapshot = await snapshotResponse.text();
  if (!snapshot.includes('```ts')) {
    throw new Error('shared snapshot does not include the fenced ts block');
  }
  if (!snapshot.includes('ingest.shard.rebalance')) {
    throw new Error('shared snapshot does not include the bash tool output');
  }
  if (!snapshot.includes(TOOL_PART)) {
    throw new Error('shared snapshot does not include the bash tool part');
  }

  console.log(
    'This fixture represents: one public shared transcript with three assistant replies — one plain, one with a fenced ts code block, and one with a completed bash tool call whose output is too long to read inline — read through the session-ingest share token, not through the owner session.'
  );
  console.log(
    'Published through the real worker share endpoint (POST /api/session/<id>/share with duration=forever and include_new_messages=true), which sets cli_sessions_v2.public_id and mints the capability.'
  );
  console.log(
    'Note: the worker mints a fresh share token on every run, so a rerun rotates the link; the token in the Result block is the live one.'
  );
  console.log(
    'Suggested next step: open the deep link on a signed-in dev build. It carries the web share path, which the app maps to the shared transcript screen.'
  );
  return {
    userId: user.id,
    sessionId: SESSION_ID,
    shareToken,
    deepLink: `kiloapp:///s/${shareToken}`,
    transcriptUrl: `${baseUrl}/session/${encodeURIComponent(shareToken)}`,
  };
}
