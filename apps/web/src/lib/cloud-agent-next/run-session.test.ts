import type { CloudAgentEvent } from './event-types';
import type { CloudAgentNextClient } from './cloud-agent-client';

const mockDisconnect = jest.fn();
let mockEventToEmit: CloudAgentEvent | undefined;
let mockEventsToEmit: CloudAgentEvent[] | undefined;

jest.mock('@kilocode/web-shared/lib/dotenvx', () => ({
  getEnvVariable: (name: string) =>
    name === 'NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL' ? 'https://worker.example.com' : undefined,
}));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-secret',
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/cloud-agent/stream-ticket', () => ({
  signStreamTicket: jest.fn(() => ({ ticket: 'stream-ticket' })),
}));

jest.mock('./websocket-manager', () => ({
  createWebSocketManager: jest.fn((config: { onEvent: (event: CloudAgentEvent) => void }) => ({
    connect: () => {
      for (const event of mockEventsToEmit ?? (mockEventToEmit ? [mockEventToEmit] : [])) {
        config.onEvent(event);
      }
    },
    disconnect: mockDisconnect,
  })),
}));

import { runSessionToCompletion, INSUFFICIENT_CREDITS_RESPONSE } from './run-session';
import { STATUS_LOG_MAX_ENTRIES, STATUS_LOG_MAX_TOTAL_LENGTH } from './bounded-status-log';

describe('runSessionToCompletion', () => {
  beforeEach(() => {
    mockDisconnect.mockClear();
    mockEventToEmit = undefined;
    mockEventsToEmit = undefined;
  });

  it('resolves queued-delivery failures without waiting for the stream timeout', async () => {
    mockEventToEmit = {
      eventId: 1,
      sessionId: 'agent-headless-failed',
      streamEventType: 'cloud.message.failed',
      timestamp: new Date().toISOString(),
      data: {
        messageId: 'msg_018f1e2d3c4bHeadlessFailure1',
        delivery: 'queued',
        reason: 'exhausted',
        error: 'Pending message delivery failed',
      },
    };

    const client = {
      prepareSession: jest.fn().mockResolvedValue({
        cloudAgentSessionId: 'agent-headless-failed',
        kiloSessionId: 'kilo-headless-failed',
      }),
      initiateFromPreparedSession: jest.fn().mockResolvedValue({
        streamUrl: '/sessions/user/agent-headless-failed/stream',
      }),
    } as unknown as CloudAgentNextClient;

    const result = await runSessionToCompletion({
      client,
      prepareInput: {} as never,
      ticketPayload: { userId: 'user-headless' },
      streamTimeoutMs: 60_000,
    });

    expect(result.hasError).toBe(true);
    expect(result.response).toContain('Pending message delivery failed');
    expect(result.statusMessages).toContain(
      'Message failed before execution: Pending message delivery failed'
    );
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('returns the credits response when prepareSession rejects with InsufficientCreditsError', async () => {
    const { InsufficientCreditsError } = await import('./cloud-agent-client');
    const client = {
      prepareSession: jest.fn().mockRejectedValue(new InsufficientCreditsError()),
      initiateFromPreparedSession: jest.fn(),
    } as unknown as CloudAgentNextClient;

    const result = await runSessionToCompletion({
      client,
      prepareInput: {} as never,
      ticketPayload: { userId: 'user-credits' },
      streamTimeoutMs: 60_000,
    });

    expect(result.hasError).toBe(true);
    expect(result.response).toBe(INSUFFICIENT_CREDITS_RESPONSE);
    expect(result.sessionId).toBeUndefined();
    expect(client.initiateFromPreparedSession).not.toHaveBeenCalled();
    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it('returns the credits response when initiateFromPreparedSession rejects with InsufficientCreditsError', async () => {
    const { InsufficientCreditsError } = await import('./cloud-agent-client');
    const cleanupSession = jest.fn<() => Promise<{ success: boolean }>, []>();
    const client = {
      prepareSession: jest.fn().mockResolvedValue({
        cloudAgentSessionId: 'agent-credits',
        kiloSessionId: 'kilo-credits',
      }),
      initiateFromPreparedSession: jest.fn().mockRejectedValue(new InsufficientCreditsError()),
      cleanupSession,
    } as unknown as CloudAgentNextClient;

    const result = await runSessionToCompletion({
      client,
      prepareInput: {} as never,
      ticketPayload: { userId: 'user-credits' },
      streamTimeoutMs: 60_000,
    });

    expect(result.hasError).toBe(true);
    expect(result.response).toBe(INSUFFICIENT_CREDITS_RESPONSE);
    expect(result.sessionId).toBe('agent-credits');
    expect(cleanupSession).toHaveBeenCalledWith('agent-credits');
    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it('caps retained diagnostics and names the omitted count on a long stream', async () => {
    const eventCount = STATUS_LOG_MAX_ENTRIES * 3;
    const events: CloudAgentEvent[] = [];

    for (let i = 0; i < eventCount; i++) {
      events.push({
        eventId: i,
        sessionId: 'agent-long-stream',
        streamEventType: 'status',
        timestamp: new Date().toISOString(),
        data: { message: `status line ${i}` },
      });
      events.push({
        eventId: eventCount + i,
        sessionId: 'agent-long-stream',
        streamEventType: 'output',
        timestamp: new Date().toISOString(),
        data: { source: 'stderr', content: `stderr line ${i}` },
      });
    }
    events.push({
      eventId: eventCount * 2,
      sessionId: 'agent-long-stream',
      streamEventType: 'complete',
      timestamp: new Date().toISOString(),
      data: { exitCode: 0 },
    });
    mockEventsToEmit = events;

    const client = {
      prepareSession: jest.fn().mockResolvedValue({
        cloudAgentSessionId: 'agent-long-stream',
        kiloSessionId: 'kilo-long-stream',
      }),
      initiateFromPreparedSession: jest.fn().mockResolvedValue({
        streamUrl: '/sessions/user/agent-long-stream/stream',
      }),
    } as unknown as CloudAgentNextClient;

    const result = await runSessionToCompletion({
      client,
      prepareInput: {} as never,
      ticketPayload: { userId: 'user-long-stream' },
      streamTimeoutMs: 60_000,
    });

    expect(result.statusMessages.length).toBeLessThanOrEqual(STATUS_LOG_MAX_ENTRIES);
    const retainedLength = result.statusMessages.reduce((sum, line) => sum + line.length, 0);
    expect(retainedLength).toBeLessThanOrEqual(STATUS_LOG_MAX_TOTAL_LENGTH);
    expect(result.response).toMatch(/\(\+\d+ earlier lines omitted\)/);
  });
});
