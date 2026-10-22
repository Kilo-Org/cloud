import { createIs } from 'typia';
import type { ModelUsage, StopReason } from '../../../core/model.js';
import { toBody } from './messages-body.js';
import { stopFrom, type Wire, type WirePart } from './wire.js';
import { costOf, type CostFields, type Counts, set, type TokenCount } from './usage.js';

/**
 * The shapes are matched structurally, not by a `type` discriminator: gateways
 * relay a dozen models and only agree on where the numbers sit, not on how the
 * frames are named. Extra fields are allowed; typia's `is` ignores them.
 */
interface WireUsage extends CostFields {
  input_tokens?: TokenCount | null;
  output_tokens?: TokenCount | null;
  cache_read_input_tokens?: TokenCount | null;
  cache_creation_input_tokens?: TokenCount | null;
}

/**
 * Why this shape says the model stopped. `pause_turn` is not mapped: nothing
 * here has produced one, and naming it would claim a meaning nothing has
 * tested.
 *
 * The keys are strings and not `Anthropic.StopReason`. The union trails the
 * provider: at 0.104.1 it did not carry `model_context_window_exceeded`, which
 * the provider documents and sends, and 0.137.0 adds it. The next name either
 * the provider or a relay between puts on a stop reason would arrive the same
 * way, and a shape that drops what it read is worse than one that maps a name
 * the SDK has not published yet. The two OpenAI shapes have no such gap;
 * keeping all three the same way is worth more than one of them typechecking
 * against a vendor list.
 */
const stopReasons: Readonly<Record<string, StopReason>> = {
  end_turn: 'end',
  stop_sequence: 'end',
  max_tokens: 'maxTokens',
  /* A second wall, and the provider's own guidance is to treat it as
     truncated: the answer stopped because the model's window filled, not
     because `max_tokens` did. Both leave half a sentence, which is what
     `maxTokens` names here. */
  model_context_window_exceeded: 'maxTokens',
  refusal: 'refusal',
  tool_use: 'tools',
};

const asStop = stopFrom(stopReasons);

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

/** The block that opens a call. The arguments follow it, a fragment at a time. */
interface CallStartEvent {
  content_block: { type: 'tool_use'; id: string; name: string };
}

/** One fragment of the arguments, as text. This shape streams them as JSON. */
interface CallArgumentsEvent {
  delta: { partial_json: string };
}

/** The end of any block. It closes a call when one is open, and nothing when not. */
interface BlockEndEvent {
  type: 'content_block_stop';
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

/** A stream event is an edge, so it is validated before the package believes it. */
const isDelta = createIs<DeltaEvent>();
const isThinking = createIs<ThinkingEvent>();
const isSignature = createIs<SignatureEvent>();
const isRedacted = createIs<RedactedEvent>();
const isCallStart = createIs<CallStartEvent>();
const isCallArguments = createIs<CallArgumentsEvent>();
const isBlockEnd = createIs<BlockEndEvent>();
const isUsage = createIs<UsageEvent>();
const isStop = createIs<StopEvent>();
const isStart = createIs<StartEvent>();
const isModel = createIs<{ message: { model: string } }>();

const readUsage = (usage: WireUsage): Partial<ModelUsage> => {
  const counts: Counts = {};
  set(counts, 'inputTokens', usage.input_tokens);
  set(counts, 'outputTokens', usage.output_tokens);
  set(counts, 'cacheReadTokens', usage.cache_read_input_tokens);
  set(counts, 'cacheWriteTokens', usage.cache_creation_input_tokens);
  return { ...counts, ...costOf(usage) };
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
  if (isRedacted(event)) {
    return { kind: 'redacted', data: event.content_block.data };
  }
  return toCall(event);
};

/** The three frames of a tool call, kept apart from the per-token path above. */
const toCall = (event: unknown): WirePart | undefined => {
  if (isCallStart(event)) {
    return { kind: 'callStart', id: event.content_block.id, name: event.content_block.name };
  }
  if (isCallArguments(event)) {
    return { kind: 'callArguments', text: event.delta.partial_json };
  }
  return isBlockEnd(event) ? { kind: 'callEnd' } : undefined;
};

const toUsage = (event: unknown): Partial<ModelUsage> | undefined => {
  if (isStart(event)) {
    return readUsage(event.message.usage);
  }
  return isUsage(event) ? readUsage(event.usage) : undefined;
};

const toStop = (event: unknown): StopReason | undefined =>
  isStop(event) ? asStop(event.delta.stop_reason) : undefined;

const toModel = (event: unknown): string | undefined =>
  isModel(event) && event.message.model.length > 0 ? event.message.model : undefined;

const messagesWire: Wire = {
  path: '/api/gateway/v1/messages',
  toBody,
  toDelta,
  toUsage,
  toModel,
  toStop,
};

export { messagesWire };
