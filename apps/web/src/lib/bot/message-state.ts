import 'server-only';
import * as z from 'zod';
import {
  ThreadImpl,
  Message,
  type SerializedMessage,
  type SerializedThread,
  type StateAdapter,
  type Thread,
} from 'chat';
import { bot } from '@/lib/bot';

const BOT_REQUEST_MESSAGE_STATE_KEY_PREFIX = 'bot-request-message-state:';
const BOT_REQUEST_MESSAGE_STATE_TTL_MS = 24 * 60 * 60 * 1000;

type BotRequestMessageState = {
  thread: SerializedThread;
  message: SerializedMessage;
};

const serializedThreadShape = z.looseObject({
  _type: z.literal('chat:Thread'),
  adapterName: z.string(),
  channelId: z.string(),
  id: z.string(),
  isDM: z.boolean(),
});

export const serializedThreadSchema = z.custom<SerializedThread>(
  value => serializedThreadShape.safeParse(value).success
);

const serializedMessageShape = z.looseObject({
  _type: z.literal('chat:Message'),
  attachments: z.array(z.unknown()),
  author: z.object({
    userId: z.string(),
    userName: z.string(),
    fullName: z.string(),
    isBot: z.union([z.boolean(), z.literal('unknown')]),
    isMe: z.boolean(),
  }),
  formatted: z.unknown(),
  id: z.string(),
  metadata: z.object({
    dateSent: z.iso.datetime(),
    edited: z.boolean(),
    editedAt: z.iso.datetime().optional(),
  }),
  raw: z.unknown(),
  text: z.string(),
  threadId: z.string(),
});

export const serializedMessageSchema = z.custom<SerializedMessage>(
  value => serializedMessageShape.safeParse(value).success
);

const botRequestMessageStateSchema = z.object({
  thread: serializedThreadSchema,
  message: serializedMessageSchema,
});

function botRequestMessageStateKey(botRequestId: string): string {
  return `${BOT_REQUEST_MESSAGE_STATE_KEY_PREFIX}${botRequestId}`;
}

export async function storeBotRequestMessageState({
  state,
  botRequestId,
  thread,
  message,
}: {
  state: StateAdapter;
  botRequestId: string;
  thread: Thread;
  message: Message;
}): Promise<void> {
  await state.set<BotRequestMessageState>(
    botRequestMessageStateKey(botRequestId),
    {
      thread: thread.toJSON(),
      message: message.toJSON(),
    },
    BOT_REQUEST_MESSAGE_STATE_TTL_MS
  );
}

export async function getBotRequestMessageState(
  state: StateAdapter,
  botRequestId: string
): Promise<BotRequestMessageState | null> {
  const value = await state.get<unknown>(botRequestMessageStateKey(botRequestId));
  if (!value) {
    return null;
  }

  return botRequestMessageStateSchema.parse(value);
}

export async function getRehydratedBotRequestMessageState(botRequestId: string) {
  const stored = await getBotRequestMessageState(bot.getState(), botRequestId);

  if (!stored) {
    throw new Error('Could not find message state for botRequest ' + botRequestId);
  }

  return {
    thread: ThreadImpl.fromJSON(stored.thread),
    message: Message.fromJSON(stored.message),
  };
}
