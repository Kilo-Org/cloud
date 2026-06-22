import type { FetchLike } from './auth';

export interface KiloGatewayChatMessage {
  readonly content?: string | null;
  readonly role: 'assistant' | 'system' | 'tool' | 'user';
  readonly tool_call_id?: string;
  readonly tool_calls?: KiloGatewayChatToolCall[];
}

export interface KiloGatewayChatToolCall {
  readonly function: {
    readonly arguments: string;
    readonly name: 'eval';
  };
  readonly id: string;
  readonly type: 'function';
}

export interface KiloGatewayToolDefinition {
  readonly function: {
    readonly description: string;
    readonly name: 'eval';
    readonly parameters: Record<string, unknown>;
  };
  readonly type: 'function';
}

export interface KiloGatewayEvalToolCall {
  readonly code: string;
  readonly id: string;
  readonly name: 'eval';
}

export interface KiloGatewayChatCompletion {
  readonly content?: string;
  readonly toolCalls: KiloGatewayEvalToolCall[];
}

interface FetchKiloGatewayChatCompletionOptions {
  readonly apiBaseUrl: string;
  readonly fetch: FetchLike;
  readonly messages: KiloGatewayChatMessage[];
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly token: string;
  readonly tools: KiloGatewayToolDefinition[];
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getString = (value: unknown, message: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(message);
  }

  return value;
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError('Gateway eval tool call arguments were not valid JSON.');
  }
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

const parseEvalToolCall = (value: unknown): KiloGatewayEvalToolCall | undefined => {
  if (!isRecord(value)) {
    throw new TypeError('Gateway tool call was not an object.');
  }

  const { function: functionValue } = value;

  if (!isRecord(functionValue)) {
    throw new TypeError('Gateway tool call did not include a function.');
  }

  const { name } = functionValue;

  if (name !== 'eval') {
    return undefined;
  }

  const { code } = parseEvalToolArguments(functionValue['arguments']);

  return {
    code,
    id: getString(value['id'], 'Gateway eval tool call did not include an id.'),
    name,
  };
};

export const parseKiloGatewayChatCompletionResponse = (
  value: unknown
): KiloGatewayChatCompletion => {
  if (!isRecord(value)) {
    throw new TypeError('Gateway chat completion response did not include choices.');
  }

  const { choices } = value;

  if (!Array.isArray(choices)) {
    throw new TypeError('Gateway chat completion response did not include choices.');
  }

  const choice: unknown = choices.at(0);

  if (!isRecord(choice) || !isRecord(choice['message'])) {
    throw new TypeError('Gateway chat completion response did not include a message.');
  }

  const { message } = choice;
  const content = typeof message['content'] === 'string' ? message['content'] : undefined;
  const rawToolCalls = Array.isArray(message['tool_calls']) ? message['tool_calls'] : [];
  const toolCalls = rawToolCalls.flatMap(toolCall => {
    const parsedToolCall = parseEvalToolCall(toolCall);
    return parsedToolCall === undefined ? [] : [parsedToolCall];
  });

  return {
    ...(content === undefined || content === '' ? {} : { content }),
    toolCalls,
  };
};

export const fetchKiloGatewayChatCompletion = async ({
  apiBaseUrl,
  fetch,
  messages,
  model,
  signal,
  token,
  tools,
}: FetchKiloGatewayChatCompletionOptions): Promise<KiloGatewayChatCompletion> => {
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}/api/gateway/v1/chat/completions`, {
    body: JSON.stringify({
      messages,
      model,
      temperature: 0,
      tool_choice: tools.length === 0 ? 'none' : 'auto',
      tools,
    }),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch gateway chat completion: ${response.status}`);
  }

  const data: unknown = await response.json();
  return parseKiloGatewayChatCompletionResponse(data);
};
