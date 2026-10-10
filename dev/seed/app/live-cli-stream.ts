import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildToolPartItem,
  buildUserMessageItem,
  MODEL_ID,
  MODEL_PROVIDER_ID,
  FIXTURE_AGENT,
  FIXTURE_DIRECTORY,
  FIXTURE_MODE,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';

export const usage = '<email> [seconds] [deltaIntervalMs] [historyTurns] [historyCharsPerTurn]';

// 30 chars: ses_ + 26.
const SESSION_ID = 'ses_00000000000LiveCliStream01';
const SESSION_TITLE = 'Live CLI stream fixture';
const USER_ID = 'msgLiveCliUser00001';
const ASSISTANT_ID = 'msgLiveCliAsst00001';
const PART_ID = 'prtLiveCliText00001';
const DEFAULT_SECONDS = 90;
const DEFAULT_DELTA_INTERVAL_MS = 40;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HISTORY_TURN_COUNT = 40;

// One streamed assistant answer: prose, a list and code fences, so the row
// grows by whole lines and by fence chunks the way a real agent turn does.
const STREAM_BLOCK = [
  'Checking the repository layout and the failing test before I change anything.',
  '',
  '- read `src/index.ts` and its imports',
  '- run the focused suite',
  '- patch the reducer and re-run',
  '',
  '```ts',
  'export function reduce(state: State, event: Event): State {',
  "  if (event.type === 'reset') return initialState;",
  '  return { ...state, count: state.count + 1 };',
  '}',
  '```',
  '',
].join('\n');

// A long history turn that mirrors a real session: a `read` tool call whose
// output is the bulk of the transcript, plus the assistant's prose. Real
// production sessions carry pages of hundreds of kilobytes, so the history
// size is what makes a session screen's list do the virtualisation work that
// exposes a render loop.
function bulkText(turn: number, chars: number): string {
  const line = `// turn ${turn} generated source line for fixture padding`;
  const body: string[] = [];
  let length = 0;
  while (length < chars) {
    body.push(`${line} ${body.length}`);
    length += line.length + 8;
  }
  return body.join('\n');
}

function historyTurnItems(params: {
  turn: number;
  charsPerTurn: number;
  createdAt: number;
}): SessionIngestItem[] {
  const pad = String(params.turn).padStart(4, '0');
  const userId = `msgLiveCliHistU${pad}`;
  const assistantId = `msgLiveCliHistA${pad}`;
  const items: SessionIngestItem[] = [
    buildUserMessageItem({ messageId: userId, sessionId: SESSION_ID, createdAt: params.createdAt }),
    buildAssistantMessageItem({
      messageId: assistantId,
      sessionId: SESSION_ID,
      parentId: userId,
      createdAt: params.createdAt + 1_000,
      completedAt: params.createdAt + 30_000,
      cost: 0.01,
      tokens: { total: 100, input: 80, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    {
      type: 'part' as const,
      data: {
        id: `prtLiveCliHistT${pad}`,
        sessionID: SESSION_ID,
        messageID: assistantId,
        type: 'text',
        text: `Turn ${params.turn}.\n\n${STREAM_BLOCK}`,
      },
    },
  ];
  const bulk = bulkText(params.turn, params.charsPerTurn);
  if (bulk.length > 0) {
    items.push(
      buildToolPartItem({
        partId: `prtLiveCliHistR${pad}`,
        sessionId: SESSION_ID,
        messageId: assistantId,
        callId: `callLiveCliHist${pad}`,
        tool: 'read',
        status: 'completed',
        input: { filePath: `/workspace/src/turn-${params.turn}.ts` },
        output: bulk,
        title: `read src/turn-${params.turn}.ts`,
        metadata: {},
        start: params.createdAt + 2_000,
        end: params.createdAt + 3_000,
      })
    );
  }
  return items;
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:live-cli-stream ${usage}`);
  console.log('');
  console.log('Seeds one CLI session and then acts as its connected `kilo` CLI: it');
  console.log('heartbeats the session as busy and streams assistant text deltas over');
  console.log('the local session-ingest /api/user/cli socket for [seconds] (default 90),');
  console.log('one delta every [deltaIntervalMs] (default 40; lower it to load a fast device');
  console.log('the way a slow device is loaded). Open the deep link on a signed-in dev build');
  console.log('while it runs.');
  console.log('[historyTurns] finished turns to seed before the live one (default 40)');
  console.log('[historyCharsPerTurn] adds a `read` tool part of about that many');
  console.log('characters to each history turn, so a 600 KB production transcript can be');
  console.log('reproduced (default 0).');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:live-cli-stream ada@example.com 120 5 150 4000');
}

function openCliSocket(url: string, token: string): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  socket.addEventListener('open', () => resolve(socket), { once: true });
  socket.addEventListener('error', () => reject(new Error('CLI socket failed to open')), {
    once: true,
  });
  return promise;
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
  const seconds = args[1] ? Number.parseInt(args[1], 10) : DEFAULT_SECONDS;
  const deltaIntervalMs = args[2] ? Number.parseInt(args[2], 10) : DEFAULT_DELTA_INTERVAL_MS;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('seconds must be a positive integer');
  }
  if (!Number.isFinite(deltaIntervalMs) || deltaIntervalMs < 0) {
    throw new Error('deltaIntervalMs must be a non-negative integer');
  }
  const historyTurnCount = args[3] ? Number.parseInt(args[3], 10) : HISTORY_TURN_COUNT;
  const historyCharsPerTurn = args[4] ? Number.parseInt(args[4], 10) : 0;
  if (!Number.isFinite(historyTurnCount) || historyTurnCount <= 0) {
    throw new Error('historyTurns must be a positive integer');
  }
  if (!Number.isFinite(historyCharsPerTurn) || historyCharsPerTurn < 0) {
    throw new Error('historyCharsPerTurn must be a non-negative integer');
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
    expiresInSeconds: seconds + 600,
    env: process.env.NODE_ENV ?? 'development',
    extra: user.isAdmin ? { isAdmin: true } : undefined,
  });

  const startedAt = Date.now();
  // Finished turns before the live one, so the transcript is taller than the
  // viewport and the list virtualizes rows the way a long real session does.
  const history = Array.from({ length: historyTurnCount }, (_, turn) =>
    historyTurnItems({
      turn,
      charsPerTurn: historyCharsPerTurn,
      createdAt: startedAt - (historyTurnCount - turn) * 60_000,
    })
  ).flat();
  const ingest = await fetch(`${baseUrl}/api/session/${SESSION_ID}/ingest?v=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [
        buildSessionItem({ sessionId: SESSION_ID, slug: 'live-cli-stream', title: SESSION_TITLE }),
        ...history,
        buildUserMessageItem({ messageId: USER_ID, sessionId: SESSION_ID, createdAt: startedAt }),
      ],
    }),
  });
  if (!ingest.ok) {
    throw new Error(`ingest failed (${ingest.status}): ${await ingest.text()}`);
  }

  const socket = await openCliSocket(`${baseUrl.replace('http', 'ws')}/api/user/cli`, token);
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  const event = (name: string, data: unknown) =>
    send({ type: 'event', sessionId: SESSION_ID, event: name, data });
  const heartbeat = (sessionStatus: string) =>
    send({
      type: 'heartbeat',
      protocolVersion: '1',
      sessions: [{ id: SESSION_ID, status: sessionStatus, title: SESSION_TITLE }],
    });

  const assistantInfo = {
    id: ASSISTANT_ID,
    sessionID: SESSION_ID,
    role: 'assistant',
    time: { created: startedAt + 500 },
    parentID: USER_ID,
    modelID: MODEL_ID,
    providerID: MODEL_PROVIDER_ID,
    mode: FIXTURE_MODE,
    agent: FIXTURE_AGENT,
    path: { cwd: FIXTURE_DIRECTORY, root: FIXTURE_DIRECTORY },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  let text = '';
  // A viewer subscribes after the turn started, so like the real CLI this
  // replays the live turn (status, message, part so far) on every subscribe;
  // later deltas then extend a part the viewer already holds.
  const replayTurn = () => {
    event('session.status', { sessionID: SESSION_ID, status: { type: 'busy' } });
    event('message.updated', { info: assistantInfo });
    event('message.part.updated', {
      part: { id: PART_ID, sessionID: SESSION_ID, messageID: ASSISTANT_ID, type: 'text', text },
    });
  };
  socket.addEventListener('message', message => {
    const parsed: unknown = JSON.parse(String(message.data));
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      if (parsed.type === 'subscribe') replayTurn();
    }
  });

  heartbeat('busy');
  const heartbeatTimer = setInterval(() => heartbeat('busy'), HEARTBEAT_INTERVAL_MS);
  try {
    replayTurn();

    console.log(`Streaming for ${seconds}s. Open kiloapp://agent-chat/${SESSION_ID} now.`);
    let cursor = 0;
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      // A few characters per delta, word-sized like a model token.
      const delta = STREAM_BLOCK.slice(cursor, cursor + 6);
      cursor = (cursor + 6) % STREAM_BLOCK.length;
      text += delta;
      event('message.part.delta', {
        sessionID: SESSION_ID,
        messageID: ASSISTANT_ID,
        partID: PART_ID,
        field: 'text',
        delta,
      });
      await sleep(deltaIntervalMs);
    }

    event('message.part.updated', {
      part: { id: PART_ID, sessionID: SESSION_ID, messageID: ASSISTANT_ID, type: 'text', text },
    });
    // Stop the cadence before the idle status, so a tick cannot land inside the
    // grace window below and overwrite it with a 'busy' heartbeat.
    clearInterval(heartbeatTimer);
    event('session.status', { sessionID: SESSION_ID, status: { type: 'idle' } });
    heartbeat('idle');
    await sleep(1_000);
  } finally {
    // The clear above covers the success path; this one covers a stream that
    // threw. The interval or the socket left open keeps the event loop alive,
    // so the seed would hang instead of exiting with the error.
    clearInterval(heartbeatTimer);
    socket.close();
  }

  console.log(
    'This fixture represents: a CLI session whose connected CLI streams one long assistant answer as text deltas.'
  );
  return {
    userId: user.id,
    sessionId: SESSION_ID,
    streamedChars: text.length,
    deepLink: `kiloapp://agent-chat/${SESSION_ID}`,
  };
}
