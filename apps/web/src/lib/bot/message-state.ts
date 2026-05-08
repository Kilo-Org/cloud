import 'server-only';
import * as z from 'zod';
import { ThreadImpl, Message, type StateAdapter, type Thread } from 'chat';
import type { Root } from 'mdast';
import { bot } from '@/lib/bot';

const BOT_REQUEST_MESSAGE_STATE_KEY_PREFIX = 'bot-request-message-state:';
const BOT_REQUEST_MESSAGE_STATE_TTL_MS = 24 * 60 * 60 * 1000;

type SerializedThread = ReturnType<Thread['toJSON']>;
type SerializedMessage = ReturnType<Message['toJSON']>;

type BotRequestMessageState = {
  thread: SerializedThread;
  message: SerializedMessage;
};

const serializedThreadShape = z.looseObject({
  _type: z.literal('chat:Thread'),
  adapterName: z.string(),
  channelId: z.string(),
  channelVisibility: z.enum(['private', 'workspace', 'external', 'unknown']).optional(),
  currentMessage: z.lazy(() => serializedMessageShape).optional(),
  id: z.string(),
  isDM: z.boolean(),
}) satisfies z.ZodType<SerializedThread>;

const serializedMessageAttachmentShape = z.object({
  type: z.enum(['image', 'file', 'video', 'audio']),
  url: z.string().optional(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  fetchMetadata: z.record(z.string(), z.string()).optional(),
});

const serializedMessageLinkShape = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
  siteName: z.string().optional(),
});

const formattedContentShape = z.custom<Root>(
  value =>
    z.object({ type: z.literal('root'), children: z.array(z.unknown()) }).safeParse(value).success
);

export const serializedThreadSchema = z.custom<SerializedThread>(
  value => serializedThreadShape.safeParse(value).success
);

const serializedMessageShape = z.looseObject({
  _type: z.literal('chat:Message'),
  attachments: z.array(serializedMessageAttachmentShape),
  author: z.object({
    userId: z.string(),
    userName: z.string(),
    fullName: z.string(),
    isBot: z.union([z.boolean(), z.literal('unknown')]),
    isMe: z.boolean(),
  }),
  formatted: formattedContentShape,
  id: z.string(),
  isMention: z.boolean().optional(),
  links: z.array(serializedMessageLinkShape).optional(),
  metadata: z.object({
    dateSent: z.iso.datetime(),
    edited: z.boolean(),
    editedAt: z.iso.datetime().optional(),
  }),
  raw: z.unknown(),
  text: z.string(),
  threadId: z.string(),
}) satisfies z.ZodType<SerializedMessage>;

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
