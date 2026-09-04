import type OpenAI from 'openai';
import { createAssert, createIs } from 'typia';
import type { ModelReply, ModelRequest, ModelUsage } from '../../../core/model.js';
import type { PromptPart } from '../../../core/prompt.js';
import { dataUri } from './parts.js';
import type { Wire, WirePart } from './wire.js';
import type { TokenCount } from './usage.js';

/**
 * The OpenAI Responses shape. It has no cache breakpoint. It caches on
 * `prompt_cache_key`, so the caller passes the session identifier and every
 * request of one session lands on the same cache entry.
 */
type ResponsesBody = OpenAI.Responses.ResponseCreateParams;

/**
 * This shape has no cache breakpoint, so a part carries no mark. An image goes
 * as a data URI, which is the only way this shape takes bytes.
 *
 * Reasoning is left out. This shape replays thinking as a reasoning item with
 * the provider's encrypted content, which the request has to ask for and which
 * this package does not read, so there is nothing here that could be sent back.
 */
const renderPart = (part: PromptPart): OpenAI.Responses.ResponseInputContent | undefined => {
  switch (part.kind) {
    case 'text': {
      return { type: 'input_text', text: part.text };
    }
    case 'image': {
      return { type: 'input_image', image_url: dataUri(part), detail: 'auto' };
    }
    case 'reasoning': {
      return undefined;
    }
  }
};

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
    content: message.parts.map(renderPart).filter(part => part !== undefined),
  })),
});

interface Counts {
  input_tokens: TokenCount;
  output_tokens: TokenCount;
  input_tokens_details?: { cached_tokens?: TokenCount | null } | null;
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

/** This shape streams the thinking as a summary, under a name of its own. */
interface ReasoningEvent {
  type: 'response.reasoning_summary_text.delta';
  delta: string;
}

const assertReply = createAssert<Reply>();
const isDelta = createIs<DeltaEvent>();
const isCompleted = createIs<CompletedEvent>();
const isReasoning = createIs<ReasoningEvent>();

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

const toDelta = (event: unknown): WirePart | undefined => {
  if (isDelta(event)) {
    return { kind: 'delta', text: event.delta };
  }
  return isReasoning(event) ? { kind: 'reasoning', text: event.delta } : undefined;
};

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
