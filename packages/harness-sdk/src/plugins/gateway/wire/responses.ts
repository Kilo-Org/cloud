import type OpenAI from 'openai';
import { createAssert, createIs } from 'typia';
import type { ModelReply, ModelRequest, ModelUsage, StopReason } from '../../../core/model.js';
import type { PromptMessage, PromptPart } from '../../../core/prompt.js';
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
 * Thinking is not message content here. It is an item beside the message, so it
 * is rendered by `itemsOf` rather than by this.
 */
const renderPart = (part: PromptPart): OpenAI.Responses.ResponseInputContent | undefined => {
  switch (part.kind) {
    case 'text': {
      return { type: 'input_text', text: part.text };
    }
    case 'image': {
      return { type: 'input_image', image_url: dataUri(part), detail: 'auto' };
    }
    /* A block the provider encrypted belongs to the Anthropic shape. This one
       encrypts the whole reasoning item instead, and the two are not the same
       bytes, so there is nothing here to hand back. */
    case 'redacted':
    case 'reasoning': {
      return undefined;
    }
  }
};

/**
 * What this shape hides inside a signature: the item's identifier and the
 * provider's encrypted copy of the reasoning.
 *
 * A signature is opaque to the package and means only what the shape that made
 * it says it means. This one is not a signature at all; it is the two fields
 * this shape needs to hand a reasoning item back.
 */
interface ReasoningSeal {
  readonly id: string;
  readonly encrypted_content: string;
}

const assertSeal = createAssert<ReasoningSeal>();

/**
 * The reasoning item to send back, or nothing when there is none to send.
 *
 * A malformed seal throws, which the caller turns into a failed call. It cannot
 * be repaired and sending the item without it would be refused anyway.
 */
const reasoningItem = (part: PromptPart): OpenAI.Responses.ResponseReasoningItem | undefined => {
  if (part.kind !== 'reasoning' || part.signature === undefined) {
    return undefined;
  }
  const seal = assertSeal(JSON.parse(part.signature));
  return {
    type: 'reasoning',
    id: seal.id,
    encrypted_content: seal.encrypted_content,
    /* Empty because that is how the item arrived. The encrypted copy is the
       authoritative one, and a summary this package wrote instead of the
       provider is a change to a block the provider signed. */
    summary: [],
  };
};

/**
 * One message, as the items this shape takes.
 *
 * The reasoning goes first, as its own item, which is the order the model
 * produced it in and the order this shape reports it in. A message with nothing
 * but reasoning produces no message item at all: an empty one is refused.
 */
const itemsOf = (message: PromptMessage): OpenAI.Responses.ResponseInputItem[] => {
  const thinking = message.parts.map(reasoningItem).filter(item => item !== undefined);
  const content = message.parts.map(renderPart).filter(part => part !== undefined);
  return content.length === 0 ? thinking : [...thinking, { role: message.role, content }];
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
  /* Without this the provider keeps the reasoning and hands back only an
     identifier, which is no use to a package that stores the session itself. */
  include: ['reasoning.encrypted_content'],
  store: false,
  instructions: prompt.system.map(part => part.text).join('\n'),
  ...(cacheKey === undefined ? {} : { prompt_cache_key: cacheKey }),
  input: prompt.messages.flatMap(itemsOf),
});

interface Counts {
  input_tokens: TokenCount;
  output_tokens: TokenCount;
  input_tokens_details?: { cached_tokens?: TokenCount | null } | null;
}

interface Reply {
  output: { content?: { text?: string }[] | null }[];
  status?: string | null;
  incomplete_details?: { reason?: string | null } | null;
  usage: Counts;
}

/**
 * Why this shape says the model stopped. A finished response says so in its
 * status; an unfinished one names the wall it hit.
 */
const incompleteReasons: Readonly<Record<string, StopReason>> = {
  max_output_tokens: 'maxTokens',
  content_filter: 'refusal',
};

const asStop = (
  status: string | null | undefined,
  reason: string | null | undefined
): StopReason => {
  if (status === 'completed') {
    return 'end';
  }
  return reason === null || reason === undefined
    ? 'unknown'
    : (incompleteReasons[reason] ?? 'unknown');
};

/** This shape names its frames, so the two events are matched on `type`. */
interface DeltaEvent {
  type: 'response.output_text.delta';
  delta: string;
}

interface CompletedEvent {
  type: 'response.completed';
  response: { usage: Counts };
}

/**
 * The frame that says the answer ended, whether it finished or was cut off.
 * The usage frame cannot say: a completed response and one stopped at the wall
 * both report their counts the same way.
 */
interface EndEvent {
  type: 'response.completed' | 'response.incomplete' | 'response.failed';
  response: { status?: string | null; incomplete_details?: { reason?: string | null } | null };
}

/**
 * This shape streams the thinking under a name of its own, and under two of
 * them: `reasoning_summary_text` when the provider returns a summary, and
 * `reasoning` when it returns the thinking itself. The kilo gateway relays
 * Anthropic through this shape and sends the second.
 */
interface ReasoningEvent {
  type: 'response.reasoning_summary_text.delta' | 'response.reasoning.delta';
  delta: string;
}

/**
 * The finished reasoning item, which is where the encrypted copy arrives. The
 * summary streamed in pieces before it; this closes the block, the way a
 * signature does on the Anthropic shape.
 */
interface ReasoningDoneEvent {
  type: 'response.output_item.done';
  item: { type: 'reasoning'; id: string; encrypted_content: string };
}

const assertReply = createAssert<Reply>();
const isDelta = createIs<DeltaEvent>();
const isCompleted = createIs<CompletedEvent>();
const isEnd = createIs<EndEvent>();
const isReasoning = createIs<ReasoningEvent>();
const isReasoningDone = createIs<ReasoningDoneEvent>();

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
    stop: asStop(parsed.status, parsed.incomplete_details?.reason),
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
  if (isReasoning(event)) {
    return { kind: 'reasoning', text: event.delta };
  }
  if (!isReasoningDone(event)) {
    return undefined;
  }
  const seal: ReasoningSeal = {
    id: event.item.id,
    encrypted_content: event.item.encrypted_content,
  };
  return { kind: 'reasoning', text: '', signature: JSON.stringify(seal) };
};

const toUsage = (event: unknown): Partial<ModelUsage> | undefined =>
  isCompleted(event) ? readUsage(event.response.usage) : undefined;

const toStop = (event: unknown): StopReason | undefined =>
  isEnd(event)
    ? asStop(
        event.response.status ?? (event.type === 'response.completed' ? 'completed' : undefined),
        event.response.incomplete_details?.reason
      )
    : undefined;

const responsesWire: Wire = {
  path: '/api/gateway/v1/responses',
  toBody,
  toReply,
  toDelta,
  toUsage,
  toStop,
};

export type { ResponsesBody };
export { responsesWire };
