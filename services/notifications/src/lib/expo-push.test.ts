import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpoPushMessage } from 'expo-server-sdk';

const sendPushNotificationsAsync = vi.hoisted(() => vi.fn());

vi.mock('expo-server-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    chunkPushNotifications: (messages: ExpoPushMessage[]) => [messages],
    chunkPushNotificationReceiptIds: (ids: string[]) => [ids],
    sendPushNotificationsAsync,
  })),
}));

import { sendPushNotifications } from './expo-push';

const messages: ExpoPushMessage[] = [
  { to: 'ExponentPushToken[aaa]', title: 'Title', body: 'Body' },
];

describe('sendPushNotifications', () => {
  beforeEach(() => {
    sendPushNotificationsAsync.mockReset();
  });

  it('retries transient chunk failures before returning tickets', async () => {
    const transient = new Error('Expo unavailable');
    Object.defineProperty(transient, 'statusCode', { value: 503 });
    sendPushNotificationsAsync
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce([{ status: 'ok', id: 'ticket-1' }]);
    const sleeps: number[] = [];

    const result = await sendPushNotifications(messages, 'access-token', {
      sleep: async ms => {
        sleeps.push(ms);
      },
    });

    expect(sendPushNotificationsAsync).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([500]);
    expect(result.ticketTokenPairs).toEqual([
      { ticketId: 'ticket-1', token: 'ExponentPushToken[aaa]' },
    ]);
  });

  it('classifies non-stale ticket errors without retrying the chunk', async () => {
    sendPushNotificationsAsync.mockResolvedValueOnce([
      {
        status: 'error',
        message: 'The push notification body is too large.',
        details: { error: 'MessageTooBig' },
      },
    ]);

    const result = await sendPushNotifications(messages, 'access-token');

    expect(sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(result.ticketErrors).toEqual([
      {
        token: 'ExponentPushToken[aaa]',
        message: 'The push notification body is too large.',
        code: 'MessageTooBig',
      },
    ]);
  });
});
