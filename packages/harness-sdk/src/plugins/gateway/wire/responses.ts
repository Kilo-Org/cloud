import type OpenAI from 'openai';
import { createAssert, createIs } from 'typia';
import type { ModelReply, ModelRequest, ModelUsage } from '../../../core/model.js';
import type { Wire } from './wire.js';

/**
 * The OpenAI Responses shape. It has no cache breakpoint. It caches on
 * `prompt_cache_key`, so the caller passes the session identifier and every
 * request of one session lands on the same cache entry.
 */
type ResponsesBody = OpenAI.Responses.ResponseCreateParams;

const toBody = ({
  prompt,
  model,
  maxTokens,
  stream,
  cacheKey,
  effort,
}: ModelRequest): ResponsesBody => ({
  model,
  max_output_tokens: maxTokens,
  stream,
  ...(effort === undefined ? {} : { reasoning: { effort } }),
  instructions: prompt.system.map(part => part.text).join('\n'),
  ...(cacheKey === undefined ? {} : { prompt_cache_key: cacheKey }),
  input: prompt.messages.map(message => ({
    role: message.role,
    content: [{ type: 'input_text' as const, text: message.text }],
  })),
});

interface Counts {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number | null } | null;
}

interface Reply {
  output: { content?: { text?: string }[] | null }[];
  usage: Counts;
}

/** This shape names its frames, so the two events are matched on `type`. */
interface DeltaEvent {
  type: 'response.output_text.delta';
  delta: string;
}

interface CompletedEvent {
  type: 'response.completed';
  response: { usage: Counts };
}

const assertReply = createAssert<Reply>();
const isDelta = createIs<DeltaEvent>();
const isCompleted = createIs<CompletedEvent>();

/** The cached count is reported inside the input total, so it is subtracted out. */
const readUsage = (usage: Counts): Partial<ModelUsage> => {
  const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens - cacheReadTokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens,
  };
};

const toReply = (raw: unknown): ModelReply => {
  const parsed = assertReply(raw);
  const counts = readUsage(parsed.usage);
  return {
    content: parsed.output
      .flatMap(item => item.content ?? [])
      .map(part => part.text ?? '')
      .join(''),
    usage: {
      inputTokens: counts.inputTokens ?? 0,
      outputTokens: counts.outputTokens ?? 0,
      cacheReadTokens: counts.cacheReadTokens ?? 0,
      cacheWriteTokens: 0,
    },
  };
};

const toDelta = (event: unknown): string | undefined => (isDelta(event) ? event.delta : undefined);

const toUsage = (event: unknown): Partial<ModelUsage> | undefined =>
  isCompleted(event) ? readUsage(event.response.usage) : undefined;

const responsesWire: Wire = {
  path: '/api/gateway/v1/responses',
  toBody,
  toReply,
  toDelta,
  toUsage,
};

export type { ResponsesBody };
export { responsesWire };
