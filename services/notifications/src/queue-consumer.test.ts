import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TicketTokenPair } from './lib/expo-push';
import { checkPushReceipts } from './lib/expo-push';
import { queue } from './queue-consumer';

vi.mock('./lib/expo-push', () => ({
  checkPushReceipts: vi.fn(),
}));

type ReceiptCheckMessage = {
  ticketTokenPairs: TicketTokenPair[];
};

function fakeEnv(): Env {
  return {
    EXPO_ACCESS_TOKEN: {
      get: vi.fn(async () => 'access-token'),
    },
    HYPERDRIVE: {
      connectionString: 'postgres://test',
    },
  } as unknown as Env;
}

function fakeBatch(message: ReceiptCheckMessage): {
  batch: MessageBatch<ReceiptCheckMessage>;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    batch: {
      messages: [
        {
          body: message,
          ack,
          retry,
        },
      ],
    } as unknown as MessageBatch<ReceiptCheckMessage>,
    ack,
    retry,
  };
}

describe('receipt queue consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs non-stale receipt errors and still acknowledges the queue message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(checkPushReceipts).mockResolvedValueOnce({
      staleTokens: [],
      receiptErrors: [
        {
          ticketId: 'ticket-terminal',
          errorCode: 'InvalidCredentials',
          message: 'Invalid credentials',
          retryable: false,
        },
        {
          ticketId: 'ticket-retryable',
          errorCode: 'MessageRateExceeded',
          message: 'Rate exceeded',
          retryable: true,
        },
      ],
    });
    const { batch, ack, retry } = fakeBatch({
      ticketTokenPairs: [
        { ticketId: 'ticket-terminal', token: 'ExponentPushToken[terminal]' },
        { ticketId: 'ticket-retryable', token: 'ExponentPushToken[retryable]' },
      ],
    });

    await queue(batch, fakeEnv());

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Receipt check returned non-stale Expo receipt error(s)', {
      errorCount: 2,
      retryableCount: 1,
      terminalCount: 1,
      errors: [
        {
          ticketId: 'ticket-terminal',
          errorCode: 'InvalidCredentials',
          message: 'Invalid credentials',
          retryable: false,
        },
        {
          ticketId: 'ticket-retryable',
          errorCode: 'MessageRateExceeded',
          message: 'Rate exceeded',
          retryable: true,
        },
      ],
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('ExponentPushToken');
  });
});
