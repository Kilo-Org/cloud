import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpoPushMessage } from 'expo-server-sdk';

type PushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error: string } };

const chunkPushNotifications = vi.fn<(messages: ExpoPushMessage[]) => ExpoPushMessage[][]>();
const sendPushNotificationsAsync = vi.fn<(chunk: ExpoPushMessage[]) => Promise<PushTicket[]>>();

vi.mock('expo-server-sdk', () => ({
  default: vi.fn(() => ({
    chunkPushNotifications,
    sendPushNotificationsAsync,
  })),
}));

import { sendPushNotifications } from './expo-push';

const message: ExpoPushMessage = {
  to: 'ExponentPushToken[token-1]',
  title: 'Title',
  body: 'Body',
};

describe('sendPushNotifications', () => {
  beforeEach(() => {
    chunkPushNotifications.mockReset();
    sendPushNotificationsAsync.mockReset();
    chunkPushNotifications.mockImplementation(messages => [messages]);
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
          token: 'ExponentPushToken[token-1]',
          errorCode: 'MessageTooBig',
          message: 'Message is too big',
          retryable: false,
        },
      ],
    });
  });
});
