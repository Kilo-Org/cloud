import Expo from 'expo-server-sdk';
import type { ExpoPushMessage, ExpoPushReceipt } from 'expo-server-sdk';

export type { ExpoPushMessage } from 'expo-server-sdk';

export type TicketTokenPair = {
  ticketId: string;
  token: string;
};

export type PushTicketError = {
  token: string;
  errorCode: string | undefined;
  message: string;
  retryable: boolean;
};

export type SendResult = {
  ticketTokenPairs: TicketTokenPair[];
  staleTokens: string[];
  ticketErrors: PushTicketError[];
};

type ExpoClient = InstanceType<typeof Expo>;
type ExpoPushChunk = Parameters<ExpoClient['sendPushNotificationsAsync']>[0];
type ExpoPushTicket = Awaited<ReturnType<ExpoClient['sendPushNotificationsAsync']>>[number];

const TRANSIENT_SEND_RETRY_DELAYS_MS = [100, 500];
const RETRYABLE_TICKET_ERROR_CODES = new Set(['MessageRateExceeded']);
const TERMINAL_TICKET_ERROR_CODES = new Set([
  'InvalidCredentials',
  'MessageTooBig',
  'MismatchSenderId',
]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendChunkWithTransientRetry(
  expo: ExpoClient,
  chunk: ExpoPushChunk
): Promise<ExpoPushTicket[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      const delayMs = TRANSIENT_SEND_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) throw err;
      await sleep(delayMs);
    }
  }
}

function isRetryableTicketError(errorCode: string | undefined): boolean {
  if (errorCode === undefined) return true;
  if (RETRYABLE_TICKET_ERROR_CODES.has(errorCode)) return true;
  if (TERMINAL_TICKET_ERROR_CODES.has(errorCode)) return false;
  return true;
}

export async function sendPushNotifications(
  messages: ExpoPushMessage[],
  accessToken: string
): Promise<SendResult> {
  if (messages.length === 0) return { ticketTokenPairs: [], staleTokens: [], ticketErrors: [] };

  const expo = new Expo({ accessToken });
  const chunks = expo.chunkPushNotifications(messages);

  const ticketTokenPairs: TicketTokenPair[] = [];
  const staleTokens: string[] = [];
  const ticketErrors: PushTicketError[] = [];

  for (const chunk of chunks) {
    const tickets = await sendChunkWithTransientRetry(expo, chunk);

    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const to = chunk[i].to;
      const token = typeof to === 'string' ? to : to[0];
      if (ticket.status === 'ok') {
        ticketTokenPairs.push({ ticketId: ticket.id, token });
      } else if (ticket.details?.error === 'DeviceNotRegistered') {
        staleTokens.push(token);
      } else {
        const errorCode = ticket.details?.error;
        ticketErrors.push({
          token,
          errorCode,
          message: ticket.message,
          retryable: isRetryableTicketError(errorCode),
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
