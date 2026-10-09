import { createIs } from 'typia';
import type { ModelUsage, StopReason } from '../../../core/model.js';
import { stopFrom, type Wire, type WirePart } from './wire.js';
import { readCached, type TokenCount } from './usage.js';
import { toBody } from './completions-body.js';

interface Counts {
  prompt_tokens: TokenCount;
  completion_tokens: TokenCount;
  prompt_tokens_details?: { cached_tokens?: TokenCount | null } | null;
}

const stopReasons: Readonly<Record<string, StopReason>> = {
  stop: 'end',
  length: 'maxTokens',
  content_filter: 'refusal',
  tool_calls: 'tools',
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

/**
 * A call, in pieces. The opening frame carries the identifier and the name, and
 * every frame after it carries another fragment of the arguments. Both may sit
 * on the opening frame, so `callStart` takes the fragment with them.
 *
 * There is no frame that closes a call on this shape. The next one opens the
 * next call, and the end of the stream closes the last.
 */
interface CallEvent {
  choices: {
    delta: {
      tool_calls: {
        id?: string | null;
        function?: { name?: string | null; arguments?: string | null } | null;
      }[];
    };
  }[];
}

const isDelta = createIs<DeltaEvent>();
const isCall = createIs<CallEvent>();
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
 *
 * A `content` of `""` is a placeholder a provider puts on the frame that
 * carries the thinking, not a word, so only a non-empty one is a text delta.
 * Reading the empty string as an answer would shadow the thinking beside it.
 */
const toDelta = (event: unknown): WirePart | undefined => {
  const said = isDelta(event) ? (event.choices[0]?.delta.content ?? undefined) : undefined;
  if (said !== undefined && said.length > 0) {
    return { kind: 'delta', text: said };
  }
  if (!isReasoning(event)) {
    return toCall(event);
  }
  const thought = event.choices[0]?.delta;
  const text = thought?.reasoning ?? thought?.reasoning_content ?? undefined;
  return text === undefined ? toCall(event) : { kind: 'reasoning', text };
};

/** The pieces of a call, kept apart from the per-token path above. */
const toCall = (event: unknown): WirePart | undefined => {
  const call = isCall(event) ? event.choices[0]?.delta.tool_calls[0] : undefined;
  if (call === undefined) {
    return undefined;
  }
  const text = call.function?.arguments ?? undefined;
  if (call.id === undefined || call.id === null) {
    return text === undefined ? undefined : { kind: 'callArguments', text };
  }
  return {
    kind: 'callStart',
    id: call.id,
    name: call.function?.name ?? '',
    ...(text === undefined || text.length === 0 ? {} : { text }),
  };
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
