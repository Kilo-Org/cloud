import type Anthropic from '@anthropic-ai/sdk';
import { createAssert, createIs } from 'typia';
import type { ModelReply, ModelRequest, ModelUsage } from '../../../core/model.js';
import type { PromptMessage, PromptPart } from '../../../core/prompt.js';
import { isLast } from './parts.js';
import type { Wire, WirePart } from './wire.js';
import { type Counts, set, type TokenCount } from './usage.js';

/** The Anthropic types are the contract. `cache_control` marks a breakpoint. */
type ContentBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;
type MessagesBody = Anthropic.MessageCreateParams;
type MediaType = Anthropic.Base64ImageSource['media_type'];

const ephemeral = { type: 'ephemeral' } as const;

/**
 * Anthropic names the four image types it takes. The stored media type is a
 * plain string, so it is checked here rather than assumed: an image this shape
 * cannot carry must say so, not be sent and refused.
 */
const assertMedia = createAssert<MediaType>();

/** The system prompt takes text only, so it has a builder of its own. */
const textBlock = (text: string, cache: boolean): Anthropic.TextBlockParam =>
  cache ? { type: 'text', text, cache_control: ephemeral } : { type: 'text', text };

const imageBlock = (media: string, data: string, cache: boolean): ContentBlock => {
  const source = { type: 'base64' as const, media_type: assertMedia(media), data };
  return cache ? { type: 'image', source, cache_control: ephemeral } : { type: 'image', source };
};

const renderPart = (part: PromptPart, cache: boolean): ContentBlock =>
  part.kind === 'text' ? textBlock(part.text, cache) : imageBlock(part.media, part.data, cache);

const renderMessage = (
  message: PromptMessage
): { role: 'user' | 'assistant'; content: ContentBlock[] } => ({
  role: message.role,
  content: message.parts.map((part, index) => renderPart(part, isLast(message, index))),
});

const toBody = ({ prompt, model, maxTokens, stream, effort }: ModelRequest): MessagesBody => ({
  model,
  max_tokens: maxTokens,
  stream,
  ...(effort === undefined ? {} : { output_config: { effort } }),
  system: prompt.system.map(part => textBlock(part.text, part.cache)),
  messages: prompt.messages.map(renderMessage),
});

/**
 * The shapes are matched structurally, not by a `type` discriminator: gateways
 * relay a dozen models and only agree on where the numbers sit, not on how the
 * frames are named. Extra fields are allowed; typia's `is` ignores them.
 */
interface WireUsage {
  input_tokens?: TokenCount | null;
  output_tokens?: TokenCount | null;
  cache_read_input_tokens?: TokenCount | null;
  cache_creation_input_tokens?: TokenCount | null;
}

interface Reply {
  content: { type: string; text?: string }[];
  usage: {
    input_tokens: TokenCount;
    output_tokens: TokenCount;
    cache_read_input_tokens?: TokenCount | null;
    cache_creation_input_tokens?: TokenCount | null;
  };
}

interface DeltaEvent {
  delta: { text: string };
}

/** A thinking block streams under its own field, so the two never collide. */
interface ThinkingEvent {
  delta: { thinking: string };
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
const isThinking = createIs<ThinkingEvent>();
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

const toDelta = (event: unknown): WirePart | undefined => {
  if (isDelta(event)) {
    return { kind: 'delta', text: event.delta.text };
  }
  return isThinking(event) ? { kind: 'reasoning', text: event.delta.thinking } : undefined;
};

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
