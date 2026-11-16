import { z } from 'zod';
import { classifyAssistantFailure } from '../../../src/shared/assistant-failure.js';

export const nativeErrorSchema = z.object({
  type: z.string(),
  message: z.string(),
  status: z.number().int().optional(),
  name: z.string().optional(),
});

// Kilo v2-104: Kilo-Org/kilocode@1649d3bf, packages/core/src/session/{to-session-error,runner/{llm,step}}.ts.
const NATIVE_ERROR_NAMES = new Map([
  ['provider.auth', 'ProviderAuthError'],
  ['provider.content-filter', 'ContentFilterError'],
  ['provider.invalid-output', 'AI_InvalidResponseDataError'],
  ['tool.result-missing', 'AI_InvalidResponseDataError'],
  ['output-limit', 'MessageOutputLengthError'],
]);

const NATIVE_ERROR_STATUSES = new Map([
  ['provider.rate-limit', 429],
  ['provider.free-limit', 429],
  ['provider.budget-limit', 429],
  ['provider.model-budget-limit', 429],
  ['provider.go-limit', 429],
  ['provider.chatgpt-limit', 429],
  ['provider.quota', 402],
  ['provider.internal', 500],
  ['provider.transport', 503],
  ['provider.unknown', 503],
  ['provider.timeout', 408],
  ['provider.invalid-request', 400],
  ['provider.unsupported-operation', 400],
]);

export function nativeTurnError(error: z.infer<typeof nativeErrorSchema>) {
  const status = error.status ?? NATIVE_ERROR_STATUSES.get(error.type);
  const name =
    status === undefined
      ? (NATIVE_ERROR_NAMES.get(error.type) ?? error.name ?? 'UnknownError')
      : 'APIError';
  const data = status === undefined ? {} : { statusCode: status };
  // Generic request rejections omit the native context-overflow classification.
  const structured = classifyAssistantFailure({
    name,
    data: {
      ...data,
      ...(error.type === 'provider.invalid-request' &&
      (error.status === undefined || error.status === 400 || error.status === 413)
        ? { message: error.message }
        : {}),
    },
  });
  const message = classifyAssistantFailure(error.message);
  // V1 lets specific message text override structured errors. Canonicalize only
  // the v2 adapter's stronger signal, keeping BYOK ownership and honest fallback.
  return {
    name,
    data: {
      ...data,
      message:
        structured.reason === 'unknown'
          ? error.message
          : `${message.providerOwnership === 'byok' ? '[BYOK] ' : ''}${structured.safeMessage}`,
    },
  };
}
