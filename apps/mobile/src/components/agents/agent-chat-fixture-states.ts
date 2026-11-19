import { type StandalonePermission, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { AGENT_CHAT_FIXTURE_SESSION_ID } from './agent-chat-fixture-session';

/** The bash ask a pending-permission fixture waits on, scoped like a real one. */
export const PENDING_BASH_ASK: StandalonePermission = {
  requestId: 'per_designGateBash',
  permission: 'bash',
  patterns: ['pnpm test'],
  metadata: { command: 'pnpm test' },
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
      state: { status: 'running', input: { command: 'pnpm test' }, time: { start: 1 } },
    },
  ],
};
