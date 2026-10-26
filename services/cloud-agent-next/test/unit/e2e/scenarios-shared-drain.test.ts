import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as client from '../../e2e/client.js';
import type { DriverConfig, StreamConnection, StreamEvent } from '../../e2e/client.js';
import type { CallbackSink, ScenarioEnvironment } from '../../e2e/scenario-capabilities.js';

vi.mock('../../e2e/auth.js', () => ({
  mintApiToken: vi.fn(),
  mintStreamTicket: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  startSession: vi.fn(),
  registerSessionCallback: vi.fn(),
  openStream: vi.fn(),
  waitForGateEngaged: vi.fn(),
  releaseGate: vi.fn(),
  interruptSession: vi.fn(),
}));

vi.mock('../../e2e/client.js', async importOriginal => ({
  ...(await importOriginal<typeof client>()),
  ...mocks,
}));

import { DRAIN_SHARED_SCENARIOS } from '../../e2e/scenarios-shared-drain.js';

const config: DriverConfig = {
  workerUrl: 'https://worker.example.test',
  fakeLlmUrl: 'https://fake.example.test',
  user: { id: 'usr_1' },
  skipBalanceCheck: false,
  gitUrl: 'https://example.test/repo.git',
  model: 'kilo/fake-deterministic',
};

function parentReply(): StreamEvent[] {
  return [
    { type: 'message.updated', properties: { info: { id: 'msg_parent', role: 'assistant' } } },
    {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part_parent',
          messageID: 'msg_parent',
          type: 'text',
          text: 'done-drainbg',
        },
      },
    },
  ].map((data, index) => ({
    eventId: index + 1,
    executionId: null,
    sessionId: 'workspace_1',
    streamEventType: 'kilocode',
    timestamp: new Date(0).toISOString(),
    data,
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.startSession.mockResolvedValue({
    cloudAgentSessionId: 'workspace_1',
    kiloSessionId: 'ses_1',
    messageId: 'm1',
  });
  mocks.waitForGateEngaged.mockResolvedValue(true);
  mocks.interruptSession.mockResolvedValue(undefined);
});

describe('background child drain scenario', () => {
  it.each(['missing', 'after subscription', 'replayed'] as const)(
    'requires the parent reply before releasing the child: %s',
    async reply => {
      const events = reply === 'replayed' ? parentReply() : [];
      let released = false;
      const stream: StreamConnection = {
        events,
        close: vi.fn(),
        waitForTerminal: vi.fn(),
        waitFor: async predicate => {
          expect(released).toBe(false);
          if (reply === 'after subscription') events.push(...parentReply());
          return events.find(predicate) ?? null;
        },
        receivedCount: 0,
        isOpen: true,
        closeInfo: null,
      };
      mocks.openStream.mockReturnValue(stream);
      mocks.releaseGate.mockImplementation(async () => {
        released = true;
      });
      const sink: CallbackSink = {
        callbackUrl: 'https://callback.example.test',
        records: async () => [],
        waitFor: async () => {
          expect(events).toEqual(parentReply());
          return released
            ? { cloudAgentSessionId: 'workspace_1', messageId: 'm1', status: 'completed' }
            : null;
        },
        close: async () => {},
      };
      const env: ScenarioEnvironment = {
        profile: 'local',
        requireControlPlaneSession: true,
        callbacks: { open: async () => sink },
        sessionSandbox: {
          waitForContainer: async () => 'container_1',
          currentContainer: async () => 'container_1',
        },
      };
      const result = await DRAIN_SHARED_SCENARIOS['drain-background-child'].run(
        { config, conversation: '_', timeoutMs: 1_000 },
        env
      );
      expect(result.ok).toBe(reply !== 'missing');
      expect(released).toBe(reply !== 'missing');
      if (reply === 'missing') expect(result.message).toContain('parent did not reply');
      expect(mocks.openStream).toHaveBeenCalledWith(config, 'workspace_1', { replay: true });
    }
  );
});
