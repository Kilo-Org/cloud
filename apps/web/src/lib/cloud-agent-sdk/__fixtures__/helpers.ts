import type { CloudAgentEvent } from '@/lib/cloud-agent-next/event-types';

function createEventHelpers() {
  let eventCounter = 0;

  function resetCounter() {
    eventCounter = 0;
  }

  function createEvent(
    streamEventType: string,
    data: unknown,
    sessionId = 'ses-1'
  ): CloudAgentEvent {
    return {
      eventId: ++eventCounter,
      executionId: 'exec-1',
      sessionId,
      streamEventType,
      timestamp: new Date().toISOString(),
      data,
    };
  }

  function kilocode(type: string, properties: unknown, sessionId = 'ses-1'): CloudAgentEvent {
    return createEvent('kilocode', { type, properties }, sessionId);
  }

  return { createEvent, kilocode, resetCounter };
}

const sessionInfo = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  slug: 's',
  projectID: 'p',
  directory: '/t',
  title: 'T',
  version: '1',
  time: { created: 1, updated: 1 },
  ...overrides,
});

const userMsg = (id: string, sessionID = 'ses-1', overrides: Record<string, unknown> = {}) => ({
  id,
  sessionID,
  role: 'user',
  time: { created: 1 },
  agent: 'build',
  model: { providerID: 'a', modelID: 'b' },
  ...overrides,
});

const assistantMsg = (
  id: string,
  parentID: string,
  sessionID = 'ses-1',
  overrides: Record<string, unknown> = {}
) => ({
  id,
  sessionID,
  role: 'assistant',
  time: { created: 2 },
  parentID,
  modelID: 'claude',
  providerID: 'anthropic',
  mode: 'code',
  agent: 'build',
  path: { cwd: '/', root: '/' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...overrides,
});

const textPart = (id: string, messageID: string, text: string, sessionID = 'ses-1') => ({
  id,
  sessionID,
  messageID,
  type: 'text',
  text,
});

const toolPart = (
  id: string,
  messageID: string,
  tool: string,
  sessionID = 'ses-1',
  overrides: Record<string, unknown> = {}
) => ({
  id,
  sessionID,
  messageID,
  type: 'tool',
  tool,
  callID: `call-${id}`,
  state: { status: 'pending', input: {}, raw: '' },
  ...overrides,
});

const stepStartPart = (id: string, messageID: string, sessionID = 'ses-1') => ({
  id,
  sessionID,
  messageID,
  type: 'step-start',
  snapshot: 'snapshot-hash',
});

export {
  createEventHelpers,
  sessionInfo,
  userMsg,
  assistantMsg,
  textPart,
  toolPart,
  stepStartPart,
};
