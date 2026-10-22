import { describe, expect, it, vi } from 'vitest';
import {
  persistSandboxControlSessionEvent,
  type SandboxControlSessionEventInput,
} from './sandbox-control-event.js';

const carriers = [
  {
    type: 'message.updated',
    properties: (error: unknown) => ({
      sessionID: 'kilo_fixture',
      info: { id: 'msg_fixture', role: 'assistant', error },
    }),
  },
  {
    type: 'message.part.updated',
    properties: (error: unknown) => ({
      sessionID: 'kilo_fixture',
      part: {
        id: 'part_fixture',
        messageID: 'msg_fixture',
        type: 'retry',
        attempt: 2,
        time: { created: 1 },
        error,
      },
    }),
  },
  {
    type: 'session.error',
    properties: (error: unknown) => ({ sessionID: 'kilo_fixture', error }),
  },
];

function deliver(payload: SandboxControlSessionEventInput) {
  const eventQueries = {
    insert: vi.fn().mockReturnValue(1),
    upsert: vi.fn().mockReturnValue(1),
    insertUnique: vi.fn().mockReturnValue(1),
  };
  const broadcast = vi.fn();
  persistSandboxControlSessionEvent({
    sessionId: 'workspace_fixture',
    payload,
    eventQueries,
    broadcast,
  });
  const live = JSON.parse(broadcast.mock.calls[0][0].payload);
  const storedCall = eventQueries.upsert.mock.calls[0] ?? eventQueries.insert.mock.calls[0];
  return { live, stored: JSON.parse(storedCall[0].payload) };
}

describe('session event public projection', () => {
  describe.each(carriers)('$type', carrier => {
    it.each([
      {
        error: {
          name: 'APIError',
          data: {
            message: 'fixture failure',
            statusCode: 429,
            isRetryable: true,
            responseHeaders: { authorization: 'fixture-header' },
            responseBody: 'fixture-body',
            metadata: { request: 'fixture-request' },
          },
        },
        expected: 'Assistant request was rate limited',
      },
      {
        error: { name: 'APIError', data: { message: '[BYOK] fixture', statusCode: 400 } },
        expected:
          '[BYOK] Your provider rejected the request. Check your provider account and settings.',
      },
      {
        error: { name: 'MessageAbortedError' },
        expected: 'The message was interrupted by the user',
      },
      {
        error: { name: 'FixtureError', data: { message: 'fixture-detail' } },
        expected: 'Assistant request failed',
      },
    ])('renders the shared public failure message %#', ({ error, expected }) => {
      const payload = { type: carrier.type, properties: carrier.properties(error) };
      const original = structuredClone(payload);
      const { live, stored } = deliver(payload);
      const expectedEvent = {
        type: carrier.type,
        event: carrier.type,
        properties: carrier.properties(expected),
      };
      expect(live).toEqual(expectedEvent);
      expect(stored).toEqual(expectedEvent);
      expect(payload).toEqual(original);
    });
  });

  it.each([
    [
      'no_progress',
      'Execution stopped because it made no progress. You can continue in this chat.',
    ],
    [
      'execution_limit',
      'Execution stopped because it reached its time limit. You can continue in this chat.',
    ],
    [
      'agent_restarted',
      'Execution stopped because the agent restarted. You can continue in this chat.',
    ],
    [
      'agent_unresponsive',
      'Execution stopped because Kilo was not responding and was restarted. You can continue in this chat.',
    ],
    [
      'no_progress',
      'Execution stopped while the model request kept retrying: Assistant request was rate limited. You can continue in this chat.',
    ],
  ])('preserves public execution guidance %#', (reason, error) => {
    const properties = { sessionID: 'kilo_fixture', reason, error };
    const { live, stored } = deliver({ type: 'session.error', properties });
    expect(live.properties).toEqual(properties);
    expect(stored.properties).toEqual(properties);
  });

  it('renders a bounded session notice', () => {
    const { live, stored } = deliver({
      type: 'session.error',
      properties: {
        sessionID: 'kilo_fixture',
        reason: 'no_progress',
        error:
          'Execution stopped because it made no progress. You can continue in this chat. fixture-detail',
      },
    });
    expect(live.properties.error).toBe('Assistant request failed');
    expect(stored.properties.error).toBe('Assistant request failed');
  });

  it.each([undefined, null])('preserves optional part errors: %s', error => {
    const properties = {
      part: { id: 'part_fixture', messageID: 'msg_fixture', type: 'text', text: 'hello', error },
    };
    const { live, stored } = deliver({ type: 'message.part.updated', properties });
    expect(live.properties.part).toEqual(JSON.parse(JSON.stringify(properties.part)));
    expect(stored.properties.part).toEqual(live.properties.part);
  });

  it('preserves contract-owned tool state', () => {
    const properties = {
      part: {
        id: 'part_fixture',
        messageID: 'msg_fixture',
        type: 'tool',
        state: { status: 'error', error: 'tool result', metadata: { sessionId: 'child_session' } },
      },
    };
    const { live, stored } = deliver({ type: 'message.part.updated', properties });
    expect(live.properties).toEqual(properties);
    expect(stored.properties).toEqual(properties);
  });
});
