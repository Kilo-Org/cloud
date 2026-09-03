import type Anthropic from '@anthropic-ai/sdk';
import { createAssert, createIs } from 'typia';
import type { ModelReply, ModelRequest, ModelUsage } from '../../../core/model.js';
import type { Wire } from './wire.js';
import { type Counts, set } from './usage.js';

/** The Anthropic types are the contract. `cache_control` marks a breakpoint. */
type ContentBlock = Anthropic.TextBlockParam;
type MessagesBody = Anthropic.MessageCreateParams;

const ephemeral = { type: 'ephemeral' } as const;

const block = (text: string, cache: boolean): ContentBlock =>
  cache ? { type: 'text', text, cache_control: ephemeral } : { type: 'text', text };

const toBody = ({ prompt, model, maxTokens, stream, effort }: ModelRequest): MessagesBody => ({
  model,
  max_tokens: maxTokens,
  stream,
  ...(effort === undefined ? {} : { output_config: { effort } }),
  system: prompt.system.map(part => block(part.text, part.cache)),
  messages: prompt.messages.map(message => ({
    role: message.role,
    content: [block(message.text, message.cache)],
  })),
});

/**
 * The shapes are matched structurally, not by a `type` discriminator: gateways
 * relay a dozen models and only agree on where the numbers sit, not on how the
 * frames are named. Extra fields are allowed; typia's `is` ignores them.
 */
interface WireUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface Reply {
  content: { type: string; text?: string }[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

interface DeltaEvent {
  delta: { text: string };
}

interface UsageEvent {
  usage: WireUsage;
}

/** `message_start` carries the input counts and `message_delta` the output count. */
interface StartEvent {
  message: UsageEvent;
}

/** The reply is an edge, so it is validated before the package believes it. */
const assertReply = createAssert<Reply>();
const isDelta = createIs<DeltaEvent>();
const isUsage = createIs<UsageEvent>();
const isStart = createIs<StartEvent>();

const toReply = (raw: unknown): ModelReply => {
  const parsed = assertReply(raw);
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

const toDelta = (event: unknown): string | undefined =>
  isDelta(event) ? event.delta.text : undefined;

const readUsage = (usage: WireUsage): Partial<ModelUsage> => {
  const counts: Counts = {};
  set(counts, 'inputTokens', usage.input_tokens);
  set(counts, 'outputTokens', usage.output_tokens);
  set(counts, 'cacheReadTokens', usage.cache_read_input_tokens);
  set(counts, 'cacheWriteTokens', usage.cache_creation_input_tokens);
  return counts;
};

const toUsage = (event: unknown): Partial<ModelUsage> | undefined => {
  if (isStart(event)) {
    return readUsage(event.message.usage);
  }
  return isUsage(event) ? readUsage(event.usage) : undefined;
};

const messagesWire: Wire = {
  path: '/api/gateway/v1/messages',
  toBody,
  toReply,
  toDelta,
  toUsage,
};

export type { ContentBlock, MessagesBody, WireUsage };
export { assertReply, messagesWire };
