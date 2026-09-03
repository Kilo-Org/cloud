import { z } from 'zod';
import type { ModelReply, ModelRequest, ModelUsage } from '../../../core/model.js';
import type { TurnRole } from '../../../core/turn.js';
import type { Wire } from './wire.js';
import { type Counts, set } from './usage.js';

/** A block of the Anthropic Messages body. `cache_control` marks a breakpoint. */
interface ContentBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: { readonly type: 'ephemeral' };
}

interface MessagesBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly stream: boolean;
  readonly system: readonly ContentBlock[];
  readonly messages: readonly {
    readonly role: TurnRole;
    readonly content: readonly ContentBlock[];
  }[];
}

const ephemeral = { type: 'ephemeral' } as const;

const block = (text: string, cache: boolean): ContentBlock =>
  cache ? { type: 'text', text, cache_control: ephemeral } : { type: 'text', text };

const toBody = ({ prompt, model, maxTokens, stream }: ModelRequest): MessagesBody => ({
  model,
  max_tokens: maxTokens,
  stream,
  system: prompt.system.map(part => block(part.text, part.cache)),
  messages: prompt.messages.map(message => ({
    role: message.role,
    content: [block(message.text, message.cache)],
  })),
});

/** The reply is an edge, so it is validated before the package believes it. */
const ReplySchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
  }),
});

const toReply = (raw: unknown): ModelReply => {
  const parsed = ReplySchema.parse(raw);
  return {
    content: parsed.content.map(part => part.text ?? '').join(''),
    usage: {
      inputTokens: parsed.usage.input_tokens,
      outputTokens: parsed.usage.output_tokens,
      cacheReadTokens: parsed.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: parsed.usage.cache_creation_input_tokens ?? 0,
    },
  };
};

const DeltaEvent = z.object({ delta: z.object({ text: z.string() }) });

const UsageEvent = z.object({
  usage: z.object({
    input_tokens: z.number().nullish(),
    output_tokens: z.number().nullish(),
    cache_read_input_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
  }),
});

/** `message_start` carries the input counts and `message_delta` the output count. */
const StartEvent = z.object({ message: UsageEvent });

const toDelta = (event: unknown): string | undefined => {
  const parsed = DeltaEvent.safeParse(event);
  return parsed.success ? parsed.data.delta.text : undefined;
};

const readUsage = (usage: z.infer<typeof UsageEvent>['usage']): Partial<ModelUsage> => {
  const counts: Counts = {};
  set(counts, 'inputTokens', usage.input_tokens);
  set(counts, 'outputTokens', usage.output_tokens);
  set(counts, 'cacheReadTokens', usage.cache_read_input_tokens);
  set(counts, 'cacheWriteTokens', usage.cache_creation_input_tokens);
  return counts;
};

const toUsage = (event: unknown): Partial<ModelUsage> | undefined => {
  const start = StartEvent.safeParse(event);
  if (start.success) {
    return readUsage(start.data.message.usage);
  }
  const delta = UsageEvent.safeParse(event);
  return delta.success ? readUsage(delta.data.usage) : undefined;
};

const messagesWire: Wire = {
  path: '/api/gateway/v1/messages',
  toBody,
  toReply,
  toDelta,
  toUsage,
};

export type { ContentBlock, MessagesBody };
export { messagesWire, ReplySchema };
