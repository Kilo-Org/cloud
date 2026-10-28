import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq, sql } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { getSeedDb } from '../lib/db';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildToolPartItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';

export const usage = '<email> [seconds]';

const DEFAULT_SECONDS = 900;
const HEARTBEAT_INTERVAL_MS = 5_000;

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
type Todo = { content: string; status: TodoStatus; priority: 'high' | 'medium' | 'low' };

type Scenario = {
  key: string;
  /** 30 chars: ses_ + 26. app:session-pr-link links only `ses_e2epr` ids. */
  sessionId: string;
  title: string;
  goal: { text: string; status: 'active' } | null;
  /** The open PR app:session-pr-link links to the session; each on its own branch. */
  pr: { number: number; branch: string; headSha: string } | null;
  /** Every `todowrite` the model sent, oldest first; the newest one is the current list. */
  todoWrites: Todo[][];
};

const PLAN: Todo[] = [
  { content: 'Read the reports page and its data hooks', status: 'pending', priority: 'high' },
  { content: 'Add the CSV serializer', status: 'pending', priority: 'high' },
  { content: 'Wire the Export button', status: 'pending', priority: 'high' },
  { content: 'Stream large exports in chunks', status: 'pending', priority: 'medium' },
  { content: 'Add serializer tests', status: 'pending', priority: 'medium' },
  { content: 'Support XLSX', status: 'pending', priority: 'low' },
  { content: 'Update the changelog', status: 'pending', priority: 'low' },
];

function withStatuses(statuses: TodoStatus[]): Todo[] {
  return PLAN.slice(0, statuses.length).map((todo, index) => ({
    ...todo,
    status: statuses[index] ?? 'pending',
  }));
}

// 3 done, 1 running, 2 pending, 1 cancelled: the chip reads 3/6.
const IN_PROGRESS = withStatuses([
  'completed',
  'completed',
  'completed',
  'in_progress',
  'pending',
  'cancelled',
  'pending',
]);
const ALL_DONE = withStatuses([
  'completed',
  'completed',
  'completed',
  'completed',
  'completed',
  'cancelled',
  'completed',
]);
const INITIAL = withStatuses(PLAN.map(() => 'pending'));
const GOAL = {
  text: 'Ship CSV export for the reports page, with tests, behind the existing Export button',
  status: 'active' as const,
};

const SCENARIOS: Scenario[] = [
  {
    key: 'goalPr',
    sessionId: 'ses_e2eprtasksgoalpr0000000002',
    title: 'Tasks: goal, PR, open tasks',
    goal: GOAL,
    pr: { number: 41, branch: 'feat/csv-export', headSha: '1'.repeat(40) },
    todoWrites: [INITIAL, IN_PROGRESS],
  },
  {
    key: 'goalNoPr',
    sessionId: 'ses_e2etasksgoalnopr0000000002',
    title: 'Tasks: goal, no PR, open tasks',
    goal: GOAL,
    pr: null,
    todoWrites: [INITIAL, withStatuses(['completed', 'in_progress', 'pending', 'pending'])],
  },
  {
    key: 'noGoal',
    sessionId: 'ses_e2etasksnogoal000000000002',
    title: 'Tasks: no goal, open tasks',
    goal: null,
    pr: null,
    todoWrites: [
      INITIAL,
      withStatuses(['completed', 'completed', 'in_progress', 'pending', 'pending']),
    ],
  },
  {
    key: 'goalPrDone',
    sessionId: 'ses_e2eprtasksdonegoal00000002',
    title: 'Tasks: goal, PR, all tasks done',
    goal: GOAL,
    pr: { number: 42, branch: 'feat/csv-done', headSha: '2'.repeat(40) },
    todoWrites: [INITIAL, IN_PROGRESS, ALL_DONE],
  },
  {
    key: 'noGoalDone',
    sessionId: 'ses_e2etasksdonenogoal00000002',
    title: 'Tasks: no goal, all tasks done',
    goal: null,
    pr: null,
    todoWrites: [INITIAL, IN_PROGRESS, ALL_DONE],
  },
];

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:session-tasks ${usage}`);
  console.log('');
  console.log('Seeds five CLI sessions whose model kept a todo list (`todowrite` tool parts),');
  console.log('then acts as their connected `kilo` CLI: it heartbeats every session as idle');
  console.log('over the local session-ingest /api/user/cli socket for [seconds] (default 900),');
  console.log('so the app resolves them as remote sessions and shows the goal row.');
  console.log('');
  console.log(
    '  goalPr      active goal, PR, latest list 3/6 open   (task chip under the PR pill)'
  );
  console.log('  goalNoPr    active goal, no PR, latest list 1/4     (task chip alone)');
  console.log('  noGoal      no goal, latest list 2/5                (Tasks row under the header)');
  console.log('  goalPrDone  active goal, PR, latest list all done   (PR pill only, no chip)');
  console.log('  noGoalDone  no goal, latest list all done           (no Tasks row)');
  console.log('');
  console.log('The goal is session metadata (`kilo.goal`), the way the CLI stores it. The two');
  console.log('PR sessions get an open GitHub PR through app:session-pr-link.');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:session-tasks ada@example.com 1800');
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

/** The `todowrite` part the CLI records: todos in input and metadata, JSON output, open count title. */
function todoWritePart(params: {
  scenario: Scenario;
  index: number;
  messageId: string;
  todos: Todo[];
  start: number;
}): SessionIngestItem {
  const open = params.todos.filter(todo => todo.status !== 'completed').length;
  // Ids ascend in transcript order, the way the CLI mints them; the ingest sorts by id.
  const ordinal = `${params.index}1`;
  return buildToolPartItem({
    partId: `prt${params.scenario.key}${ordinal}`,
    sessionId: params.scenario.sessionId,
    messageId: params.messageId,
    callId: `call${params.scenario.key}Todo${ordinal}`,
    tool: 'todowrite',
    input: { todos: params.todos },
    output: JSON.stringify(params.todos, null, 2),
    title: `${open} todos`,
    metadata: { todos: params.todos, truncated: false },
    start: params.start,
    end: params.start + 40,
  });
}

function scenarioItems(scenario: Scenario, startedAt: number): SessionIngestItem[] {
  const session = buildSessionItem({
    sessionId: scenario.sessionId,
    slug: scenario.key,
    title: scenario.title,
  });
  const sessionWithGoal: SessionIngestItem = {
    type: 'session',
    data: {
      ...session.data,
      ...(scenario.goal === null ? {} : { metadata: { 'kilo.goal': scenario.goal } }),
    },
  };
  const items: SessionIngestItem[] = [sessionWithGoal];
  // One user turn per todowrite: the model replaces the whole list each turn.
  scenario.todoWrites.forEach((todos, index) => {
    const turnAt = startedAt - (scenario.todoWrites.length - index) * 60_000;
    const userId = `msg${scenario.key}${index}0`;
    const assistantId = `msg${scenario.key}${index}1`;
    items.push(
      buildUserMessageItem({ messageId: userId, sessionId: scenario.sessionId, createdAt: turnAt }),
      buildAssistantMessageItem({
        messageId: assistantId,
        sessionId: scenario.sessionId,
        parentId: userId,
        createdAt: turnAt + 500,
        completedAt: turnAt + 5_000,
        cost: 0.01,
        tokens: {
          total: 1200,
          input: 1000,
          output: 200,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
      {
        type: 'part',
        data: {
          id: `prt${scenario.key}${index}0`,
          sessionID: scenario.sessionId,
          messageID: userId,
          type: 'text',
          text: index === 0 ? 'Add CSV export to the reports page.' : 'Continue.',
        },
      },
      todoWritePart({ scenario, index, messageId: assistantId, todos, start: turnAt + 1_000 })
    );
  });
  return items;
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
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('seconds must be a positive integer');
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

  const { token } = await signKiloToken({
    userId: user.id,
    pepper: user.apiTokenPepper,
    secret,
    expiresInSeconds: seconds + 600,
    env: process.env.NODE_ENV ?? 'development',
    extra: user.isAdmin ? { isAdmin: true } : undefined,
  });

  for (const scenario of SCENARIOS) {
    // Reset the row only. The ingest API's DELETE tombstones the id for good, so
    // reruns keep the stored transcript and the ingest below overwrites every
    // item by its stable id.
    await db
      .delete(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, user.id),
          eq(cli_sessions_v2.session_id, scenario.sessionId)
        )
      );
    if (scenario.pr !== null) {
      execFileSync(
        'pnpm',
        [
          '-s',
          'dev:seed',
          'app:session-pr-link',
          email,
          scenario.sessionId,
          `https://github.com/kilo-stub/reports/pull/${scenario.pr.number}`,
          String(scenario.pr.number),
          'github',
          '--state=open',
          `--title=${scenario.title}`,
          '--git-url=https://github.com/kilo-stub/reports.git',
          `--git-branch=${scenario.pr.branch}`,
          `--head-sha=${scenario.pr.headSha}`,
          '--json',
        ],
        { stdio: 'ignore' }
      );
    }
    // app:session-pr-link names its row after the session id; keep the PR columns.
    await db
      .insert(cli_sessions_v2)
      .values({
        session_id: scenario.sessionId,
        kilo_user_id: user.id,
        title: scenario.title,
        created_on_platform: 'cli',
      } satisfies typeof cli_sessions_v2.$inferInsert)
      .onConflictDoUpdate({
        target: [cli_sessions_v2.session_id, cli_sessions_v2.kilo_user_id],
        set: { title: sql`excluded.title` },
      });
  }

  const startedAt = Date.now();
  for (const scenario of SCENARIOS) {
    const ingest = await fetch(`${baseUrl}/api/session/${scenario.sessionId}/ingest?v=1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: scenarioItems(scenario, startedAt) }),
    });
    if (!ingest.ok) {
      throw new Error(`ingest ${scenario.key} failed (${ingest.status}): ${await ingest.text()}`);
    }
  }

  const socket = await openCliSocket(`${baseUrl.replace('http', 'ws')}/api/user/cli`, token);
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  const heartbeat = () =>
    send({
      type: 'heartbeat',
      protocolVersion: '1',
      sessions: SCENARIOS.map(scenario => ({
        id: scenario.sessionId,
        status: 'idle',
        title: scenario.title,
      })),
    });
  // Like the real CLI, answer each viewer subscribe with the session's status.
  socket.addEventListener('message', message => {
    const parsed: unknown = JSON.parse(String(message.data));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      parsed.type === 'subscribe' &&
      'sessionId' in parsed &&
      typeof parsed.sessionId === 'string'
    ) {
      send({
        type: 'event',
        sessionId: parsed.sessionId,
        event: 'session.status',
        data: { sessionID: parsed.sessionId, status: { type: 'idle' } },
      });
    }
  });

  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  try {
    console.log(`Connected as the CLI for ${seconds}s. Open the deep links below now.`);
    await sleep(seconds * 1000);
  } finally {
    clearInterval(heartbeatTimer);
    socket.close();
  }

  console.log(
    'This fixture represents: five connected CLI sessions whose latest `todowrite` lists are open or done, with and without a goal and a PR.'
  );
  return {
    userId: user.id,
    ...Object.fromEntries(
      SCENARIOS.map(scenario => [
        `${scenario.key}DeepLink`,
        `kiloapp://agent-chat/${scenario.sessionId}`,
      ])
    ),
  };
}
