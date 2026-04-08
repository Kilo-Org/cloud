import { createHmac } from 'crypto';

import { db } from '@/lib/drizzle';
import { and, eq, isNull } from 'drizzle-orm';
import { kiloclaw_instances } from '@kilocode/db/schema';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { STREAM_CHAT_API_SECRET } from '@/lib/config.server';
import { notifyUser } from '@/lib/push-notifications';

function verifyWebhookSignature(body: string, signature: string | null): boolean {
  if (!signature || !STREAM_CHAT_API_SECRET) return false;

  const expectedSignature = createHmac('sha256', STREAM_CHAT_API_SECRET)
    .update(body)
    .digest('hex');

  return signature === expectedSignature;
}

type StreamChatWebhookPayload = {
  type: string;
  message?: {
    text?: string;
    user?: { id: string };
  };
  channel_id?: string;
  members?: Array<{ user_id: string }>;
};

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-signature');

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const payload: StreamChatWebhookPayload = JSON.parse(rawBody);

  // Only handle new messages from bot users
  if (payload.type !== 'message.new') {
    return NextResponse.json({ ok: true });
  }

  const senderId = payload.message?.user?.id;
  const messageText = payload.message?.text;

  if (!senderId?.startsWith('bot-') || !messageText) {
    return NextResponse.json({ ok: true });
  }

  // Extract sandbox ID from bot user ID: "bot-{sandboxId}" → sandboxId
  const sandboxId = senderId.slice(4);

  // Look up the active instance for this sandbox
  const [instance] = await db
    .select({
      id: kiloclaw_instances.id,
      user_id: kiloclaw_instances.user_id,
      name: kiloclaw_instances.name,
    })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .limit(1);

  if (!instance) {
    return NextResponse.json({ ok: true });
  }

  // Fire-and-forget — don't block the webhook response
  void notifyUser({
    userId: instance.user_id,
    instanceId: instance.id,
    instanceName: instance.name ?? 'Kilo',
    messagePreview: messageText,
  });

  return NextResponse.json({ ok: true });
}
