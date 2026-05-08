import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpoPushMessage } from 'expo-server-sdk';

type PushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error: string } };
type PushReceipt =
  | { status: 'ok' }
  | { status: 'error'; message: string; details?: { error: string } };

const chunkPushNotifications = vi.fn<(messages: ExpoPushMessage[]) => ExpoPushMessage[][]>();
const sendPushNotificationsAsync = vi.fn<(chunk: ExpoPushMessage[]) => Promise<PushTicket[]>>();
const chunkPushNotificationReceiptIds = vi.fn<(ticketIds: string[]) => string[][]>();
const getPushNotificationReceiptsAsync =
  vi.fn<(chunk: string[]) => Promise<Record<string, PushReceipt>>>();

vi.mock('expo-server-sdk', () => ({
  default: vi.fn(() => ({
    chunkPushNotifications,
    sendPushNotificationsAsync,
    chunkPushNotificationReceiptIds,
    getPushNotificationReceiptsAsync,
  })),
}));

import { checkPushReceipts, sendPushNotifications } from './expo-push';

const message: ExpoPushMessage = {
  to: 'ExponentPushToken[token-1]',
  title: 'Title',
  body: 'Body',
};

describe('sendPushNotifications', () => {
  beforeEach(() => {
    chunkPushNotifications.mockReset();
    sendPushNotificationsAsync.mockReset();
    chunkPushNotificationReceiptIds.mockReset();
    getPushNotificationReceiptsAsync.mockReset();
    chunkPushNotifications.mockImplementation(messages => [messages]);
    chunkPushNotificationReceiptIds.mockImplementation(ticketIds => [ticketIds]);
  });

  it('retries transient Expo chunk send failures', async () => {
    sendPushNotificationsAsync
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce([{ status: 'ok', id: 'ticket-1' }]);

    const result = await sendPushNotifications([message], 'access-token');

    expect(sendPushNotificationsAsync).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ticketTokenPairs: [{ ticketId: 'ticket-1', token: 'ExponentPushToken[token-1]' }],
      staleTokens: [],
      ticketErrors: [],
    });
  });

  it('does not retry permanent stale-token ticket failures', async () => {
    sendPushNotificationsAsync.mockResolvedValueOnce([
      {
        status: 'error',
        message: 'Device not registered',
        details: { error: 'DeviceNotRegistered' },
      },
    ]);

    const result = await sendPushNotifications([message], 'access-token');

    expect(sendPushNotificationsAsync).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ticketTokenPairs: [],
      staleTokens: ['ExponentPushToken[token-1]'],
      ticketErrors: [],
    });
  });

  it('retries retryable ticket errors without resending accepted tokens', async () => {
    const rateLimitedMessage: ExpoPushMessage = {
      to: 'ExponentPushToken[token-2]',
      title: 'Title',
      body: 'Body',
    };
    sendPushNotificationsAsync
      .mockResolvedValueOnce([
        { status: 'ok', id: 'ticket-1' },
        {
          status: 'error',
          message: 'Rate exceeded',
          details: { error: 'MessageRateExceeded' },
        },
      ])
      .mockResolvedValueOnce([{ status: 'ok', id: 'ticket-2' }]);

    const result = await sendPushNotifications([message, rateLimitedMessage], 'access-token');

    expect(sendPushNotificationsAsync).toHaveBeenCalledTimes(2);
    expect(sendPushNotificationsAsync).toHaveBeenNthCalledWith(1, [message, rateLimitedMessage]);
    expect(sendPushNotificationsAsync).toHaveBeenNthCalledWith(2, [rateLimitedMessage]);
    expect(result).toEqual({
      ticketTokenPairs: [
        { ticketId: 'ticket-1', token: 'ExponentPushToken[token-1]' },
        { ticketId: 'ticket-2', token: 'ExponentPushToken[token-2]' },
      ],
      staleTokens: [],
      ticketErrors: [],
    });
  });

  it('surfaces retryable ticket errors after the bounded retry budget', async () => {
    sendPushNotificationsAsync.mockResolvedValue([
      {
        status: 'error',
        message: 'Rate exceeded',
        details: { error: 'MessageRateExceeded' },
      },
    ]);

    const result = await sendPushNotifications([message], 'access-token');

    expect(sendPushNotificationsAsync).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      ticketTokenPairs: [],
      staleTokens: [],
      ticketErrors: [
        {
          errorCode: 'MessageRateExceeded',
          message: 'Rate exceeded',
          retryable: true,
        },
      ],
    });
  });

  it('surfaces non-stale ticket errors', async () => {
    sendPushNotificationsAsync.mockResolvedValueOnce([
      {
        status: 'error',
        message: 'Message is too big',
        details: { error: 'MessageTooBig' },
      },
    ]);

    const result = await sendPushNotifications([message], 'access-token');

    expect(result).toEqual({
      ticketTokenPairs: [],
      staleTokens: [],
      ticketErrors: [
        {
          errorCode: 'MessageTooBig',
          message: 'Message is too big',
          retryable: false,
        },
      ],
    });
  });
});

describe('checkPushReceipts', () => {
  beforeEach(() => {
    chunkPushNotifications.mockReset();
    sendPushNotificationsAsync.mockReset();
    chunkPushNotificationReceiptIds.mockReset();
    getPushNotificationReceiptsAsync.mockReset();
    chunkPushNotificationReceiptIds.mockImplementation(ticketIds => [ticketIds]);
  });

  it('surfaces non-stale receipt errors without token details', async () => {
    getPushNotificationReceiptsAsync.mockResolvedValueOnce({
      'ticket-stale': {
        status: 'error',
        message: 'Device not registered',
        details: { error: 'DeviceNotRegistered' },
      },
      'ticket-terminal': {
        status: 'error',
        message: 'Invalid credentials',
        details: { error: 'InvalidCredentials' },
      },
      'ticket-retryable': {
        status: 'error',
        message: 'Rate exceeded',
        details: { error: 'MessageRateExceeded' },
      },
    });

    const result = await checkPushReceipts(
      [
        { ticketId: 'ticket-stale', token: 'ExponentPushToken[stale]' },
        { ticketId: 'ticket-terminal', token: 'ExponentPushToken[terminal]' },
        { ticketId: 'ticket-retryable', token: 'ExponentPushToken[retryable]' },
      ],
      'access-token'
    );

    expect(result).toEqual({
      staleTokens: ['ExponentPushToken[stale]'],
      receiptErrors: [
        {
          ticketId: 'ticket-terminal',
          errorCode: 'InvalidCredentials',
          message: 'Invalid credentials',
        },
        {
          ticketId: 'ticket-retryable',
          errorCode: 'MessageRateExceeded',
          message: 'Rate exceeded',
        },
      ],
    });
    expect(JSON.stringify(result.receiptErrors)).not.toContain('ExponentPushToken');
  });
});
