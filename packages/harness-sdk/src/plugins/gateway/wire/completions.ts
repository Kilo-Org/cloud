import type OpenAI from 'openai';
import { createAssert, createIs } from 'typia';
import type { Effort, ModelReply, ModelRequest, ModelUsage } from '../../../core/model.js';
import type { Wire } from './wire.js';
import type { TokenCount } from './usage.js';
import type { ContentBlock } from './messages.js';

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

const ephemeral = { type: 'ephemeral' } as const;

const block = (text: string, cache: boolean): ContentBlock =>
  cache ? { type: 'text', text, cache_control: ephemeral } : { type: 'text', text };

const toBody = ({ prompt, model, maxTokens, stream, effort }: ModelRequest): CompletionsBody => ({
  model,
  max_tokens: maxTokens,
  stream,
  ...(effort === undefined ? {} : { reasoning: { effort } }),
  ...(stream ? { stream_options: { include_usage: true } as const } : {}),
  messages: [
    ...prompt.system.map(part => ({
      role: 'system' as const,
      content: [block(part.text, part.cache)],
    })),
    ...prompt.messages.map(message => ({
      role: message.role,
      content: [block(message.text, message.cache)],
    })),
  ],
});

interface Counts {
  prompt_tokens: TokenCount;
  completion_tokens: TokenCount;
  prompt_tokens_details?: { cached_tokens?: TokenCount | null } | null;
}

interface Reply {
  choices: { message: { content?: string | null } }[];
  usage: Counts;
}

interface DeltaEvent {
  choices: { delta: { content?: string | null } }[];
}

interface UsageEvent {
  usage: Counts;
}

const assertReply = createAssert<Reply>();
const isDelta = createIs<DeltaEvent>();
const isUsage = createIs<UsageEvent>();

/** The cached count is reported inside the prompt total, so it is subtracted out. */
const readUsage = (usage: Counts): Partial<ModelUsage> => {
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: usage.prompt_tokens - cacheReadTokens,
    outputTokens: usage.completion_tokens,
    cacheReadTokens,
  };
};

const toReply = (raw: unknown): ModelReply => {
  const parsed = assertReply(raw);
  const counts = readUsage(parsed.usage);
  return {
    content: parsed.choices.map(choice => choice.message.content ?? '').join(''),
    usage: {
      inputTokens: counts.inputTokens ?? 0,
      outputTokens: counts.outputTokens ?? 0,
      cacheReadTokens: counts.cacheReadTokens ?? 0,
      cacheWriteTokens: 0,
    },
  };
};

/**
 * The empty-choices frame is filtered here rather than in the type. A tuple
 * with a rest element expresses it, but typia then copies the rest on every
 * check, which costs three times as much on the per-token path.
 */
const toDelta = (event: unknown): string | undefined =>
  isDelta(event) ? (event.choices[0]?.delta.content ?? undefined) : undefined;

const toUsage = (event: unknown): Partial<ModelUsage> | undefined =>
  isUsage(event) ? readUsage(event.usage) : undefined;

const completionsWire: Wire = {
  path: '/api/gateway/v1/chat/completions',
  toBody,
  toReply,
  toDelta,
  toUsage,
};

export type { CompletionsBody };
export { completionsWire };
