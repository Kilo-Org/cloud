import { db } from '@/lib/drizzle';
import { eq, inArray } from 'drizzle-orm';
import { user_push_tokens } from '@kilocode/db/schema';

import { EXPO_ACCESS_TOKEN } from '@/lib/config.server';

const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';

type ExpoPushMessage = {
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

export async function sendPushNotifications(messages: ExpoPushMessage[]): Promise<void> {
  if (messages.length === 0) return;

  const res = await fetch(EXPO_PUSH_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(EXPO_ACCESS_TOKEN && { Authorization: `Bearer ${EXPO_ACCESS_TOKEN}` }),
    },
    body: JSON.stringify(messages),
  });

  if (!res.ok) {
    console.error(`Expo Push API error (${res.status}):`, await res.text().catch(() => ''));
    return;
  }

  const { data: tickets } = (await res.json()) as { data: ExpoPushTicket[] };

  // Clean up stale tokens for DeviceNotRegistered errors
  const staleTokens: string[] = [];
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
      staleTokens.push(messages[i].to);
    }
  }

  if (staleTokens.length > 0) {
    await db.delete(user_push_tokens).where(inArray(user_push_tokens.token, staleTokens));
    console.log(`Cleaned up ${staleTokens.length} stale push token(s)`);
  }
}

export async function notifyUser(opts: {
  userId: string;
  instanceId: string;
  instanceName: string;
  messagePreview: string;
}): Promise<void> {
  const tokens = await db
    .select({ token: user_push_tokens.token })
    .from(user_push_tokens)
    .where(eq(user_push_tokens.user_id, opts.userId));

  if (tokens.length === 0) return;

  const truncatedMessage =
    opts.messagePreview.length > 100
      ? opts.messagePreview.slice(0, 97) + '...'
      : opts.messagePreview;

  const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
    to: token,
    title: `${opts.instanceName || 'Kilo'}`,
    body: truncatedMessage,
    data: { instanceId: opts.instanceId },
    sound: 'default',
    priority: 'high',
  }));

  await sendPushNotifications(messages);
}
