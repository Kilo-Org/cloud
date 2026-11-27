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

const OPEN_GATES: [string, { WORKER_ENV: string; NOTIFICATIONS_PUSH_ENABLED: string }][] = [
  ['staging, switch true', { WORKER_ENV: 'staging', NOTIFICATIONS_PUSH_ENABLED: 'true' }],
  ['production, switch false', { WORKER_ENV: 'production', NOTIFICATIONS_PUSH_ENABLED: 'false' }],
];

function fakeEnv(vars: Record<string, unknown> = {}): Env {
  return {
    EXPO_ACCESS_TOKEN: {
      get: vi.fn(async () => 'access-token'),
    },
    HYPERDRIVE: {
      connectionString: 'postgres://test',
    },
    ...vars,
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
        },
        {
          ticketId: 'ticket-rate-exceeded',
          errorCode: 'MessageRateExceeded',
          message: 'Rate exceeded',
        },
      ],
    });
    const { batch, ack, retry } = fakeBatch({
      ticketTokenPairs: [
        { ticketId: 'ticket-terminal', token: 'ExponentPushToken[terminal]' },
        { ticketId: 'ticket-rate-exceeded', token: 'ExponentPushToken[rate-exceeded]' },
      ],
    });

    await queue(batch, fakeEnv(), { waitUntil: vi.fn() });

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Receipt check returned non-stale Expo receipt error(s)', {
      errorCount: 2,
      errors: [
        {
          ticketId: 'ticket-terminal',
          errorCode: 'InvalidCredentials',
          message: 'Invalid credentials',
        },
        {
          ticketId: 'ticket-rate-exceeded',
          errorCode: 'MessageRateExceeded',
          message: 'Rate exceeded',
        },
      ],
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('ExponentPushToken');
  });

  it.each([
    ['absent', {}],
    ['false', { NOTIFICATIONS_PUSH_ENABLED: 'false' }],
    ['absent under the STS source', { SECRETS_SOURCE: 'sts' }],
  ])('acks staging receipt work unread when the switch is %s', async (_label, vars) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const getBundle = vi.fn();
    const env = fakeEnv({ WORKER_ENV: 'staging', STS: { getBundle }, ...vars });
    const { batch, ack, retry } = fakeBatch({
      ticketTokenPairs: [{ ticketId: 'ticket-1', token: 'ExponentPushToken[staging]' }],
    });

    await queue(batch, env, { waitUntil: vi.fn() });

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(env.EXPO_ACCESS_TOKEN?.get).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    expect(checkPushReceipts).not.toHaveBeenCalled();
  });

  it.each(OPEN_GATES)('checks receipts in %s', async (_label, vars) => {
    vi.mocked(checkPushReceipts).mockResolvedValueOnce({ staleTokens: [], receiptErrors: [] });
    const env = fakeEnv(vars);
    const pairs = [{ ticketId: 'ticket-1', token: 'ExponentPushToken[device]' }];
    const { batch, ack, retry } = fakeBatch({ ticketTokenPairs: pairs });

    await queue(batch, env, { waitUntil: vi.fn() });

    expect(env.EXPO_ACCESS_TOKEN?.get).toHaveBeenCalledOnce();
    expect(checkPushReceipts).toHaveBeenCalledWith(pairs, 'access-token');
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
