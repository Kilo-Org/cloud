import {
  type StandalonePermission,
  type StoredMessage,
  type UnreadableQuestionState,
} from '@kilocode/cloud-agent-sdk';

import { AGENT_CHAT_FIXTURE_SESSION_ID } from './agent-chat-fixture-session';

/**
 * The still states the agent chat fixture can hold, one per design-gate target.
 * The plain screen is `idle`; `pending-permission` holds the same screen behind
 * a bash ask, so the row that reports the agent's activity can be compared
 * while the agent waits for the answer; `running` holds the same blocked
 * transcript with the ask answered, which is the row the wait returns to.
 * `permission-failed` holds the pending-permission screen too, but the first
 * answer to the bash ask fails like a transient transport error, so the card
 * shows its retryable failure branch, and a later answer — the Retry tap —
 * succeeds. `pending-unreadable-question` holds the idle transcript with a
 * question request this app could not read: the notice names the wait and the
 * CLI as the place to answer it, and no answer card is drawn.
 *
 * The type lives here, beside the fixtures it selects, so the screen's manager
 * factory stays within its file budget.
 */
export type AgentChatFixtureState =
  | 'idle'
  | 'pending-permission'
  | 'permission-failed'
  | 'running'
  | 'pending-unreadable-question';

/**
 * The unreadable-question notices each state holds. Only the state whose whole
 * point is the notice carries one; every other state carries none, so a cell
 * shows the notice exactly when its target asks for it.
 */
const FIXTURE_UNREADABLE_QUESTIONS = {
  idle: [],
  'pending-permission': [],
  'permission-failed': [],
  running: [],
  'pending-unreadable-question': [{ requestId: 'que_designGateUnreadable' }],
} satisfies Record<AgentChatFixtureState, UnreadableQuestionState[]>;

/** The notices one state carries, in the shape the manager's atom holds. */
export function fixtureUnreadableQuestions(
  state: AgentChatFixtureState
): readonly UnreadableQuestionState[] {
  return FIXTURE_UNREADABLE_QUESTIONS[state];
}

/** The bash ask a pending-permission fixture waits on, scoped like a real one. */
export const PENDING_BASH_ASK: StandalonePermission = {
  requestId: 'per_designGateBash',
  permission: 'bash',
  patterns: ['pnpm test *'],
  metadata: { command: 'pnpm test --filter api' },
  always: [],
};

/** The assistant emoji turn: a wrapped paragraph whose symbols need font fallback. */
export const EMOJI_ANSWER: StoredMessage = {
  info: {
    id: 'msg_designGateEmoji',
    sessionID: AGENT_CHAT_FIXTURE_SESSION_ID,
    role: 'assistant',
    time: { created: 1_700_000_020_000, completed: 1_700_000_025_000 },
    parentID: 'msg_designGateAnswer',
    modelID: 'auto-efficient',
    providerID: 'kilo',
    mode: 'code',
    agent: 'code',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0.0004,
    tokens: { input: 300, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [
    {
      id: 'prt_designGateEmoji',
      sessionID: AGENT_CHAT_FIXTURE_SESSION_ID,
      messageID: 'msg_designGateEmoji',
      type: 'text',
      text: 'Emoji wrap check with a long wrapped paragraph: the deploy pipeline pushes the bundle to the staging environment, waits for the database migration to finish, runs the smoke suite, and only then flips the traffic switch. Status symbols render inline through font fallback: ✅ done ❌ pending ⭐ reviewed ⏰ queued 😀 ready to merge, so a regression that slips through shows up on staging first and the rollback stays one command away for every service that reads the shared configuration blob.',
    },
  ],
};

/** The command the pending ask holds: a running bash part the agent cannot start. */
export const BLOCKED_BASH_COMMAND: StoredMessage = {
  info: {
    id: 'msg_designGateBlocked',
    sessionID: AGENT_CHAT_FIXTURE_SESSION_ID,
    role: 'assistant',
    time: { created: 1_700_000_120_000 },
    parentID: 'msg_designGateAnswer',
    modelID: 'auto-efficient',
    providerID: 'kilo',
    mode: 'code',
    agent: 'code',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0.0012,
    tokens: { input: 1600, output: 410, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [
    {
      id: 'prt_designGateBlocked',
      sessionID: AGENT_CHAT_FIXTURE_SESSION_ID,
      messageID: 'msg_designGateBlocked',
      type: 'tool',
      callID: 'call_designGateBlocked',
      tool: 'bash',
      state: {
        status: 'running',
        input: { command: 'pnpm test --filter api' },
        time: { start: 1 },
      },
    },
  ],
};
