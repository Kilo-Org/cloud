import { instanceIdFromRecipient, truncate } from './address';
import { handleQueue } from './consumer';
import { parseRawEmail, stableMessageId } from './parser';
import type { AppEnv, InboundEmailQueueMessage } from './types';

const DEFAULT_MAX_EMAIL_RAW_BYTES = 1_048_576;
const DEFAULT_MAX_EMAIL_TEXT_CHARS = 32_000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function streamToArrayBuffer(stream: ReadableStream): Promise<ArrayBuffer> {
  return await new Response(stream).arrayBuffer();
}

async function buildQueueMessage(
  message: ForwardableEmailMessage,
  env: AppEnv
): Promise<InboundEmailQueueMessage | null> {
  const instanceId = instanceIdFromRecipient(message.to, env.INBOUND_EMAIL_DOMAIN);
  if (!instanceId) {
    message.setReject('Address unavailable');
    return null;
  }

  const maxRawBytes = parsePositiveInt(env.MAX_EMAIL_RAW_BYTES, DEFAULT_MAX_EMAIL_RAW_BYTES);
  if (message.rawSize > maxRawBytes) {
    message.setReject('Message too large');
    return null;
  }

  const raw = await streamToArrayBuffer(message.raw);
  const parsed = await parseRawEmail(raw);
  const maxTextChars = parsePositiveInt(env.MAX_EMAIL_TEXT_CHARS, DEFAULT_MAX_EMAIL_TEXT_CHARS);
  const messageId = parsed.messageId ?? (await stableMessageId(raw));

  return {
    instanceId,
    messageId: truncate(messageId, 512),
    from: truncate(parsed.from ?? message.from, 512),
    to: truncate(message.to, 512),
    subject: truncate(parsed.subject, 1_000),
    text: truncate(parsed.text, maxTextChars),
    receivedAt: new Date().toISOString(),
  };
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ ok: true });
  },

  async email(message: ForwardableEmailMessage, env: AppEnv): Promise<void> {
    const queueMessage = await buildQueueMessage(message, env);
    if (!queueMessage) return;

    await env.INBOUND_EMAIL_QUEUE.send(queueMessage);
    console.log(
      JSON.stringify({
        message: 'inbound email queued',
        instanceId: queueMessage.instanceId,
        messageId: queueMessage.messageId,
        rawSize: message.rawSize,
      })
    );
  },

  queue: handleQueue,
} satisfies ExportedHandler<AppEnv, InboundEmailQueueMessage>;

export { buildQueueMessage };
