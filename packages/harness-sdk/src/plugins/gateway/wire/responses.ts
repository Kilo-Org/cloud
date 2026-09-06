import type OpenAI from 'openai';
import { createAssert, createIs } from 'typia';
import type { ModelRequest, ModelUsage, StopReason } from '../../../core/model.js';
import type { PromptMessage, PromptPart } from '../../../core/prompt.js';
import type { ToolDefinition } from '../../../core/tool.js';
import { dataUri, resultText } from './parts.js';
import { stopFrom, type Wire, type WirePart } from './wire.js';
import { readCached, type TokenCount } from './usage.js';

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
    /* A block the provider encrypted belongs to the Anthropic shape: this one
       encrypts the whole reasoning item instead, and the two are not the same
       bytes. A call and its result are items beside the message, not content in
       it. All four are rendered by `itemsOf`, or by nothing at all. */
    case 'redacted':
    case 'reasoning':
    case 'toolCall':
    case 'toolResult': {
      return undefined;
    }
  }
};

/**
 * A call, or its result, as the item this shape takes. The arguments go across
 * as the text the model wrote, which is what this shape asks for, so a call
 * that could not be run replays exactly as it was made. There is no flag for a
 * failed result here, so the text says so instead.
 */
const toolItem = (part: PromptPart): OpenAI.Responses.ResponseInputItem | undefined => {
  if (part.kind === 'toolCall') {
    return {
      type: 'function_call',
      call_id: part.callId,
      name: part.name,
      arguments: part.arguments,
    };
  }
  return part.kind === 'toolResult'
    ? {
        type: 'function_call_output',
        call_id: part.callId,
        output: resultText(part.body, part.failed),
      }
    : undefined;
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
  const tools = message.parts.map(toolItem).filter(item => item !== undefined);
  const said = content.length === 0 ? [] : [{ role: message.role, content }];
  return [...thinking, ...said, ...tools];
};

/**
 * A tool, as this shape takes one. `strict` is false because the schema comes
 * from the caller unchanged: strict mode adds rules a hand-written schema will
 * not always meet, and a rejected schema is a session that cannot start.
 */
const toolItemFor = (tool: ToolDefinition): OpenAI.Responses.FunctionTool => ({
  type: 'function',
  name: tool.name,
  description: tool.description,
  parameters: { ...tool.parameters },
  strict: false,
});

const toBody = ({
  prompt,
  model,
  maxTokens,
  cacheKey,
  effort,
  tools,
}: ModelRequest): ResponsesBody => ({
  model,
  max_output_tokens: maxTokens,
  stream: true,
  ...(effort === undefined ? {} : { reasoning: { effort } }),
  /* Without this the provider keeps the reasoning and hands back only an
     identifier, which is no use to a package that stores the session itself. */
  include: ['reasoning.encrypted_content'],
  store: false,
  instructions: prompt.system.map(part => part.text).join('\n'),
  ...(cacheKey === undefined ? {} : { prompt_cache_key: cacheKey }),
  ...(tools === undefined || tools.length === 0 ? {} : { tools: tools.map(toolItemFor) }),
  input: prompt.messages.flatMap(itemsOf),
});

interface Counts {
  input_tokens: TokenCount;
  output_tokens: TokenCount;
  input_tokens_details?: { cached_tokens?: TokenCount | null } | null;
}

/**
 * Why this shape says the model stopped. A finished response says so in its
 * status; an unfinished one names the wall it hit.
 */
const incompleteReasons: Readonly<Record<string, StopReason>> = {
  max_output_tokens: 'maxTokens',
  content_filter: 'refusal',
};

const asIncomplete = stopFrom(incompleteReasons);

const asStop = (status: string | null | undefined, reason: string | null | undefined): StopReason =>
  status === 'completed' ? 'end' : (asIncomplete(reason) ?? 'unknown');

/** This shape names its frames, so the two events are matched on `type`. */
interface DeltaEvent {
  type: 'response.output_text.delta';
  delta: string;
}

/**
 * The frame that carries the counts, which is either frame that ends an answer:
 * one stopped at the wall reports them exactly as a finished one does. Reading
 * only the finished one counts a truncated answer as zero, and the session then
 * believes its window is empty.
 */
interface CompletedEvent {
  type: 'response.completed' | 'response.incomplete';
  response: { usage: Counts };
}

/** The frame that says the answer ended, and names the wall when it hit one. */
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

/** The item that opens a call. `call_id` names the call; `id` names the item. */
interface CallStartEvent {
  type: 'response.output_item.added';
  item: { type: 'function_call'; call_id: string; name: string };
}

/** One fragment of the arguments, as text. */
interface CallArgumentsEvent {
  type: 'response.function_call_arguments.delta';
  delta: string;
}

/** The finished call item. The arguments already streamed, so this only closes. */
interface CallEndEvent {
  type: 'response.output_item.done';
  item: { type: 'function_call' };
}

const isDelta = createIs<DeltaEvent>();
const isCallStart = createIs<CallStartEvent>();
const isCallArguments = createIs<CallArgumentsEvent>();
const isCallEnd = createIs<CallEndEvent>();
const isCompleted = createIs<CompletedEvent>();
const isEnd = createIs<EndEvent>();
const isReasoning = createIs<ReasoningEvent>();
const isReasoningDone = createIs<ReasoningDoneEvent>();

const readUsage = (usage: Counts): Partial<ModelUsage> =>
  readCached(
    usage.input_tokens,
    usage.output_tokens,
    usage.input_tokens_details?.cached_tokens ?? 0
  );

const toDelta = (event: unknown): WirePart | undefined => {
  if (isDelta(event)) {
    return { kind: 'delta', text: event.delta };
  }
  if (isReasoning(event)) {
    return { kind: 'reasoning', text: event.delta };
  }
  if (!isReasoningDone(event)) {
    return toCall(event);
  }
  const seal: ReasoningSeal = {
    id: event.item.id,
    encrypted_content: event.item.encrypted_content,
  };
  return { kind: 'reasoning', text: '', signature: JSON.stringify(seal) };
};

/** The three frames of a tool call, kept apart from the per-token path above. */
const toCall = (event: unknown): WirePart | undefined => {
  if (isCallStart(event)) {
    return { kind: 'callStart', id: event.item.call_id, name: event.item.name };
  }
  if (isCallArguments(event)) {
    return { kind: 'callArguments', text: event.delta };
  }
  return isCallEnd(event) ? { kind: 'callEnd' } : undefined;
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
  toDelta,
  toUsage,
  toStop,
};

export { responsesWire };
