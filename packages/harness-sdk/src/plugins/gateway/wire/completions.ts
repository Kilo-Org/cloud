import type OpenAI from 'openai';
import { z } from 'zod';
import type { ModelReply, ModelRequest, ModelUsage } from '../../../core/model.js';
import type { Wire } from './wire.js';
import type { ContentBlock } from './messages.js';

/**
 * The OpenAI chat shape, with one extension. `cache_control` on a content block
 * is not part of the OpenAI type; the gateway forwards it to a provider that
 * reads it and ignores it everywhere else, so marking a breakpoint is free.
 */
type CompletionsBody = Omit<OpenAI.Chat.ChatCompletionCreateParams, 'messages'> & {
  readonly messages: readonly {
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: readonly ContentBlock[];
  }[];
};

const ephemeral = { type: 'ephemeral' } as const;

const block = (text: string, cache: boolean): ContentBlock =>
  cache ? { type: 'text', text, cache_control: ephemeral } : { type: 'text', text };

const toBody = ({ prompt, model, maxTokens, stream }: ModelRequest): CompletionsBody => ({
  model,
  max_tokens: maxTokens,
  stream,
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

const ReplySchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
  }),
});

const toReply = (raw: unknown): ModelReply => {
  const parsed = ReplySchema.parse(raw);
  const cacheReadTokens = parsed.usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    content: parsed.choices.map(choice => choice.message.content ?? '').join(''),
    usage: {
      inputTokens: parsed.usage.prompt_tokens - cacheReadTokens,
      outputTokens: parsed.usage.completion_tokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
    },
  };
};

const DeltaEvent = z.object({
  choices: z.array(z.object({ delta: z.object({ content: z.string().nullish() }) })).nonempty(),
});

const UsageEvent = z.object({
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
  }),
});

const toDelta = (event: unknown): string | undefined => {
  const parsed = DeltaEvent.safeParse(event);
  return parsed.success ? (parsed.data.choices[0]?.delta.content ?? undefined) : undefined;
};

const toUsage = (event: unknown): Partial<ModelUsage> | undefined => {
  const parsed = UsageEvent.safeParse(event);
  if (!parsed.success) {
    return undefined;
  }
  const cacheReadTokens = parsed.data.usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: parsed.data.usage.prompt_tokens - cacheReadTokens,
    outputTokens: parsed.data.usage.completion_tokens,
    cacheReadTokens,
  };
};

const completionsWire: Wire = {
  path: '/api/gateway/v1/chat/completions',
  toBody,
  toReply,
  toDelta,
  toUsage,
};

export type { CompletionsBody };
export { completionsWire };
