import type OpenAI from 'openai';
import { createIs } from 'typia';
import type {
  Effort,
  ModelRequest,
  ModelUsage,
  StopReason,
} from '../../../core/model.js';
import type { PromptMessage, PromptPart } from '../../../core/prompt.js';
import { dataUri, isLast } from './parts.js';
import { stopFrom, type Wire, type WirePart } from './wire.js';
import { readCached, type TokenCount } from './usage.js';

/**
 * The OpenAI chat shape, with one extension. `cache_control` on a content block
 * is not part of the OpenAI type; the gateway forwards it to a provider that
 * reads it and ignores it everywhere else, so marking a breakpoint is free.
 */
type CompletionsBody = Omit<OpenAI.Chat.ChatCompletionCreateParams, 'messages'> & {
  /** The OpenRouter reasoning field. It is not part of the OpenAI type. */
  readonly reasoning?: { readonly effort: Effort };
  readonly messages: readonly {
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: readonly ContentBlock[];
  }[];
};

/** The OpenAI content block, plus the breakpoint the gateway forwards. */
type ContentBlock =
  | { readonly type: 'text'; readonly text: string; readonly cache_control?: Ephemeral }
  | {
      readonly type: 'image_url';
      readonly image_url: { readonly url: string };
      readonly cache_control?: Ephemeral;
    };

interface Ephemeral {
  readonly type: 'ephemeral';
}

const ephemeral: Ephemeral = { type: 'ephemeral' };

const block = (text: string, cache: boolean): ContentBlock =>
  cache ? { type: 'text', text, cache_control: ephemeral } : { type: 'text', text };

/**
 * Reasoning is left out. Providers relayed through this shape report their
 * thinking under two different field names and neither takes it back, so there
 * is no block this shape could replay.
 */
const renderPart = (part: PromptPart, cache: boolean): ContentBlock | undefined => {
  switch (part.kind) {
    case 'text': {
      return block(part.text, cache);
    }
    case 'image': {
      const image_url = { url: dataUri(part) };
      return cache
        ? { type: 'image_url', image_url, cache_control: ephemeral }
        : { type: 'image_url', image_url };
    }
    case 'reasoning':
    case 'redacted': {
      return undefined;
    }
  }
};

const renderMessage = (
  message: PromptMessage
): { role: 'user' | 'assistant'; content: readonly ContentBlock[] } => ({
  role: message.role,
  content: message.parts
    .map((part, index) => renderPart(part, isLast(message, index)))
    .filter(part => part !== undefined),
});

const toBody = ({ prompt, model, maxTokens, effort }: ModelRequest): CompletionsBody => ({
  model,
  max_tokens: maxTokens,
  stream: true,
  stream_options: { include_usage: true },
  ...(effort === undefined ? {} : { reasoning: { effort } }),
  messages: [
    ...prompt.system.map(part => ({
      role: 'system' as const,
      content: [block(part.text, part.cache)],
    })),
    ...prompt.messages.map(renderMessage),
  ],
});

interface Counts {
  prompt_tokens: TokenCount;
  completion_tokens: TokenCount;
  prompt_tokens_details?: { cached_tokens?: TokenCount | null } | null;
}

/** Why this shape says the model stopped. `tool_calls` waits on tool support. */
const stopReasons: Readonly<Record<string, StopReason>> = {
  stop: 'end',
  length: 'maxTokens',
  content_filter: 'refusal',
};

const asStop = stopFrom(stopReasons);

interface DeltaEvent {
  choices: { delta: { content?: string | null } }[];
}

/**
 * The relayed providers do not agree on a name for the thinking: OpenRouter
 * sends `reasoning` and others send `reasoning_content`, so both are read.
 */
interface ReasoningEvent {
  choices: { delta: { reasoning?: string | null; reasoning_content?: string | null } }[];
}

interface UsageEvent {
  usage: Counts;
}

/** The last content frame of a choice names why that choice ended. */
interface StopEvent {
  choices: { finish_reason: string }[];
}

const isDelta = createIs<DeltaEvent>();
const isReasoning = createIs<ReasoningEvent>();
const isUsage = createIs<UsageEvent>();
const isStop = createIs<StopEvent>();

const readUsage = (usage: Counts): Partial<ModelUsage> =>
  readCached(
    usage.prompt_tokens,
    usage.completion_tokens,
    usage.prompt_tokens_details?.cached_tokens ?? 0
  );

/**
 * The empty-choices frame is filtered here rather than in the type. A tuple
 * with a rest element expresses it, but typia then copies the rest on every
 * check, which costs three times as much on the per-token path.
 */
const toDelta = (event: unknown): WirePart | undefined => {
  const said = isDelta(event) ? (event.choices[0]?.delta.content ?? undefined) : undefined;
  if (said !== undefined) {
    return { kind: 'delta', text: said };
  }
  if (!isReasoning(event)) {
    return undefined;
  }
  const thought = event.choices[0]?.delta;
  const text = thought?.reasoning ?? thought?.reasoning_content ?? undefined;
  return text === undefined ? undefined : { kind: 'reasoning', text };
};

const toUsage = (event: unknown): Partial<ModelUsage> | undefined =>
  isUsage(event) ? readUsage(event.usage) : undefined;

const toStop = (event: unknown): StopReason | undefined =>
  isStop(event) ? asStop(event.choices[0]?.finish_reason) : undefined;

const completionsWire: Wire = {
  path: '/api/gateway/v1/chat/completions',
  toBody,
  toDelta,
  toUsage,
  toStop,
};

export { completionsWire };
