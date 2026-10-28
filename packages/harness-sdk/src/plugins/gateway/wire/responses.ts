import { createIs } from 'typia';
import type { ModelUsage, StopReason } from '../../../core/model.js';
import { type ReasoningSeal, toBody } from './responses-body.js';
import { stopFrom, type Wire, type WirePart } from './wire.js';
import { costOf, type CostFields, readCached, type TokenCount } from './usage.js';

interface Counts extends CostFields {
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

const asStop = (
  status: string | null | undefined,
  reason: string | null | undefined
): StopReason => (status === 'completed' ? 'end' : (asIncomplete(reason) ?? 'unknown'));

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
const isModel = createIs<{ response: { model: string } }>();

const readUsage = (usage: Counts): Partial<ModelUsage> => ({
  ...readCached(
    usage.input_tokens,
    usage.output_tokens,
    usage.input_tokens_details?.cached_tokens ?? 0
  ),
  ...costOf(usage),
});

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

const toModel = (event: unknown): string | undefined =>
  isModel(event) && event.response.model.length > 0 ? event.response.model : undefined;

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
  toModel,
  toStop,
};

export { responsesWire };
