/* eslint-disable max-lines */
import type {
  KiloGatewayChatCompletion,
  KiloGatewayChatMessage,
  KiloGatewayEvalToolCall,
  KiloGatewayToolDefinition,
} from './kilo-gateway-chat-client';
import type { FetchLike } from './auth';

interface FetchKiloGatewayChatCompletionStreamOptions {
  readonly apiBaseUrl: string;
  readonly fetch: FetchLike;
  readonly messages: KiloGatewayChatMessage[];
  readonly model: string;
  readonly onContentDelta: (delta: string) => void;
  readonly organizationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly thinkingEffort?: string | undefined;
  readonly token: string;
  readonly tools: KiloGatewayToolDefinition[];
}

interface StreamingToolCallBuffer {
  arguments: string;
  id: string | undefined;
  name: 'eval' | undefined;
}

interface StreamingAccumulator {
  content: string;
  isDone: boolean;
  pendingText: string;
  toolCallsByIndex: Map<number, StreamingToolCallBuffer>;
}

interface StreamReaderContext {
  readonly accumulator: StreamingAccumulator;
  readonly decoder: TextDecoder;
  readonly onContentDelta: (delta: string) => void;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');
const organizationHeaderName = 'x-kilocode-organizationid';
const validGatewayReasoningEfforts = new Set(['high', 'low', 'medium', 'minimal', 'none']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const toReasoning = (effort: string | undefined) => {
  const gatewayEffort = effort === 'instant' ? 'none' : effort;

  if (gatewayEffort === undefined || !validGatewayReasoningEfforts.has(gatewayEffort)) {
    return;
  }

  return { effort: gatewayEffort, enabled: gatewayEffort !== 'none' };
};
const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError('Gateway eval tool call arguments were not valid JSON.');
  }
};
const getString = (value: unknown, message: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(message);
  }

  return value;
};
const parseEvalToolArguments = (value: unknown): { readonly code: string } => {
  if (typeof value !== 'string') {
    throw new TypeError('Gateway eval tool call did not include arguments.');
  }

  const parsed = parseJson(value);

  if (!isRecord(parsed) || typeof parsed['code'] !== 'string' || parsed['code'].length === 0) {
    throw new TypeError('Gateway eval tool call did not include code.');
  }

  return { code: parsed['code'] };
};
const parseEvalToolCallBuffer = (value: StreamingToolCallBuffer): KiloGatewayEvalToolCall => {
  if (value.name !== 'eval') {
    throw new TypeError('Gateway stream tool call did not include eval.');
  }

  const { code } = parseEvalToolArguments(value.arguments);

  return {
    code,
    id: getString(value.id, 'Gateway eval tool call did not include an id.'),
    name: value.name,
  };
};
const parseServerSentEvents = (text: string): string[] =>
  text
    .split('\n\n')
    .flatMap(block => {
      const dataLines = block
        .split('\n')
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
  if (!isRecord(value) || typeof value['index'] !== 'number') {
    throw new TypeError('Gateway stream tool call delta did not include an index.');
  }

  const { index } = value;
  const current = toolCallsByIndex.get(index) ?? {
    arguments: '',
    id: undefined,
    name: undefined,
  };
  const functionValue = value['function'];
  const next: StreamingToolCallBuffer = {
    arguments: current.arguments,
    id: typeof value['id'] === 'string' ? value['id'] : current.id,
    name: current.name,
  };

  if (isRecord(functionValue)) {
    if (functionValue['name'] === 'eval') {
      next.name = 'eval';
    }

    if (typeof functionValue['arguments'] === 'string') {
      next.arguments += functionValue['arguments'];
    }
  }

  toolCallsByIndex.set(index, next);
};
const applyStreamingData = (
  accumulator: StreamingAccumulator,
  data: string,
  onContentDelta: (delta: string) => void
): void => {
  if (data === '[DONE]') {
    accumulator.isDone = true;
    return;
  }

  const parsed = parseJson(data);

  if (!isRecord(parsed) || !Array.isArray(parsed['choices'])) {
    return;
  }

  const choice: unknown = parsed['choices'].at(0);

  if (!isRecord(choice) || !isRecord(choice['delta'])) {
    return;
  }

  const { delta } = choice;
  const { content, tool_calls: toolCalls } = delta;
  const reasoningKeys = Object.keys(delta).filter(
    key => key.includes('reason') || key.includes('thinking')
  );

  if (content === '' || reasoningKeys.length > 0) {
    console.debug('[kilo-extension] non-visible gateway stream delta', {
      contentLength: typeof content === 'string' ? content.length : undefined,
      deltaKeys: Object.keys(delta),
      finishReason:
        typeof choice['finish_reason'] === 'string' ? choice['finish_reason'] : undefined,
      reasoningKeys,
      toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
    });
  }

  if (typeof content === 'string' && content.length > 0) {
    accumulator.content += content;
    onContentDelta(content);
  }

  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      mergeStreamingToolCall(accumulator.toolCallsByIndex, toolCall);
    }
  }
};
const toCompletion = (accumulator: StreamingAccumulator): KiloGatewayChatCompletion => ({
  ...(accumulator.content === '' ? {} : { content: accumulator.content }),
  toolCalls: [...accumulator.toolCallsByIndex.values()].map(toolCall =>
    parseEvalToolCallBuffer(toolCall)
  ),
});

export const parseKiloGatewayChatCompletionStream = (
  text: string,
  onContentDelta: (delta: string) => void
): KiloGatewayChatCompletion => {
  const accumulator: StreamingAccumulator = {
    content: '',
    isDone: false,
    pendingText: '',
    toolCallsByIndex: new Map(),
  };

  for (const data of parseServerSentEvents(text)) {
    applyStreamingData(accumulator, data, onContentDelta);

    if (accumulator.isDone) {
      break;
    }
  }

  return toCompletion(accumulator);
};
const consumeStreamReader = async ({
  accumulator,
  decoder,
  onContentDelta,
  reader,
}: StreamReaderContext): Promise<void> => {
  if (accumulator.isDone) {
    return;
  }

  const { done, value } = await reader.read();

  accumulator.pendingText += decoder.decode(value, { stream: !done });

  const blocks = accumulator.pendingText.split('\n\n');
  accumulator.pendingText = blocks.pop() ?? '';

  for (const data of parseServerSentEvents(blocks.join('\n\n'))) {
    applyStreamingData(accumulator, data, onContentDelta);

    if (accumulator.isDone) {
      return;
    }
  }

  if (done) {
    accumulator.isDone = true;
    return;
  }

  await consumeStreamReader({ accumulator, decoder, onContentDelta, reader });
};
const consumeKiloGatewayChatCompletionStream = async (
  body: ReadableStream<Uint8Array>,
  onContentDelta: (delta: string) => void
): Promise<KiloGatewayChatCompletion> => {
  const accumulator: StreamingAccumulator = {
    content: '',
    isDone: false,
    pendingText: '',
    toolCallsByIndex: new Map(),
  };
  const reader = body.getReader();
  const decoder = new TextDecoder();

  await consumeStreamReader({ accumulator, decoder, onContentDelta, reader });

  for (const data of parseServerSentEvents(accumulator.pendingText)) {
    applyStreamingData(accumulator, data, onContentDelta);
  }

  return toCompletion(accumulator);
};
export const fetchKiloGatewayChatCompletionStream = async ({
  apiBaseUrl,
  fetch,
  messages,
  model,
  onContentDelta,
  organizationId,
  signal,
  thinkingEffort,
  token,
  tools,
}: FetchKiloGatewayChatCompletionStreamOptions): Promise<KiloGatewayChatCompletion> => {
  const reasoning = toReasoning(thinkingEffort);
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}/api/gateway/v1/chat/completions`, {
    body: JSON.stringify({
      messages,
      model,
      ...(reasoning === undefined ? {} : { reasoning }),
      stream: true,
      temperature: 0,
      tool_choice: tools.length === 0 ? 'none' : 'auto',
      tools,
    }),
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
  return consumeKiloGatewayChatCompletionStream(response.body, onContentDelta);
};
