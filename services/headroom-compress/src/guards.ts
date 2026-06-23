import type { HeadroomRuntimeConfig } from './config';

export type CompressRequestBody = {
  messages: unknown[];
  model: string;
  token_budget?: number;
  config?: {
    compress_user_messages?: boolean;
    target_ratio?: number;
    protect_recent?: number;
    protect_analysis_context?: boolean;
  };
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }

  toBody(): { error: { type: string; message: string } } {
    return { error: { type: this.code, message: this.message } };
  }
}

export async function readJsonBodyWithLimit(
  request: Request,
  maxBytes: number
): Promise<{ json: unknown; byteLength: number }> {
  const contentEncoding = request.headers.get('content-encoding');
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    throw new HttpError(
      415,
      'unsupported_content_encoding',
      'Compressed request bodies are not accepted.'
    );
  }

  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number.parseInt(contentLength, 10);
    if (!Number.isInteger(declaredLength) || declaredLength < 0) {
      throw new HttpError(
        400,
        'invalid_content_length',
        'Content-Length must be a non-negative integer.'
      );
    }
    if (declaredLength > maxBytes) {
      throw new HttpError(413, 'payload_too_large', 'Request body exceeds configured byte limit.');
    }
  }

  const body = request.body;
  if (!body) {
    throw new HttpError(400, 'invalid_request', 'Request body is required.');
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (result.done) break;
    const value = result.value;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new HttpError(413, 'payload_too_large', 'Request body exceeds configured byte limit.');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(bytes);
  try {
    return { json: JSON.parse(text), byteLength: total };
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

export function validateCompressRequest(
  value: unknown,
  runtimeConfig: HeadroomRuntimeConfig
): CompressRequestBody {
  if (!isRecord(value)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
  }

  const allowedTopLevelKeys = new Set(['messages', 'model', 'token_budget', 'config']);
  for (const key of Object.keys(value)) {
    if (!allowedTopLevelKeys.has(key)) {
      throw new HttpError(400, 'invalid_request', `Unsupported field: ${key}.`);
    }
  }

  if (typeof value.model !== 'string' || value.model.trim() === '') {
    throw new HttpError(400, 'invalid_model', 'model must be a non-empty string.');
  }
  const model = value.model.trim();
  if (!runtimeConfig.modelAllowlist.has(model)) {
    throw new HttpError(400, 'model_not_allowed', 'model is not enabled for Headroom compression.');
  }

  if (!Array.isArray(value.messages)) {
    throw new HttpError(400, 'invalid_messages', 'messages must be an array.');
  }
  if (value.messages.length > runtimeConfig.maxMessages) {
    throw new HttpError(
      400,
      'too_many_messages',
      'messages exceeds configured message count limit.'
    );
  }
  for (const message of value.messages) {
    validateMessage(message);
  }

  const contentChars = countMessageContentChars(value.messages);
  if (contentChars > runtimeConfig.maxContentChars) {
    throw new HttpError(
      413,
      'payload_too_large',
      'message content exceeds configured character limit.'
    );
  }

  const contextLimit = runtimeConfig.modelLimits.contextLimits[model];
  if (!Number.isInteger(contextLimit)) {
    throw new HttpError(400, 'model_not_configured', 'model has no configured context limit.');
  }

  const body: CompressRequestBody = { messages: value.messages, model };
  const tokenBudget = value.token_budget;
  if (tokenBudget !== undefined) {
    if (typeof tokenBudget !== 'number' || !Number.isInteger(tokenBudget) || tokenBudget <= 0) {
      throw new HttpError(400, 'invalid_token_budget', 'token_budget must be a positive integer.');
    }
    if (tokenBudget > runtimeConfig.maxTokenBudget || tokenBudget > contextLimit) {
      throw new HttpError(400, 'token_budget_too_large', 'token_budget exceeds configured limit.');
    }
    body.token_budget = tokenBudget;
  }

  if (value.config !== undefined) {
    body.config = validateCompressConfig(value.config);
  }

  return body;
}

function validateMessage(value: unknown): void {
  if (!isRecord(value)) {
    throw new HttpError(400, 'invalid_messages', 'each message must be an object.');
  }
  if (typeof value.role !== 'string' || value.role.trim() === '') {
    throw new HttpError(400, 'invalid_messages', 'each message must include a string role.');
  }
  if (!('content' in value)) {
    throw new HttpError(400, 'invalid_messages', 'each message must include content.');
  }
}

function validateCompressConfig(value: unknown): CompressRequestBody['config'] {
  if (!isRecord(value)) {
    throw new HttpError(400, 'invalid_config', 'config must be an object.');
  }

  const allowedConfigKeys = new Set([
    'compress_user_messages',
    'target_ratio',
    'protect_recent',
    'protect_analysis_context',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedConfigKeys.has(key)) {
      throw new HttpError(400, 'invalid_config', `Unsupported config field: ${key}.`);
    }
  }

  const config: CompressRequestBody['config'] = {};
  if (value.compress_user_messages !== undefined) {
    if (typeof value.compress_user_messages !== 'boolean') {
      throw new HttpError(
        400,
        'invalid_config',
        'config.compress_user_messages must be a boolean.'
      );
    }
    config.compress_user_messages = value.compress_user_messages;
  }
  if (value.target_ratio !== undefined) {
    if (
      typeof value.target_ratio !== 'number' ||
      value.target_ratio <= 0 ||
      value.target_ratio > 1
    ) {
      throw new HttpError(
        400,
        'invalid_config',
        'config.target_ratio must be greater than 0 and at most 1.'
      );
    }
    config.target_ratio = value.target_ratio;
  }
  const protectRecent = value.protect_recent;
  if (protectRecent !== undefined) {
    if (
      typeof protectRecent !== 'number' ||
      !Number.isInteger(protectRecent) ||
      protectRecent < 0 ||
      protectRecent > 100
    ) {
      throw new HttpError(
        400,
        'invalid_config',
        'config.protect_recent must be an integer from 0 to 100.'
      );
    }
    config.protect_recent = protectRecent;
  }
  if (value.protect_analysis_context !== undefined) {
    if (typeof value.protect_analysis_context !== 'boolean') {
      throw new HttpError(
        400,
        'invalid_config',
        'config.protect_analysis_context must be a boolean.'
      );
    }
    config.protect_analysis_context = value.protect_analysis_context;
  }

  return config;
}

function countMessageContentChars(messages: unknown[]): number {
  let total = 0;
  for (const message of messages) {
    if (isRecord(message)) {
      total += countChars(message.content, 0);
    }
  }
  return total;
}

function countChars(value: unknown, depth: number): number {
  if (depth > 8) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return 0;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) {
      total += countChars(item, depth + 1);
    }
    return total;
  }
  if (isRecord(value)) {
    let total = 0;
    for (const item of Object.values(value)) {
      total += countChars(item, depth + 1);
    }
    return total;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
