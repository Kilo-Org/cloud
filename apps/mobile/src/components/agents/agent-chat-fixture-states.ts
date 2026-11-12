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
