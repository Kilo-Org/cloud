import { z } from 'zod';
import type { ModelReply, ModelRequest, ModelUsage } from '../model.js';
import type { Wire } from './wire.js';

/**
 * The OpenAI Responses shape. It has no cache breakpoint. It caches on
 * `prompt_cache_key`, so the caller passes the session identifier and every
 * request of one session lands on the same cache entry.
 */
interface ResponsesBody {
  readonly model: string;
  readonly max_output_tokens: number;
  readonly stream: boolean;
  readonly instructions: string;
  readonly prompt_cache_key?: string;
  readonly input: readonly {
    readonly role: 'user' | 'assistant';
    readonly content: readonly { readonly type: 'input_text'; readonly text: string }[];
  }[];
}

const toBody = ({ prompt, model, maxTokens, stream, cacheKey }: ModelRequest): ResponsesBody => ({
  model,
  max_output_tokens: maxTokens,
  stream,
  instructions: prompt.system.map(part => part.text).join('\n'),
  ...(cacheKey === undefined ? {} : { prompt_cache_key: cacheKey }),
  input: prompt.messages.map(message => ({
    role: message.role,
    content: [{ type: 'input_text' as const, text: message.text }],
  })),
});

const ReplySchema = z.object({
  output: z.array(
    z.object({ content: z.array(z.object({ text: z.string().optional() })).nullish() })
  ),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    input_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
  }),
});

const toReply = (raw: unknown): ModelReply => {
  const parsed = ReplySchema.parse(raw);
  const cacheReadTokens = parsed.usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    content: parsed.output
      .flatMap(item => item.content ?? [])
      .map(part => part.text ?? '')
      .join(''),
    usage: {
      inputTokens: parsed.usage.input_tokens - cacheReadTokens,
      outputTokens: parsed.usage.output_tokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
    },
  };
};

const DeltaEvent = z.object({ type: z.literal('response.output_text.delta'), delta: z.string() });

const CompletedEvent = z.object({
  type: z.literal('response.completed'),
  response: z.object({
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      input_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
    }),
  }),
});

const toDelta = (event: unknown): string | undefined => {
  const parsed = DeltaEvent.safeParse(event);
  return parsed.success ? parsed.data.delta : undefined;
};

const toUsage = (event: unknown): Partial<ModelUsage> | undefined => {
  const parsed = CompletedEvent.safeParse(event);
  if (!parsed.success) {
    return undefined;
  }
  const { usage } = parsed.data.response;
  const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens - cacheReadTokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens,
  };
};

const responsesWire: Wire = {
  path: '/api/gateway/v1/responses',
  toBody,
  toReply,
  toDelta,
  toUsage,
};

export type { ResponsesBody };
export { responsesWire };
