import { NextResponse } from 'next/server';
import type { EnkryptGuardrailDirection } from '@kilocode/db/schema-types';
import type {
  EnkryptGuardrailVerdict,
  EnkryptUnavailableReason,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';

const UNAVAILABLE_MESSAGES: Record<
  EnkryptGuardrailDirection,
  Record<EnkryptUnavailableReason, string>
> = {
  input: {
    transient:
      "Your organization's Enkrypt AI guardrail could not check this request, so it was not sent. Please retry.",
    timeout:
      "Your organization's Enkrypt AI guardrail did not finish checking this request in time, so it was not sent. Longer conversations take longer to check: compact or prune earlier conversation history, or start a new session, then retry.",
    failed:
      "Your organization's Enkrypt AI guardrail could not check this request, so it was not sent. Try again later.",
  },
  output: {
    transient:
      "Your organization's Enkrypt AI guardrail could not check the model's response, so it was withheld. Please retry.",
    timeout:
      "Your organization's Enkrypt AI guardrail did not finish checking the model's response in time, so it was withheld. Longer responses take longer to check: ask for a shorter response, then retry.",
    failed:
      "Your organization's Enkrypt AI guardrail could not check the model's response, so it was withheld. Try again later.",
  },
};

type GuardrailError = {
  message: string;
  openAiType: string;
  openAiCode: string;
  anthropicType: string;
  errorType: ProxyErrorType;
};

type GuardrailRejection = {
  error: GuardrailError;
  status: number;
  headers: Record<string, string>;
};

const REVERT_GUIDANCE =
  ' To change it, use Revert to here under your message (or /undo in the TUI).';

/**
 * A block is final, so clients are told not to retry, and an unavailable guardrail is retried
 * automatically only after a transient failure. A blocked request stays in the conversation, so the
 * message points at the client's revert affordance, which is how the user edits it and sends a
 * different one. A blocked response needs no such hint: its reason already says to rephrase the
 * request.
 */
function guardrailRejection(
  verdict: EnkryptGuardrailVerdict,
  guardrail: EnkryptGuardrailDirection
): GuardrailRejection | null {
  if (verdict.action === 'skip' || verdict.action === 'allow') return null;
  if (verdict.action === 'block') {
    return {
      error: {
        message: guardrail === 'input' ? `${verdict.message}${REVERT_GUIDANCE}` : verdict.message,
        openAiType: 'invalid_request_error',
        openAiCode: ProxyErrorType.guardrail_blocked,
        anthropicType: 'invalid_request_error',
        errorType: ProxyErrorType.guardrail_blocked,
      },
      status: 400,
      headers: { 'x-should-retry': 'false' },
    };
  }
  return {
    error: {
      message: UNAVAILABLE_MESSAGES[guardrail][verdict.reason],
      openAiType: 'server_error',
      openAiCode: ProxyErrorType.guardrail_unavailable,
      anthropicType: 'api_error',
      errorType: ProxyErrorType.guardrail_unavailable,
    },
    status: 503,
    headers:
      verdict.reason === 'transient' ? { 'retry-after': '1' } : { 'x-should-retry': 'false' },
  };
}

/**
 * Error bodies in each API's native shape, so the OpenAI, OpenRouter, and Anthropic SDKs used by
 * Kilo clients read `error.message` as the displayed reason.
 */
function apiErrorBody(kind: GatewayChatApiKind, error: GuardrailError) {
  if (kind === 'messages') {
    return {
      type: 'error',
      error: { type: error.anthropicType, message: error.message },
      error_type: error.errorType,
    };
  }
  return {
    error: {
      message: error.message,
      type: error.openAiType,
      code: error.openAiCode,
      param: null,
    },
    error_type: error.errorType,
  };
}

/**
 * The stream error event each API's SDKs raise as an error: an error chunk for chat completions,
 * and an `error` event for messages and responses. The responses event carries the error both at
 * the top level, as the OpenAI API sends it, and nested, as the gateway's other stream errors do.
 */
function streamErrorEvent(kind: GatewayChatApiKind, error: GuardrailError): string {
  if (kind === 'chat_completions') {
    return `data: ${JSON.stringify(apiErrorBody(kind, error))}\n\n`;
  }
  if (kind === 'messages') {
    return `event: error\ndata: ${JSON.stringify(apiErrorBody(kind, error))}\n\n`;
  }
  const event = {
    type: 'error',
    sequence_number: 0,
    code: error.openAiCode,
    message: error.message,
    param: null,
    error: { type: error.openAiType, code: error.openAiCode, message: error.message, param: null },
    error_type: error.errorType,
  };
  return `event: error\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Uses the body shape of `usageLimitExceededResponse`, which Kilo clients render as a low-credit
 * prompt, but without its advice to switch to a free model: free models are scanned too.
 */
export function enkryptOrganizationCreditsRequiredResponse(
  organizationId: string,
  balance: number
): NextResponse {
  return NextResponse.json(
    {
      error: {
        title: 'Organization Credits Required',
        message:
          'Your organization needs credits to run Enkrypt guardrails, including on free models and BYOK requests. Ask an organization owner to add credits.',
        balance,
        buyCreditsUrl: `${APP_URL}/organizations/${organizationId}`,
      },
      error_type: ProxyErrorType.usage_limit_exceeded,
    },
    { status: 402 }
  );
}

/** Maps an input guardrail verdict to the gateway's rejection, or null to send the request upstream. */
export function enkryptGuardrailRejectionResponse(
  kind: GatewayChatApiKind,
  verdict: EnkryptGuardrailVerdict
): NextResponse | null {
  const rejection = guardrailRejection(verdict, 'input');
  if (!rejection) return null;
  return NextResponse.json(apiErrorBody(kind, rejection.error), {
    status: rejection.status,
    headers: rejection.headers,
  });
}

/**
 * Maps an output guardrail verdict to the response that replaces the model's, or null to release
 * it. A streamed request has not received any headers yet, but its client expects a stream, so the
 * rejection is a well-formed stream with one error event.
 */
export function enkryptOutputGuardrailRejectionResponse(
  kind: GatewayChatApiKind,
  verdict: EnkryptGuardrailVerdict,
  stream: boolean
): NextResponse | null {
  const rejection = guardrailRejection(verdict, 'output');
  if (!rejection) return null;
  if (!stream) {
    return NextResponse.json(apiErrorBody(kind, rejection.error), {
      status: rejection.status,
      headers: rejection.headers,
    });
  }
  return new NextResponse(streamErrorEvent(kind, rejection.error), {
    status: 200,
    headers: {
      ...rejection.headers,
      'content-type': 'text/event-stream',
      'content-encoding': 'identity',
      'cache-control': 'no-cache, no-transform',
    },
  });
}
