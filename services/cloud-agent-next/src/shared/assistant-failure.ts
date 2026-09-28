import type {
  CloudAgentAssistantFailureReason,
  CloudAgentProviderOwnership,
} from '@kilocode/worker-utils/cloud-agent-failure';

const ASSISTANT_FAILURE_MESSAGES = {
  insufficient_credits: 'Assistant request failed: insufficient credits',
  rate_limited: 'Assistant request was rate limited',
  model_unavailable: 'Assistant request failed: model not found',
  provider_authentication: 'Assistant request was not authorized',
  provider_unavailable: 'Assistant service is unavailable',
  timeout: 'Assistant request timed out',
  invalid_request: 'Assistant request was invalid',
  context_limit: 'The model context limit was exceeded',
  output_limit: 'The model output limit was reached',
  content_filter: 'The model provider blocked the response under its content policy',
  structured_output: 'The model response did not match the required format',
  unknown: 'Assistant request failed',
} as const satisfies Record<CloudAgentAssistantFailureReason, string>;
const ASSISTANT_INTERRUPT_MESSAGE = 'The message was interrupted by the user';
const ASSISTANT_FAILURE_REASONS = Object.keys(
  ASSISTANT_FAILURE_MESSAGES
) as CloudAgentAssistantFailureReason[];

export function assistantFailureMessage(reason: CloudAgentAssistantFailureReason): string {
  return ASSISTANT_FAILURE_MESSAGES[reason];
}

/**
 * The single owner of the assistant-reason-to-terminal-code rule shared by the
 * safe-failure projection and the control-plane run classifier.
 */
export function assistantTerminalCode(
  reason: CloudAgentAssistantFailureReason
): 'payment_required' | 'model_missing' | undefined {
  return reason === 'insufficient_credits'
    ? 'payment_required'
    : reason === 'model_unavailable'
      ? 'model_missing'
      : undefined;
}

/**
 * Resolves assistant-failure ownership: a `[BYOK]` marker is preserved, an
 * admitted run fills `managed` from its admitted model, and otherwise the
 * supplied ownership is returned unchanged. Mirrors the legacy terminalization
 * rule exactly.
 */
export function resolveAssistantProviderOwnership(
  providerOwnership: CloudAgentProviderOwnership | undefined,
  assistantFailureReason: CloudAgentAssistantFailureReason | undefined,
  admittedModel: string | undefined
): CloudAgentProviderOwnership | undefined {
  if (providerOwnership === 'byok' || assistantFailureReason === undefined)
    return providerOwnership;
  return admittedModel === undefined ? providerOwnership : 'managed';
}

export type AssistantFailureClassification = {
  reason: CloudAgentAssistantFailureReason;
  safeMessage: string;
  providerOwnership: CloudAgentProviderOwnership;
  terminalCode?: 'payment_required' | 'model_missing';
};

export function projectSafeAssistantError(source: unknown): string | undefined {
  if (source === undefined || source === null) return undefined;
  const failure = classifyAssistantFailure(source);
  const message = isAssistantInterrupt(source) ? ASSISTANT_INTERRUPT_MESSAGE : failure.safeMessage;
  return failure.providerOwnership === 'byok' ? `[BYOK] ${message}` : message;
}

export function isAssistantInterrupt(source: unknown): boolean {
  if (typeof source === 'object' && source !== null && 'name' in source) {
    if (source.name === 'MessageAbortedError') return true;
  }
  return /messageabortederror|user[_ -]?interrupt|interrupted by the user/.test(
    extractErrorMessage(source).toLocaleLowerCase()
  );
}

export function classifyAssistantFailure(
  source: unknown,
  defaultProviderOwnership: CloudAgentProviderOwnership = 'unknown'
): AssistantFailureClassification {
  const message = extractErrorMessage(source).toLocaleLowerCase();
  const providerOwnership = /\[byok\]/i.test(message) ? 'byok' : defaultProviderOwnership;
  const messageReason = classifyAssistantFailureText(message);
  const specificMessageReason =
    messageReason !== 'unknown' &&
    messageReason !== 'invalid_request' &&
    messageReason !== 'provider_unavailable';
  const reason = specificMessageReason
    ? messageReason
    : (classifySdkErrorName(source) ??
      (messageReason !== 'unknown' ? messageReason : classifySdkStatus(source)) ??
      'unknown');
  const terminalCode = assistantTerminalCode(reason);

  return {
    reason,
    safeMessage: assistantFailureMessage(reason),
    providerOwnership,
    ...(terminalCode === undefined ? {} : { terminalCode }),
  };
}

function classifySdkErrorName(source: unknown): CloudAgentAssistantFailureReason | undefined {
  if (typeof source !== 'object' || source === null || !('name' in source)) return undefined;
  switch (source.name) {
    case 'ProviderAuthError':
      return 'provider_authentication';
    case 'ContextOverflowError':
      return 'context_limit';
    case 'MessageOutputLengthError':
      return 'output_limit';
    case 'ContentFilterError':
      return 'content_filter';
    case 'StructuredOutputError':
      return 'structured_output';
    // A malformed provider stream. The AI SDK raises it while decoding the
    // response, so the cause is the model-serving path, not the request.
    case 'AI_InvalidResponseDataError':
      return 'provider_unavailable';
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MAX_RESPONSE_BODY_LENGTH = 64 * 1024;

/**
 * The AI SDK's `APIError` often carries no `statusCode`, only the raw provider
 * `responseBody`. The gateway and upstream providers put a numeric status in
 * that body (`{"code":502,...}`) or a bounded `error_type` token, so it is
 * parsed here rather than left to collapse into the unknown bucket.
 */
function parseResponseBody(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RESPONSE_BODY_LENGTH) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function numericHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function classifyHttpStatus(status: number): CloudAgentAssistantFailureReason | undefined {
  if (status === 402) return 'insufficient_credits';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'provider_authentication';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'provider_unavailable';
  if (status >= 400) return 'invalid_request';
  return undefined;
}

/**
 * Bounded `error_type` tokens emitted by the gateway and upstream providers.
 * An unrecognized token is ignored rather than guessed. A Map (not an object)
 * because the key is caller-supplied text and an object lookup for
 * `constructor` would resolve an inherited member.
 */
const ASSISTANT_ERROR_TYPE_REASONS = new Map<string, CloudAgentAssistantFailureReason>([
  ['provider_unavailable', 'provider_unavailable'],
  ['upstream_error', 'provider_unavailable'],
  ['upstream_disconnect', 'provider_unavailable'],
  ['temporarily_unavailable', 'provider_unavailable'],
  ['rate_limit_exceeded', 'rate_limited'],
  ['insufficient_credits', 'insufficient_credits'],
  ['context_length_exceeded', 'context_limit'],
  ['model_not_found', 'model_unavailable'],
  ['unavailable_model', 'model_unavailable'],
  ['authentication_required', 'provider_authentication'],
  ['invalid_request', 'invalid_request'],
]);

function classifyErrorType(value: unknown): CloudAgentAssistantFailureReason | undefined {
  return typeof value === 'string'
    ? ASSISTANT_ERROR_TYPE_REASONS.get(value.toLocaleLowerCase())
    : undefined;
}

function classifySdkStatus(source: unknown): CloudAgentAssistantFailureReason | undefined {
  if (
    typeof source !== 'object' ||
    source === null ||
    !('name' in source) ||
    source.name !== 'APIError' ||
    !('data' in source) ||
    typeof source.data !== 'object' ||
    source.data === null
  ) {
    return undefined;
  }
  const data = source.data as Record<string, unknown>;

  const directStatus = numericHttpStatus(data.statusCode);
  if (directStatus !== undefined) {
    const reason = classifyHttpStatus(directStatus);
    if (reason !== undefined) return reason;
    // A well-formed but unmapped status (100–399) is authoritative: do not
    // fall through to a body-derived cause.
    return undefined;
  }

  const responseBody = parseResponseBody(data.responseBody);
  if (responseBody === undefined) return undefined;

  const errorType =
    classifyErrorType(responseBody.error_type) ??
    classifyErrorType(asRecord(responseBody.metadata)?.error_type);
  if (errorType !== undefined) return errorType;

  const bodyStatus =
    numericHttpStatus(responseBody.status) ??
    numericHttpStatus(responseBody.statusCode) ??
    numericHttpStatus(responseBody.code);
  if (bodyStatus !== undefined) {
    const reason = classifyHttpStatus(bodyStatus);
    if (reason !== undefined) return reason;
  }

  return classifySdkErrorName({ name: responseBody.name });
}

function classifyAssistantFailureText(message: string): CloudAgentAssistantFailureReason {
  const canonicalMessage = message.replace(/^\[byok\] /, '');
  const canonicalReason = ASSISTANT_FAILURE_REASONS.find(
    reason => ASSISTANT_FAILURE_MESSAGES[reason].toLocaleLowerCase() === canonicalMessage
  );
  if (canonicalReason !== undefined) return canonicalReason;
  if (/\b(payment required|insufficient (?:credits?|balance|funds))\b/.test(message)) {
    return 'insufficient_credits';
  }
  if (/\b(model (?:was )?not found|unknown model|invalid model)\b/.test(message)) {
    return 'model_unavailable';
  }
  if (/\btool calls (?:cutoff|cut off) by max_tokens\b/.test(message)) {
    return 'output_limit';
  }
  // A provider rejects an over-long request with a 4xx that would otherwise
  // fall through to the APIError status mapping and be reported as an invalid
  // request. Match the wording providers use (Kilo/Nex AGI "exceeds this
  // model's context length", OpenAI "maximum context length", Anthropic
  // "prompt is too long") plus the provider_code token, so the transcript
  // names the real cause instead of "Assistant request was invalid". Every
  // branch requires an over-limit qualifier: a field-name validation error like
  // "Invalid value for 'context_length'" or a payload-size 413 ("Request Entity
  // Too Large") must stay an invalid request, not claim the context window.
  if (
    /\bcontext[_ ]?(?:length|window|limit|size)[_ ]?(?:exceeds?|exceeded|overflow(?:ed)?|too (?:long|large)|max(?:imum)?)\b/.test(
      message
    ) ||
    /\b(?:exceeds?|exceeded|overflow(?:ed)?|max(?:imum)?)\b[^.]{0,40}\bcontext\b/.test(message) ||
    /\b(?:prompt|request|input|messages?)\b[^.]{0,40}\btoo long\b/.test(message)
  ) {
    return 'context_limit';
  }
  if (
    /\b(rate limit|rate_limit|usage[_ -]?limit[_ -]?exceeded|too many requests|429)\b/.test(message)
  ) {
    return 'rate_limited';
  }
  // "too many tokens" on its own is ambiguous: a provider uses it both for an
  // over-long request and for a per-minute rate limit ("Rate limit reached: too
  // many tokens per minute"). An explicit rate-limit wording is the stronger
  // signal and is checked first, so the unqualified pattern is only consulted
  // here, after it.
  if (/\btoo many tokens\b/.test(message)) return 'context_limit';
  if (/\b(timed? out|timeout|deadline exceeded)\b/.test(message)) return 'timeout';
  if (/\b(unauthorized|forbidden|authorization|authentication|401|403)\b/.test(message)) {
    return 'provider_authentication';
  }
  if (/\b(invalid request|bad request|malformed request|400)\b/.test(message)) {
    return 'invalid_request';
  }
  if (/\b(service unavailable|temporarily unavailable|overloaded|502|503|504)\b/.test(message)) {
    return 'provider_unavailable';
  }
  return 'unknown';
}

export function classifyAssistantFailureMessage(source: unknown): string {
  if (isAssistantInterrupt(source)) return ASSISTANT_INTERRUPT_MESSAGE;
  return classifyAssistantFailure(source).safeMessage;
}

function extractErrorMessage(source: unknown): string {
  if (typeof source === 'string') return source;
  if (typeof source !== 'object' || source === null) return '';
  if ('data' in source && typeof source.data === 'object' && source.data !== null) {
    if ('message' in source.data && typeof source.data.message === 'string') {
      return source.data.message;
    }
  }
  if ('message' in source && typeof source.message === 'string') return source.message;
  return '';
}
