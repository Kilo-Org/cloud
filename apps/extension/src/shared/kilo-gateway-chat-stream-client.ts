/* eslint-disable max-lines */
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
  readonly thinkingEffort?: string | undefined;
  readonly token: string;
  readonly tools: KiloGatewayToolDefinition[];
}

interface StreamingToolCallBuffer {
  arguments: string;
  id: string | undefined;
  name: KiloGatewayToolName | undefined;
}

interface StreamingAccumulator {
  content: string;
  isDone: boolean;
  pendingText: string;
  reasoning: string;
  reasoningDetailsByIndex: Map<number, Record<string, unknown>>;
  toolCallsByIndex: Map<number, StreamingToolCallBuffer>;
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
const gatewayToolNameSchema = z.enum([
  'eval',
  'find_in_page',
  'get_element_details',
  'get_page_snapshot',
  'get_viewport_screenshot',
]);
const streamingToolCallDeltaSchema = z.object({
  function: z
    .object({
      arguments: z.string().optional(),
      name: gatewayToolNameSchema.optional(),
    })
    .optional(),
  id: z.string().optional(),
  index: z.number(),
});
const streamDataSchema = z.object({
  choices: z.array(
    z.object({
      delta: z.object({
        content: z.string().nullable().optional(),
        reasoning: z.string().nullable().optional(),
        reasoning_details: z.array(z.unknown()).nullable().optional(),
        tool_calls: z.array(z.unknown()).optional(),
      }),
    })
  ),
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
const isGatewayToolName = (value: unknown): value is KiloGatewayToolName =>
  gatewayToolNameSchema.safeParse(value).success;
const parseToolCallBuffer = (value: StreamingToolCallBuffer): KiloGatewayToolCallRequest => {
  if (value.name === undefined) {
    throw new TypeError('Gateway stream tool call did not include a supported tool name.');
  }

  const parsedArguments = (() => {
    try {
      return parseJson(value.arguments);
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
    name: value.name,
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
    if (isGatewayToolName(functionValue.name)) {
      next.name = functionValue.name;
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

  const choice = parsed.data.choices.at(0);

  if (choice === undefined) {
    return;
  }

  const { delta } = choice;
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
const toCompletion = (accumulator: StreamingAccumulator): KiloGatewayChatCompletion => {
  const reasoningDetails = [...accumulator.reasoningDetailsByIndex.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, block]) => block);

  return {
    ...(accumulator.content === '' ? {} : { content: accumulator.content }),
    ...(accumulator.reasoning === '' ? {} : { reasoning: accumulator.reasoning }),
    ...(reasoningDetails.length === 0 ? {} : { reasoningDetails }),
    toolCalls: [...accumulator.toolCallsByIndex.values()].map(toolCall =>
      parseToolCallBuffer(toolCall)
    ),
  };
};

export const parseKiloGatewayChatCompletionStream = (
  text: string,
  onContentDelta: (delta: string) => void,
  onReasoningDelta: (delta: string) => void = () => {}
): KiloGatewayChatCompletion => {
  const accumulator: StreamingAccumulator = {
    content: '',
    isDone: false,
    pendingText: '',
    reasoning: '',
    reasoningDetailsByIndex: new Map(),
    toolCallsByIndex: new Map(),
  };
  const handlers = { onContentDelta, onReasoningDelta };

  for (const data of parseServerSentEvents(text)) {
    applyStreamingData(accumulator, data, handlers);

    if (accumulator.isDone) {
      break;
    }
  }

  return toCompletion(accumulator);
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
  onContentDelta: (delta: string) => void,
  onReasoningDelta: (delta: string) => void
): Promise<KiloGatewayChatCompletion> => {
  const accumulator: StreamingAccumulator = {
    content: '',
    isDone: false,
    pendingText: '',
    reasoning: '',
    reasoningDetailsByIndex: new Map(),
    toolCallsByIndex: new Map(),
  };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const handlers = { onContentDelta, onReasoningDelta };

  await consumeStreamReader({ accumulator, decoder, handlers, reader });

  for (const data of parseServerSentEvents(accumulator.pendingText)) {
    applyStreamingData(accumulator, data, handlers);
  }

  return toCompletion(accumulator);
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
  thinkingEffort,
  token,
  tools,
}: FetchKiloGatewayChatCompletionStreamOptions): Promise<KiloGatewayChatCompletion> => {
  const reasoningRequest = toReasoningRequest(thinkingEffort);
  const requestBody = {
    messages,
    model,
    stream: true,
    temperature: 0,
    tool_choice: tools.length === 0 ? 'none' : 'auto',
    tools,
  };
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}/api/gateway/v1/chat/completions`, {
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
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch gateway chat completion stream: ${response.status}`);
  }
  if (response.body === null) {
    throw new Error('Gateway chat completion stream did not include a body.');
  }
  return consumeKiloGatewayChatCompletionStream(response.body, onContentDelta, onReasoningDelta);
};
