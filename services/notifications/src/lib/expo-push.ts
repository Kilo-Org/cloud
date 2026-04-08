const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
};

type ExpoPushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error: string } };

type ExpoPushReceipt =
  | { status: 'ok' }
  | { status: 'error'; message: string; details?: { error: string } };

export type TicketTokenPair = {
  ticketId: string;
  token: string;
};

export type SendResult = {
  /** Ticket IDs paired with the token they were sent to (for receipt correlation) */
  ticketTokenPairs: TicketTokenPair[];
  /** Tokens that are immediately known to be stale */
  staleTokens: string[];
};

export async function sendPushNotifications(
  messages: ExpoPushMessage[],
  accessToken: string
): Promise<SendResult> {
  if (messages.length === 0) return { ticketTokenPairs: [], staleTokens: [] };

  const res = await fetch(EXPO_PUSH_SEND_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(messages),
  });

  if (!res.ok) {
    console.error(`Expo Push API error (${res.status}):`, await res.text().catch(() => ''));
    return { ticketTokenPairs: [], staleTokens: [] };
  }

  const { data: tickets } = (await res.json()) as { data: ExpoPushTicket[] };

  const ticketTokenPairs: TicketTokenPair[] = [];
  const staleTokens: string[] = [];

  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    if (ticket.status === 'ok') {
      ticketTokenPairs.push({ ticketId: ticket.id, token: messages[i].to });
    } else if (ticket.details?.error === 'DeviceNotRegistered') {
      staleTokens.push(messages[i].to);
    }
  }

  return { ticketTokenPairs, staleTokens };
}

/**
 * Check push receipts for delayed errors. Returns tokens that should be removed.
 */
export async function checkPushReceipts(
  ticketTokenPairs: TicketTokenPair[],
  accessToken: string
): Promise<string[]> {
  if (ticketTokenPairs.length === 0) return [];

  const ticketIds = ticketTokenPairs.map(p => p.ticketId);

  const res = await fetch(EXPO_PUSH_RECEIPTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ ids: ticketIds }),
  });

  if (!res.ok) {
    throw new Error(`Expo Receipts API error (${res.status}): ${await res.text().catch(() => '')}`);
  }

  const { data: receipts } = (await res.json()) as { data: Record<string, ExpoPushReceipt> };

  const ticketToToken = new Map(ticketTokenPairs.map(p => [p.ticketId, p.token]));
  const staleTokens: string[] = [];

  for (const [ticketId, receipt] of Object.entries(receipts)) {
    if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
      const token = ticketToToken.get(ticketId);
      if (token) staleTokens.push(token);
    }
  }

  return staleTokens;
}
