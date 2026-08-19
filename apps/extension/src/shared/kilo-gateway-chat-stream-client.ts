/* eslint-disable max-lines, max-classes-per-file */
import type {
  KiloGatewayChatCompletion,
  KiloGatewayChatMessage,
  KiloGatewayToolCallRequest,
  KiloGatewayToolDefinition,
  KiloGatewayToolName,
} from './kilo-gateway-chat-client';
import type { FetchLike } from './auth';
import { z } from 'zod';

interface FetchKiloGatewayChatCompletionStreamOptions {
  readonly apiBaseUrl: string;
  readonly fetch: FetchLike;
  readonly messages: KiloGatewayChatMessage[];
  readonly model: string;
  readonly onContentDelta: (delta: string) => void;
  readonly onReasoningDelta?: ((delta: string) => void) | undefined;
  readonly organizationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Abort and throw KiloGatewayStreamStalledError when the whole completion exceeds this. */
  readonly completionTimeoutMs?: number | undefined;
  /** Abort and throw KiloGatewayStreamStalledError when no bytes arrive for this long. */
  readonly stallTimeoutMs?: number | undefined;
  readonly thinkingEffort?: string | undefined;
  readonly token: string;
  readonly tools: KiloGatewayToolDefinition[];
}

/** A streaming request that stopped delivering bytes or ran far too long. Callers may retry. */
export class KiloGatewayStreamStalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KiloGatewayStreamStalledError';
  }
}

/** A non-OK gateway HTTP response. Callers may retry 429/5xx. */
export class KiloGatewayHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Failed to fetch gateway chat completion stream: ${String(status)}`);
    this.name = 'KiloGatewayHttpError';
    this.status = status;
  }
}

const DEFAULT_STALL_TIMEOUT_MS = 45_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 90_000;

interface StreamingToolCallBuffer {
  arguments: string;
  id: string | undefined;
  name: string | undefined;
}

interface StreamingAccumulator {
  content: string;
  finishReason: string | undefined;
  isDone: boolean;
  pendingText: string;
  reasoning: string;
  reasoningDetailsByIndex: Map<number, Record<string, unknown>>;
  toolCallsByIndex: Map<number, StreamingToolCallBuffer>;
  usage: KiloGatewayChatCompletion['usage'];
}

interface StreamingDeltaHandlers {
  readonly onContentDelta: (delta: string) => void;
  readonly onReasoningDelta: (delta: string) => void;
}

interface StreamReaderContext {
  readonly accumulator: StreamingAccumulator;
  readonly decoder: TextDecoder;
  readonly handlers: StreamingDeltaHandlers;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');
const organizationHeaderName = 'x-kilocode-organizationid';
// Map exposed catalog variants to the gateway reasoning effort. `xhigh` and `max` both run at xhigh effort; `max` additionally requests maximum verbosity (handled in toReasoningRequest).
const variantToGatewayEffort: Record<string, string> = {
  high: 'high',
  instant: 'none',
  low: 'low',
  max: 'xhigh',
  medium: 'medium',
  minimal: 'minimal',
  none: 'none',
  xhigh: 'xhigh',
};
const toolArgumentsSchema = z.record(z.string(), z.unknown());
const streamingToolCallDeltaSchema = z.object({
  function: z
    .object({
      arguments: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  id: z.string().optional(),
  index: z.number(),
});
// Prompt_tokens drives the context-usage ratio; cost is optional session spend (USD).
const usageSchema = z.object({
  cost: z.number().nullish(),
  prompt_tokens: z.number(),
});
const streamDataSchema = z.object({
  choices: z.array(
    z.object({
      // Providers may send a finish-only chunk with no delta at all.
      delta: z
        .object({
          content: z.string().nullable().optional(),
          reasoning: z.string().nullable().optional(),
          reasoning_details: z.array(z.unknown()).nullable().optional(),
          tool_calls: z.array(z.unknown()).optional(),
        })
        .optional(),
      finish_reason: z.string().nullable().optional(),
    })
  ),
  usage: usageSchema.nullable().optional(),
});
// Reasoning blocks stream incrementally like content: text accumulates while structural fields (type/signature/data/index) carry their final value. Providers may require these signed/encrypted blocks replayed verbatim on the assistant tool-call message or they reject the continuation.
const appendableReasoningKeys = new Set(['data', 'summary', 'text']);
const mergeReasoningDetail = (
  detailsByIndex: Map<number, Record<string, unknown>>,
  block: unknown,
  fallbackIndex: number
): void => {
  const parsed = toolArgumentsSchema.safeParse(block);

  if (!parsed.success) {
    return;
  }

  const record = parsed.data;
  const index = typeof record['index'] === 'number' ? record['index'] : fallbackIndex;
  const current = detailsByIndex.get(index) ?? {};

  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && value !== null) {
      const existing = current[key];

      current[key] =
        appendableReasoningKeys.has(key) &&
        typeof value === 'string' &&
        typeof existing === 'string'
          ? existing + value
          : value;
    }
  }

  detailsByIndex.set(index, current);
};
const toReasoningRequest = (
  variant: string | undefined
): { reasoning: { effort: string; enabled: boolean }; verbosity?: 'max' } | undefined => {
  const gatewayEffort = variant === undefined ? undefined : variantToGatewayEffort[variant];

  if (gatewayEffort === undefined) {
    return;
  }

  return {
    reasoning: { effort: gatewayEffort, enabled: gatewayEffort !== 'none' },
    ...(variant === 'max' ? { verbosity: 'max' } : {}),
  };
};
const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError('Gateway stream JSON was invalid.');
  }
};
const getString = (value: unknown, message: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(message);
  }

  return value;
};
const parseToolCallBuffer = (
  value: StreamingToolCallBuffer,
  allowedToolNames: ReadonlySet<KiloGatewayToolName>
): KiloGatewayToolCallRequest => {
  const name =
    value.name === undefined
      ? undefined
      : [...allowedToolNames].find(allowed => allowed === value.name);

  if (name === undefined) {
    throw new TypeError('Gateway stream tool call did not include a supported tool name.');
  }

  const parsedArguments = (() => {
    try {
      // Bedrock-served Claude streams a zero-argument tool call as a single empty
      // `arguments: ""` delta; an empty accumulated buffer is a zero-argument call.
      return value.arguments === '' ? {} : parseJson(value.arguments);
    } catch {
      throw new TypeError('Gateway tool call arguments were not valid JSON.');
    }
  })();

  const argumentsRecord = toolArgumentsSchema.safeParse(parsedArguments);

  if (!argumentsRecord.success) {
    throw new TypeError('Gateway tool call arguments were not an object.');
  }

  return {
    arguments: argumentsRecord.data,
    id: getString(value.id, 'Gateway eval tool call did not include an id.'),
    name,
  };
};
// SSE allows CRLF, LF, or CR; a blank line ends a record. Match a real upstream regardless of framing.
const sseRecordSeparator = /\r\n\r\n|\r\r|\n\n/;
const sseLineSeparator = /\r\n|\r|\n/;
const parseServerSentEvents = (text: string): string[] =>
  text
    .split(sseRecordSeparator)
    .flatMap(block => {
      const dataLines = block
        .split(sseLineSeparator)
        .map(line => line.trim())
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim());

      return dataLines.length === 0 ? [] : [dataLines.join('\n')];
    })
    .filter(data => data.length > 0);
const mergeStreamingToolCall = (
  toolCallsByIndex: Map<number, StreamingToolCallBuffer>,
  value: unknown
): void => {
  const parsed = streamingToolCallDeltaSchema.safeParse(value);

  if (!parsed.success) {
    throw new TypeError('Gateway stream tool call delta did not include an index.');
  }

  const { index } = parsed.data;
  const current = toolCallsByIndex.get(index) ?? {
    arguments: '',
    id: undefined,
    name: undefined,
  };
  const functionValue = parsed.data.function;
  const next: StreamingToolCallBuffer = {
    arguments: current.arguments,
    id: parsed.data.id ?? current.id,
    name: current.name,
  };

  if (functionValue !== undefined) {
    if (functionValue.name !== undefined) {
      next.name =
        current.name === undefined ? functionValue.name : current.name + functionValue.name;
    }

    if (functionValue.arguments !== undefined) {
      next.arguments += functionValue.arguments;
    }
  }

  toolCallsByIndex.set(index, next);
};
const applyStreamingData = (
  accumulator: StreamingAccumulator,
  data: string,
  handlers: StreamingDeltaHandlers
): void => {
  if (data === '[DONE]') {
    accumulator.isDone = true;
    return;
  }

  const parsed = streamDataSchema.safeParse(parseJson(data));

  if (!parsed.success) {
    return;
  }

  if (parsed.data.usage !== undefined && parsed.data.usage !== null) {
    const { cost, prompt_tokens: promptTokens } = parsed.data.usage;
    accumulator.usage = {
      promptTokens,
      ...(typeof cost === 'number' ? { costUsd: cost } : {}),
    };
  }

  const choice = parsed.data.choices.at(0);

  if (choice === undefined) {
    return;
  }

  if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
    accumulator.finishReason = choice.finish_reason;
  }

  const { delta } = choice;
  if (delta === undefined) {
    return;
  }
  const { content, reasoning, reasoning_details: reasoningDetails, tool_calls: toolCalls } = delta;

  if (typeof content === 'string' && content.length > 0) {
    accumulator.content += content;
    handlers.onContentDelta(content);
  }

  if (typeof reasoning === 'string' && reasoning.length > 0) {
    accumulator.reasoning += reasoning;
    handlers.onReasoningDelta(reasoning);
  }

  if (Array.isArray(reasoningDetails)) {
    reasoningDetails.forEach((block, position) => {
      mergeReasoningDetail(accumulator.reasoningDetailsByIndex, block, position);
    });
  }

  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      mergeStreamingToolCall(accumulator.toolCallsByIndex, toolCall);
    }
  }
};
const toCompletion = (
  accumulator: StreamingAccumulator,
  allowedToolNames: ReadonlySet<KiloGatewayToolName>
): KiloGatewayChatCompletion => {
  const reasoningDetails = [...accumulator.reasoningDetailsByIndex.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, block]) => block);

  return {
    ...(accumulator.content === '' ? {} : { content: accumulator.content }),
    ...(accumulator.finishReason === undefined ? {} : { finishReason: accumulator.finishReason }),
    ...(accumulator.reasoning === '' ? {} : { reasoning: accumulator.reasoning }),
    ...(reasoningDetails.length === 0 ? {} : { reasoningDetails }),
    ...(accumulator.usage === undefined ? {} : { usage: accumulator.usage }),
    toolCalls: [...accumulator.toolCallsByIndex.values()].map(toolCall =>
      parseToolCallBuffer(toolCall, allowedToolNames)
    ),
  };
};

// eslint-disable-next-line max-params -- The test-only parser mirrors the live consume signature.
export const parseKiloGatewayChatCompletionStream = (
  text: string,
  allowedToolNames: ReadonlySet<KiloGatewayToolName>,
  onContentDelta: (delta: string) => void,
  onReasoningDelta: (delta: string) => void = () => {}
): KiloGatewayChatCompletion => {
  const accumulator: StreamingAccumulator = {
    content: '',
    finishReason: undefined,
    isDone: false,
    pendingText: '',
    reasoning: '',
    reasoningDetailsByIndex: new Map(),
    toolCallsByIndex: new Map(),
    usage: undefined,
  };
  const handlers = { onContentDelta, onReasoningDelta };

  for (const data of parseServerSentEvents(text)) {
    applyStreamingData(accumulator, data, handlers);

    if (accumulator.isDone) {
      break;
    }
  }

  return toCompletion(accumulator, allowedToolNames);
};
const consumeStreamReader = async ({
  accumulator,
  decoder,
  handlers,
  reader,
}: StreamReaderContext): Promise<void> => {
  if (accumulator.isDone) {
    return;
  }

  const { done, value } = await reader.read();

  accumulator.pendingText += decoder.decode(value, { stream: !done });

  const blocks = accumulator.pendingText.split(sseRecordSeparator);
  accumulator.pendingText = blocks.pop() ?? '';

  for (const data of parseServerSentEvents(blocks.join('\n\n'))) {
    applyStreamingData(accumulator, data, handlers);

    if (accumulator.isDone) {
      return;
    }
  }

  if (done) {
    accumulator.isDone = true;
    return;
  }

  await consumeStreamReader({ accumulator, decoder, handlers, reader });
};
const consumeKiloGatewayChatCompletionStream = async (
  body: ReadableStream<Uint8Array>,
  handlers: StreamingDeltaHandlers,
  allowedToolNames: ReadonlySet<KiloGatewayToolName>
): Promise<KiloGatewayChatCompletion> => {
  const accumulator: StreamingAccumulator = {
    content: '',
    finishReason: undefined,
    isDone: false,
    pendingText: '',
    reasoning: '',
    reasoningDetailsByIndex: new Map(),
    toolCallsByIndex: new Map(),
    usage: undefined,
  };
  const reader = body.getReader();
  const decoder = new TextDecoder();

  await consumeStreamReader({ accumulator, decoder, handlers, reader });

  for (const data of parseServerSentEvents(accumulator.pendingText)) {
    applyStreamingData(accumulator, data, handlers);
  }

  return toCompletion(accumulator, allowedToolNames);
};
export const fetchKiloGatewayChatCompletionStream = async ({
  apiBaseUrl,
  fetch,
  messages,
  model,
  onContentDelta,
  onReasoningDelta = () => {},
  organizationId,
  signal,
  completionTimeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
  thinkingEffort,
  token,
  tools,
}: FetchKiloGatewayChatCompletionStreamOptions): Promise<KiloGatewayChatCompletion> => {
  const reasoningRequest = toReasoningRequest(thinkingEffort);
  const allowedToolNames = new Set(tools.map(tool => tool.function.name));
  const requestBody = {
    messages,
    model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
    tool_choice: tools.length === 0 ? 'none' : 'auto',
    tools,
  };

  // Watchdog: a stalled response — before the first byte or mid-stream — surfaces as a typed, retriable error instead of hanging the turn forever. Each read races against the stall timer, so the guarantee holds even when the underlying fetch ignores its abort signal.
  const stallController = new AbortController();
  const stall: {
    cancelReader?: () => void;
    error?: Error;
    reject?: (error: Error) => void;
    stalled: boolean;
    timer?: ReturnType<typeof setTimeout>;
    totalTimer?: ReturnType<typeof setTimeout>;
  } = { stalled: false };
  // eslint-disable-next-line promise/avoid-new -- A deferred rejection has no promise-returning primitive to defer to.
  const stallPromise = new Promise<never>((_resolve, reject) => {
    stall.reject = reject;
  });
  // The race consumes this rejection; this guard keeps it from surfacing as an unhandled rejection when the stream completes first.
  // eslint-disable-next-line promise/prefer-await-to-then -- Marking the rejection handled must not block this function.
  stallPromise.catch(() => {});
  const failStalled = (message: string): void => {
    stall.stalled = true;
    stall.error = new KiloGatewayStreamStalledError(message);
    stallController.abort();
    // Reject before cancelling: cancel resolves the pending read as a clean end-of-stream, which must not win the race against the stall error.
    stall.reject?.(stall.error);
    stall.cancelReader?.();
  };
  const armWatchdog = (): void => {
    clearTimeout(stall.timer);
    stall.timer = setTimeout(() => {
      failStalled(`Gateway stream stalled: no data for ${String(stallTimeoutMs)} ms.`);
    }, stallTimeoutMs);
  };
  // The total cap catches a provider that keeps trickling bytes forever; a retry lets the router pick a faster route.
  stall.totalTimer = setTimeout(() => {
    failStalled(`Gateway completion exceeded ${String(completionTimeoutMs)} ms and was cut off.`);
  }, completionTimeoutMs);
  const onCallerAbort = (): void => {
    stallController.abort();
    const abortError = new Error('The user aborted a request.');
    abortError.name = 'AbortError';
    stall.reject?.(abortError);
  };
  if (signal?.aborted === true) {
    stallController.abort();
  }
  signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    armWatchdog();
    const response = await Promise.race([
      fetch(`${trimTrailingSlash(apiBaseUrl)}/api/gateway/v1/chat/completions`, {
        body: JSON.stringify(
          reasoningRequest === undefined ? requestBody : { ...requestBody, ...reasoningRequest }
        ),
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(organizationId === undefined || organizationId === ''
            ? {}
            : { [organizationHeaderName]: organizationId }),
        },
        method: 'POST',
        signal: stallController.signal,
      }),
      stallPromise,
    ]);
    if (!response.ok) {
      throw new KiloGatewayHttpError(response.status);
    }
    if (response.body === null) {
      throw new Error('Gateway chat completion stream did not include a body.');
    }
    const sourceReader = response.body.getReader();
    stall.cancelReader = () => {
      // eslint-disable-next-line promise/prefer-await-to-then -- Fire-and-forget socket cleanup must not block the stall path.
      void sourceReader.cancel().catch(() => {});
    };
    const watchedBody = new ReadableStream<Uint8Array>({
      cancel: reason => sourceReader.cancel(reason),
      async pull(controller) {
        const { done, value } = await Promise.race([sourceReader.read(), stallPromise]);
        armWatchdog();
        if (done) {
          controller.close();
          return;
        }
        if (value !== undefined) {
          controller.enqueue(value);
        }
      },
    });
    return await consumeKiloGatewayChatCompletionStream(
      watchedBody,
      { onContentDelta, onReasoningDelta },
      allowedToolNames
    );
  } catch (error) {
    if (stall.stalled && signal?.aborted !== true) {
      throw stall.error ?? new KiloGatewayStreamStalledError('Gateway stream stalled.');
    }
    throw error;
  } finally {
    clearTimeout(stall.timer);
    clearTimeout(stall.totalTimer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
};
