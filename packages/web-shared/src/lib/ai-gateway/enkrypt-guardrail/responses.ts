import { NextResponse } from 'next/server';
import type {
  EnkryptGuardrailVerdict,
  EnkryptUnavailableReason,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';

const UNAVAILABLE_MESSAGES: Record<EnkryptUnavailableReason, string> = {
  transient:
    "Your organization's Enkrypt AI guardrail could not check this request, so it was not sent. Please retry.",
  timeout:
    "Your organization's Enkrypt AI guardrail did not finish checking this request in time, so it was not sent. Longer conversations take longer to check: compact or prune earlier conversation history, or start a new session, then retry.",
  failed:
    "Your organization's Enkrypt AI guardrail could not check this request, so it was not sent. Try again later.",
};

/**
 * Error bodies in each API's native shape, so the OpenAI, OpenRouter, and Anthropic SDKs used by
 * Kilo clients read `error.message` as the displayed reason.
 */
function apiErrorBody(
  kind: GatewayChatApiKind,
  error: { message: string; openAiType: string; openAiCode: string; anthropicType: string },
  errorType: ProxyErrorType
) {
  if (kind === 'messages') {
    return {
      type: 'error',
      error: { type: error.anthropicType, message: error.message },
      error_type: errorType,
    };
  }
  return {
    error: {
      message: error.message,
      type: error.openAiType,
      code: error.openAiCode,
      param: null,
    },
    error_type: errorType,
  };
}

/**
 * Maps a guardrail verdict to the gateway's rejection, or null to send the request upstream. A
 * block is final, so clients are told not to retry, and an unavailable guardrail is retried
 * automatically only after a transient failure.
 */
export function enkryptGuardrailRejectionResponse(
  kind: GatewayChatApiKind,
  verdict: EnkryptGuardrailVerdict
): NextResponse | null {
  if (verdict.action === 'skip' || verdict.action === 'allow') return null;
  if (verdict.action === 'block') {
    return NextResponse.json(
      apiErrorBody(
        kind,
        {
          message: verdict.message,
          openAiType: 'invalid_request_error',
          openAiCode: ProxyErrorType.guardrail_blocked,
          anthropicType: 'invalid_request_error',
        },
        ProxyErrorType.guardrail_blocked
      ),
      { status: 400, headers: { 'x-should-retry': 'false' } }
    );
  }
  return NextResponse.json(
    apiErrorBody(
      kind,
      {
        message: UNAVAILABLE_MESSAGES[verdict.reason],
        openAiType: 'server_error',
        openAiCode: ProxyErrorType.guardrail_unavailable,
        anthropicType: 'api_error',
      },
      ProxyErrorType.guardrail_unavailable
    ),
    {
      status: 503,
      headers:
        verdict.reason === 'transient' ? { 'retry-after': '1' } : { 'x-should-retry': 'false' },
    }
  );
}
