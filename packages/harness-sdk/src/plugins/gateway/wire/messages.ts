import type Anthropic from '@anthropic-ai/sdk';
import { createAssert, createIs } from 'typia';
import type { ModelReply, ModelRequest, ModelUsage, StopReason } from '../../../core/model.js';
import type { PromptMessage, PromptPart } from '../../../core/prompt.js';
import { isLast } from './parts.js';
import type { Wire, WirePart } from './wire.js';
import { type Counts, set, type TokenCount } from './usage.js';

/** The Anthropic types are the contract. `cache_control` marks a breakpoint. */
type ContentBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ImageBlockParam
  | Anthropic.ThinkingBlockParam
  | Anthropic.RedactedThinkingBlockParam;
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

/**
 * A thinking block goes back exactly as it came, so it carries no breakpoint of
 * its own: a `cache_control` this package added would be a change to the block.
 */
const thinkingBlock = (text: string, signature: string): Anthropic.ThinkingBlockParam => ({
  type: 'thinking',
  thinking: text,
  signature,
});

const renderPart = (part: PromptPart, cache: boolean): ContentBlock | undefined => {
  switch (part.kind) {
    case 'text': {
      return textBlock(part.text, cache);
    }
    case 'image': {
      return imageBlock(part.media, part.data, cache);
    }
    case 'reasoning': {
      /* Without a signature the provider refuses the block, so it is left out
         rather than sent and rejected. */
      return part.signature === undefined ? undefined : thinkingBlock(part.text, part.signature);
    }
    case 'redacted': {
      /* Already encrypted by the provider, so it needs no signature and must
         go back byte for byte. */
      return { type: 'redacted_thinking', data: part.data };
    }
  }
};

const renderMessage = (
  message: PromptMessage
): { role: 'user' | 'assistant'; content: ContentBlock[] } => ({
  role: message.role,
  content: message.parts
    .map((part, index) => renderPart(part, isLast(message, index)))
    .filter(block => block !== undefined),
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

/**
 * Why this shape says the model stopped. `tool_use` and `pause_turn` are not
 * mapped: this package has no tools, so neither can arrive, and naming them
 * here would claim a meaning nothing has tested.
 */
const stopReasons: Readonly<Record<string, StopReason>> = {
  end_turn: 'end',
  stop_sequence: 'end',
  max_tokens: 'maxTokens',
  refusal: 'refusal',
};

const asStop = (named: string | null | undefined): StopReason | undefined =>
  named === null || named === undefined ? undefined : (stopReasons[named] ?? 'unknown');

interface Reply {
  content: { type: string; text?: string }[];
  stop_reason?: string | null;
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

/**
 * The signature closes a thinking block. It arrives on its own event, with no
 * thinking on it, so it is read on its own and never mixed into the text.
 */
interface SignatureEvent {
  delta: { signature: string };
}

/**
 * Thinking the provider encrypted. Unlike a thinking block it arrives whole, at
 * the start of the block, and there is nothing to accumulate.
 */
interface RedactedEvent {
  content_block: { type: 'redacted_thinking'; data: string };
}

interface UsageEvent {
  usage: WireUsage;
}

/** `message_delta` carries the stop reason beside the output count. */
interface StopEvent {
  delta: { stop_reason: string };
}

/** `message_start` carries the input counts and `message_delta` the output count. */
interface StartEvent {
  message: UsageEvent;
}

/** The reply is an edge, so it is validated before the package believes it. */
const assertReply = createAssert<Reply>();
const isDelta = createIs<DeltaEvent>();
const isThinking = createIs<ThinkingEvent>();
const isSignature = createIs<SignatureEvent>();
const isRedacted = createIs<RedactedEvent>();
const isUsage = createIs<UsageEvent>();
const isStop = createIs<StopEvent>();
const isStart = createIs<StartEvent>();

const toReply = (raw: unknown): ModelReply => {
  const parsed = assertReply(raw);
  return {
    content: parsed.content.map(part => part.text ?? '').join(''),
    stop: asStop(parsed.stop_reason) ?? 'unknown',
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
  if (isThinking(event)) {
    return { kind: 'reasoning', text: event.delta.thinking };
  }
  if (isSignature(event)) {
    return { kind: 'reasoning', text: '', signature: event.delta.signature };
  }
  return isRedacted(event) ? { kind: 'redacted', data: event.content_block.data } : undefined;
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

const toStop = (event: unknown): StopReason | undefined =>
  isStop(event) ? asStop(event.delta.stop_reason) : undefined;

const messagesWire: Wire = {
  path: '/api/gateway/v1/messages',
  toBody,
  toReply,
  toDelta,
  toUsage,
  toStop,
};

export type { ContentBlock, MessagesBody, WireUsage };
export { assertReply, messagesWire };
