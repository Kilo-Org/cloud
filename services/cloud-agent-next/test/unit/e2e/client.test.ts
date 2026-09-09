import { beforeEach, describe, expect, it, vi } from 'vitest';

const sockets = vi.hoisted(() => ({
  instances: [] as Array<{ message: (data: string) => void }>,
}));

vi.mock('ws', () => ({
  default: class {
    private readonly handlers = new Map<string, (value: unknown) => void>();

    constructor() {
      sockets.instances.push({
        message: data => this.handlers.get('message')?.(Buffer.from(data)),
      });
    }

    on(event: string, handler: (value: unknown) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    close(): void {
      this.handlers.get('close')?.(undefined);
    }
  },
}));

import { isMessageCompleted, openStream, type StreamEvent } from '../../e2e/client.js';

function event(streamEventType: string, data: Record<string, unknown>): StreamEvent {
  return {
    eventId: 1,
    executionId: null,
    sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
    streamEventType,
    timestamp: new Date(0).toISOString(),
    data,
  };
}

describe('isMessageCompleted', () => {
  beforeEach(() => {
    sockets.instances = [];
  });

  it('accepts matching legacy and cloud completion events only', () => {
    expect(isMessageCompleted(event('complete', { messageIds: ['message_1'] }), 'message_1')).toBe(
      true
    );
    expect(
      isMessageCompleted(event('cloud.message.completed', { messageId: 'message_1' }), 'message_1')
    ).toBe(true);
    expect(isMessageCompleted(event('complete', { messageIds: ['other'] }), 'message_1')).toBe(
      false
    );
    expect(
      isMessageCompleted(event('cloud.message.completed', { messageId: 'other' }), 'message_1')
    ).toBe(false);
  });

  it.each([
    ['complete', { messageIds: ['message_1'] }],
    ['cloud.message.completed', { messageId: 'message_1' }],
  ])('waitForTerminal resolves matching %s events', async (streamEventType, data) => {
    const stream = openStream(
      {
        workerUrl: 'http://worker.test',
        user: { id: 'user_1', email: 'user@example.test', api_token_pepper: 'pepper' },
        nextAuthSecret: 'test-secret',
        gitUrl: 'https://example.test/repo.git',
        model: 'kilo/fake-deterministic',
        fakeLlmUrl: 'http://fake.test',
      },
      'workspace_11111111-1111-4111-8111-111111111111'
    );
    const socket = sockets.instances[0];
    if (!socket) throw new Error('Missing stream socket');
    const terminal = stream.waitForTerminal(100, 'message_1');
    socket.message(JSON.stringify(event(streamEventType, data)));
    await expect(terminal).resolves.toMatchObject({ streamEventType, data });
    stream.close();
  });
});
