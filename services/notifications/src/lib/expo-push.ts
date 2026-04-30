import Expo from 'expo-server-sdk';
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';

export type { ExpoPushMessage } from 'expo-server-sdk';

export type TicketTokenPair = {
  ticketId: string;
  token: string;
};

export type TicketError = {
  token: string;
  message: string;
  code?: string;
};

export type SendResult = {
  ticketTokenPairs: TicketTokenPair[];
  staleTokens: string[];
  ticketErrors: TicketError[];
};

type SendOptions = {
  sleep?: (ms: number) => Promise<void>;
};

const RETRY_DELAYS_MS = [500, 2_000];

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function statusCodeOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('statusCode' in err)) return undefined;
  return typeof err.statusCode === 'number' ? err.statusCode : undefined;
}

function isTransientExpoSendError(err: unknown): boolean {
  const statusCode = statusCodeOf(err);
  if (statusCode === undefined) return true;
  return statusCode === 429 || statusCode >= 500;
}

async function sendChunkWithRetry(
  expo: Expo,
  chunk: ExpoPushMessage[],
  sleep: (ms: number) => Promise<void>
): Promise<ExpoPushTicket[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientExpoSendError(err)) {
        throw err;
      }
      await sleep(delay);
    }
  }
}

export async function sendPushNotifications(
  messages: ExpoPushMessage[],
  accessToken: string,
  options: SendOptions = {}
): Promise<SendResult> {
  if (messages.length === 0) return { ticketTokenPairs: [], staleTokens: [], ticketErrors: [] };

  const expo = new Expo({ accessToken });
  const chunks = expo.chunkPushNotifications(messages);

  const ticketTokenPairs: TicketTokenPair[] = [];
  const staleTokens: string[] = [];
  const ticketErrors: TicketError[] = [];
  const sleep = options.sleep ?? defaultSleep;

  for (const chunk of chunks) {
    const tickets = await sendChunkWithRetry(expo, chunk, sleep);

    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const to = chunk[i].to;
      const token = typeof to === 'string' ? to : to[0];
      if (ticket.status === 'ok') {
        ticketTokenPairs.push({ ticketId: ticket.id, token });
      } else if (ticket.details?.error === 'DeviceNotRegistered') {
        staleTokens.push(token);
      } else {
        ticketErrors.push({
          token,
          message: ticket.message,
          ...(ticket.details?.error !== undefined && { code: ticket.details.error }),
        });
      }
    }
  }

  return { ticketTokenPairs, staleTokens, ticketErrors };
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
