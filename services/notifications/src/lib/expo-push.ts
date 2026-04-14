import Expo from 'expo-server-sdk';
import type { ExpoPushMessage, ExpoPushReceipt } from 'expo-server-sdk';

export type { ExpoPushMessage } from 'expo-server-sdk';

export type TicketTokenPair = {
  ticketId: string;
  token: string;
};

export type SendResult = {
  ticketTokenPairs: TicketTokenPair[];
  staleTokens: string[];
};

export async function sendPushNotifications(
  messages: ExpoPushMessage[],
  accessToken: string
): Promise<SendResult> {
  if (messages.length === 0) return { ticketTokenPairs: [], staleTokens: [] };

  const expo = new Expo({ accessToken });
  const chunks = expo.chunkPushNotifications(messages);

  const ticketTokenPairs: TicketTokenPair[] = [];
  const staleTokens: string[] = [];

  for (const chunk of chunks) {
    const tickets = await expo.sendPushNotificationsAsync(chunk);

    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const to = chunk[i].to;
      const token = typeof to === 'string' ? to : to[0];
      if (ticket.status === 'ok') {
        ticketTokenPairs.push({ ticketId: ticket.id, token });
      } else if (ticket.details?.error === 'DeviceNotRegistered') {
        staleTokens.push(token);
      }
    }
  }

  return { ticketTokenPairs, staleTokens };
}

export async function checkPushReceipts(
  ticketTokenPairs: TicketTokenPair[],
  accessToken: string
): Promise<string[]> {
  if (ticketTokenPairs.length === 0) return [];

  const expo = new Expo({ accessToken });
  const ticketIds = ticketTokenPairs.map(p => p.ticketId);
  const chunks = expo.chunkPushNotificationReceiptIds(ticketIds);

  const ticketToToken = new Map(ticketTokenPairs.map(p => [p.ticketId, p.token]));
  const staleTokens: string[] = [];

  for (const chunk of chunks) {
    const receipts: { [id: string]: ExpoPushReceipt } =
      await expo.getPushNotificationReceiptsAsync(chunk);

    for (const [ticketId, receipt] of Object.entries(receipts)) {
      if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
        const token = ticketToToken.get(ticketId);
        if (token) staleTokens.push(token);
      }
    }
  }

  return staleTokens;
}
