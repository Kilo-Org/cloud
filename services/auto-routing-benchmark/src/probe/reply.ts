import * as z from 'zod';
import type { ProbeEndpoint } from './family';

const UsageSchema = z
  .object({
    // Responses names; chat uses the prompt/completion names below.
    input_tokens: z.number().nullish(),
    output_tokens: z.number().nullish(),
    input_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
    output_tokens_details: z
      .object({
        reasoning_tokens: z.number().nullish(),
        // The Messages API counts the thinking part of the output under this name.
        thinking_tokens: z.number().nullish(),
      })
      .nullish(),
    // The Messages API reports the cached prefixes beside the uncached input.
    cache_creation_input_tokens: z.number().nullish(),
    cache_read_input_tokens: z.number().nullish(),
    prompt_tokens: z.number().nullish(),
    completion_tokens: z.number().nullish(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
    completion_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish(),
    total_tokens: z.number().nullish(),
    // The gateway bills every call and reports the cost with the usage.
    cost: z.number().nonnegative().nullish(),
  })
  .loose();

const ChatChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative().optional(),
                  id: z.string().nullish(),
                  function: z
                    .object({ name: z.string().nullish(), arguments: z.string().nullish() })
                    .nullish(),
                })
              )
              .nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      })
    )
    .optional(),
  usage: UsageSchema.nullish(),
  error: z.object({ message: z.string().nullish() }).nullish(),
});

const ResponsesItemSchema = z.object({
  type: z.string(),
  id: z.string().nullish(),
  call_id: z.string().nullish(),
  name: z.string().nullish(),
  arguments: z.string().nullish(),
});

const ResponsesEventSchema = z.object({
  type: z.string(),
  delta: z.string().nullish(),
  item: ResponsesItemSchema.nullish(),
  item_id: z.string().nullish(),
  response: z
    .object({
      status: z.string().nullish(),
      incomplete_details: z.object({ reason: z.string().nullish() }).nullish(),
      usage: UsageSchema.nullish(),
      error: z.object({ message: z.string().nullish() }).nullish(),
      output: z.array(ResponsesItemSchema).nullish(),
    })
    .nullish(),
  error: z.object({ message: z.string().nullish() }).nullish(),
  message: z.string().nullish(),
});

const AnthropicBlockSchema = z.object({
  type: z.string(),
  id: z.string().nullish(),
  name: z.string().nullish(),
});

const AnthropicEventSchema = z.object({
  type: z.string(),
  index: z.number().int().nonnegative().nullish(),
  message: z.object({ usage: UsageSchema.nullish() }).nullish(),
  content_block: AnthropicBlockSchema.nullish(),
  delta: z
    .object({
      type: z.string().nullish(),
      text: z.string().nullish(),
      partial_json: z.string().nullish(),
      stop_reason: z.string().nullish(),
    })
    .nullish(),
  usage: UsageSchema.nullish(),
  error: z.object({ message: z.string().nullish() }).nullish(),
});

export type ProbeToolCall = { name: string; arguments: string };

export type ProbeReply = {
  text: string;
  costUsd: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  toolCalls: readonly ProbeToolCall[];
  finishReason: string;
  eventCount: number;
  lastEventTypes: readonly string[];
  /** A protocol-level error the gateway sent inside the stream. */
  errorMessage: string | null;
  /** Whether the stream carried the event that ends a reply. */
  terminal: boolean;
};

const EVENT_TAIL = 8;

/** Splits an SSE body into its `data:` payloads, in order. */
function sseData(stream: string): string[] {
  const payloads: string[] = [];
  for (const block of stream.replaceAll('\r\n', '\n').split('\n\n')) {
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).trimStart())
      .join('\n')
      .trim();
    if (data.length > 0) payloads.push(data);
  }
  return payloads;
}

/**
 * One SSE payload as its event, or null. A cut or timed-out stream routinely ends mid-event,
 * so an incomplete `data:` block is a property of the stream, not a failure of the call: the
 * caller notes it and the reply is classified by its stream state.
 */
function eventOf<T>(schema: z.ZodType<T>, payload: string): T | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type ProbeUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
};

function tokensOf(usage: z.infer<typeof UsageSchema> | null | undefined): ProbeUsage {
  const inputBase = usage?.input_tokens ?? usage?.prompt_tokens ?? null;
  const cacheRead = usage?.cache_read_input_tokens ?? null;
  const cacheWrite = usage?.cache_creation_input_tokens ?? null;
  return {
    // Chat and Responses report one input count that already covers the cached part; the
    // Messages API reports the uncached input beside the cache read and written prefixes,
    // and the CLI's usage counts all three as input.
    inputTokens:
      inputBase === null && cacheRead === null && cacheWrite === null
        ? null
        : (inputBase ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    cachedInputTokens:
      usage?.input_tokens_details?.cached_tokens ??
      usage?.prompt_tokens_details?.cached_tokens ??
      cacheRead,
    outputTokens: usage?.output_tokens ?? usage?.completion_tokens ?? null,
    reasoningTokens:
      usage?.output_tokens_details?.reasoning_tokens ??
      usage?.output_tokens_details?.thinking_tokens ??
      usage?.completion_tokens_details?.reasoning_tokens ??
      null,
    costUsd: usage?.cost ?? null,
  };
}

type MutableReply = {
  text: string;
  usage: ProbeUsage;
  calls: ProbeToolCall[];
  finishReason: string | null;
  eventCount: number;
  lastEventTypes: string[];
  errorMessage: string | null;
  terminal: boolean;
};

function emptyReply(): MutableReply {
  return {
    text: '',
    usage: tokensOf(null),
    calls: [],
    finishReason: null,
    eventCount: 0,
    lastEventTypes: [],
    errorMessage: null,
    terminal: false,
  };
}

function note(reply: MutableReply, type: string): void {
  reply.eventCount += 1;
  reply.lastEventTypes.push(type);
  if (reply.lastEventTypes.length > EVENT_TAIL) reply.lastEventTypes.shift();
}

function settle(r: MutableReply): ProbeReply {
  return {
    text: r.text,
    ...r.usage,
    toolCalls: r.calls,
    finishReason:
      r.finishReason ?? (r.calls.length > 0 ? 'tool-calls' : r.text.length > 0 ? 'stop' : 'other'),
    eventCount: r.eventCount,
    lastEventTypes: r.lastEventTypes,
    errorMessage: r.errorMessage,
    terminal: r.terminal,
  };
}

function parseChat(data: string[], reply: MutableReply): void {
  const streamed = new Map<number, ProbeToolCall>();
  for (const payload of data) {
    if (payload === '[DONE]') {
      note(reply, 'done');
      // The sentinel ends the stream: a cut stream never carries it, and a gateway may close
      // the reply with it instead of a finish-reason chunk.
      reply.terminal = true;
      continue;
    }
    const chunk = eventOf(ChatChunkSchema, payload);
    if (chunk === null) {
      note(reply, 'unparsed_chunk');
      continue;
    }
    note(reply, chunk.error ? 'error' : 'chunk');
    if (chunk.error) {
      reply.errorMessage = chunk.error.message ?? 'chat stream error';
      continue;
    }
    if (chunk.usage) reply.usage = tokensOf(chunk.usage);
    for (const choice of chunk.choices ?? []) {
      reply.text += choice.delta?.content ?? '';
      for (const call of choice.delta?.tool_calls ?? []) {
        const index = call.index ?? streamed.size;
        const current = streamed.get(index) ?? { name: '', arguments: '' };
        streamed.set(index, {
          // Some providers send the name once and an empty name on every argument chunk.
          name: call.function?.name ? call.function.name : current.name,
          arguments: current.arguments + (call.function?.arguments ?? ''),
        });
      }
      if (choice.finish_reason) {
        reply.finishReason =
          choice.finish_reason === 'tool_calls'
            ? 'tool-calls'
            : choice.finish_reason === 'content_filter'
              ? 'content-filter'
              : choice.finish_reason;
        reply.terminal = true;
      }
    }
  }
  reply.calls = [...streamed.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
}

function parseResponses(data: string[], reply: MutableReply): void {
  const items = new Map<string, ProbeToolCall>();
  const order: string[] = [];
  // One function call arrives as several events (output_item.added, argument deltas,
  // output_item.done) that name it by its item id, its call id, or both. Every identifier a
  // call was seen under resolves to the same entry, so it is counted once.
  const aliases = new Map<string, string>();
  const keyOf = (identifiers: readonly (string | null | undefined)[]) => {
    const known = identifiers
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map(value => aliases.get(value))
      .find(key => key !== undefined);
    const key =
      known ??
      identifiers.find(value => typeof value === 'string' && value.length > 0) ??
      `call_${items.size}`;
    for (const identifier of identifiers) {
      if (typeof identifier === 'string' && identifier.length > 0) aliases.set(identifier, key);
    }
    if (!items.has(key)) {
      order.push(key);
      items.set(key, { name: '', arguments: '' });
    }
    return key;
  };
  const accept = (item: z.infer<typeof ResponsesItemSchema>) => {
    if (item.type !== 'function_call') return;
    const key = keyOf([item.id, item.call_id]);
    const current = items.get(key) ?? { name: '', arguments: '' };
    items.set(key, {
      name: item.name ?? current.name,
      arguments: item.arguments ?? current.arguments,
    });
  };
  for (const payload of data) {
    if (payload === '[DONE]') {
      note(reply, 'done');
      continue;
    }
    const event = eventOf(ResponsesEventSchema, payload);
    if (event === null) {
      note(reply, 'unparsed_event');
      continue;
    }
    note(reply, event.type);
    switch (event.type) {
      case 'response.output_text.delta':
        reply.text += event.delta ?? '';
        break;
      case 'response.output_item.added':
      case 'response.output_item.done':
        if (event.item) accept(event.item);
        break;
      case 'response.function_call_arguments.delta': {
        const key = keyOf([event.item_id]);
        const current = items.get(key) ?? { name: '', arguments: '' };
        items.set(key, { ...current, arguments: current.arguments + (event.delta ?? '') });
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
        if (event.response?.usage) reply.usage = tokensOf(event.response.usage);
        for (const item of event.response?.output ?? []) accept(item);
        reply.finishReason =
          event.type === 'response.incomplete'
            ? event.response?.incomplete_details?.reason === 'max_output_tokens'
              ? 'length'
              : 'other'
            : 'stop';
        reply.terminal = true;
        break;
      case 'response.failed':
        if (event.response?.usage) reply.usage = tokensOf(event.response.usage);
        reply.errorMessage = event.response?.error?.message ?? 'response failed';
        reply.terminal = true;
        break;
      default:
        if (event.type === 'error') {
          reply.errorMessage = event.error?.message ?? event.message ?? 'stream error';
        }
        break;
    }
  }
  reply.calls = order.flatMap(key => items.get(key) ?? []);
  if (reply.finishReason === 'stop' && reply.calls.length > 0) reply.finishReason = 'tool-calls';
}

// The Messages API streams one event per content block: a tool call is announced by
// content_block_start (id and name) and its input arrives as input_json_delta fragments,
// so the call is complete only once its block stops or the message ends.
function parseAnthropic(data: string[], reply: MutableReply): void {
  const calls = new Map<number, ProbeToolCall>();
  for (const payload of data) {
    if (payload === '[DONE]') {
      note(reply, 'done');
      continue;
    }
    const event = eventOf(AnthropicEventSchema, payload);
    if (event === null) {
      note(reply, 'unparsed_event');
      continue;
    }
    note(reply, event.type);
    switch (event.type) {
      case 'message_start':
        if (event.message?.usage) reply.usage = tokensOf(event.message.usage);
        break;
      case 'content_block_start':
        if (event.content_block?.type === 'tool_use') {
          calls.set(event.index ?? calls.size, {
            name: event.content_block.name ?? '',
            arguments: '',
          });
        }
        break;
      case 'content_block_delta': {
        const index = event.index ?? 0;
        if (event.delta?.text !== undefined) reply.text += event.delta.text;
        if (event.delta?.partial_json !== undefined) {
          const current = calls.get(index) ?? { name: '', arguments: '' };
          calls.set(index, {
            name: current.name,
            arguments: current.arguments + event.delta.partial_json,
          });
        }
        break;
      }
      case 'message_delta': {
        if (event.usage) {
          // The closing usage is the message's cumulative one: the gateway fills in the
          // input and cache counts only here, so it wins over `message_start`.
          const usage = tokensOf(event.usage);
          reply.usage = {
            inputTokens: usage.inputTokens ?? reply.usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens ?? reply.usage.cachedInputTokens,
            outputTokens: usage.outputTokens ?? reply.usage.outputTokens,
            reasoningTokens: usage.reasoningTokens ?? reply.usage.reasoningTokens,
            costUsd: usage.costUsd ?? reply.usage.costUsd,
          };
        }
        const stopReason = event.delta?.stop_reason;
        if (stopReason) {
          reply.finishReason =
            stopReason === 'tool_use'
              ? 'tool-calls'
              : stopReason === 'max_tokens'
                ? 'length'
                : stopReason === 'end_turn' || stopReason === 'stop_sequence'
                  ? 'stop'
                  : stopReason;
        }
        break;
      }
      case 'message_stop':
        reply.terminal = true;
        break;
      case 'error':
        reply.errorMessage = event.error?.message ?? 'stream error';
        break;
      default:
        break;
    }
  }
  reply.calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (reply.calls.length > 0 && reply.finishReason === null) reply.finishReason = 'tool-calls';
}

/**
 * Parses a complete gateway SSE body for one probe request. `terminal` is false when the
 * stream ended without the event that closes a reply, which is how a cut stream looks.
 */
export function parseProbeStream(endpoint: ProbeEndpoint, stream: string): ProbeReply {
  const reply = emptyReply();
  const data = sseData(stream);
  if (endpoint === 'responses') parseResponses(data, reply);
  else if (endpoint === 'anthropic') parseAnthropic(data, reply);
  else parseChat(data, reply);
  return settle(reply);
}
