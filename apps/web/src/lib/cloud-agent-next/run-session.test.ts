import type { CloudAgentEvent } from './event-types';
import type { CloudAgentNextClient } from './cloud-agent-client';

const mockDisconnect = jest.fn();
let mockEventToEmit: CloudAgentEvent | undefined;

jest.mock('@/lib/dotenvx', () => ({
  getEnvVariable: (name: string) =>
    name === 'NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL' ? 'https://worker.example.com' : undefined,
}));

jest.mock('@/lib/cloud-agent/stream-ticket', () => ({
  signStreamTicket: jest.fn(() => ({ ticket: 'stream-ticket' })),
}));

jest.mock('./websocket-manager', () => ({
  createWebSocketManager: jest.fn((config: { onEvent: (event: CloudAgentEvent) => void }) => ({
    connect: () => {
      if (mockEventToEmit) {
        config.onEvent(mockEventToEmit);
      }
    },
    disconnect: mockDisconnect,
  })),
}));

import { runSessionToCompletion } from './run-session';

describe('runSessionToCompletion', () => {
  beforeEach(() => {
    mockDisconnect.mockClear();
    mockEventToEmit = undefined;
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
});
