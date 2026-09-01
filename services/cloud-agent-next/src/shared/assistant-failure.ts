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
  const terminalCode =
    reason === 'insufficient_credits'
      ? 'payment_required'
      : reason === 'model_unavailable'
        ? 'model_missing'
        : undefined;

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
    default:
      return undefined;
  }
}

function classifySdkStatus(source: unknown): CloudAgentAssistantFailureReason | undefined {
  if (
    typeof source !== 'object' ||
    source === null ||
    !('name' in source) ||
    source.name !== 'APIError' ||
    !('data' in source) ||
    typeof source.data !== 'object' ||
    source.data === null ||
    !('statusCode' in source.data)
  ) {
    return undefined;
  }
  const status = source.data.statusCode;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    return undefined;
  }
  if (status === 402) return 'insufficient_credits';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'provider_authentication';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'provider_unavailable';
  if (status >= 400) return 'invalid_request';
  return undefined;
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
  if (
    /\b(rate limit|rate_limit|usage[_ -]?limit[_ -]?exceeded|too many requests|429)\b/.test(message)
  ) {
    return 'rate_limited';
  }
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
