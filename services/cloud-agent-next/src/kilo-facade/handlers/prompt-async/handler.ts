import { TRPCError } from '@trpc/server';
import { fetchOrgIdForSession, validateBalanceOnly } from '../../../balance-validation.js';
import type {
  QueueExecutionTurnCommand,
  SessionMessageAdmissionResult,
  SubmittedSessionMessageRequest,
} from '../../../execution/types.js';
import type { CloudAgentSession } from '../../../persistence/CloudAgentSession.js';
import { preflightAndAdmitPromptMessage } from '../../../session/queue-message.js';
import type { UserId } from '../../../types/ids.js';
import { withDORetry } from '../../../utils/do-retry.js';
import { parseBasicKiloPrompt } from '../../basic-prompt.js';
import type { OwnedRootHandlerContext } from '../../contracts.js';
import {
  facadeError,
  missingRootKiloSessionResponse,
  readBoundedBody,
  validateIdScopedSelectors,
} from '../../http-contract.js';

const MAX_KILO_PROMPT_JSON_BYTES = 256 * 1024;

type ReadRequestJsonResult =
  | { success: true; value: unknown }
  | { success: false; response: Response };

async function readRequestJson(request: Request): Promise<ReadRequestJsonResult> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const bodyBytes = Number(declaredLength);
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes > MAX_KILO_PROMPT_JSON_BYTES) {
      return {
        success: false,
        response: facadeError(
          400,
          'KILO_BASIC_PROMPT_UNSUPPORTED',
          'Basic Kilo prompt body is not supported'
        ),
      };
    }
  }
  const bytes = await readBoundedBody(new Response(request.body), MAX_KILO_PROMPT_JSON_BYTES);
  if (!bytes) {
    return {
      success: false,
      response: facadeError(
        400,
        'KILO_BASIC_PROMPT_UNSUPPORTED',
        'Basic Kilo prompt body is not supported'
      ),
    };
  }
  try {
    return { success: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {
      success: false,
      response: facadeError(
        400,
        'KILO_BASIC_PROMPT_UNSUPPORTED',
        'Basic Kilo prompt body is not supported'
      ),
    };
  }
}

function promptAdmissionError(
  result: Extract<SessionMessageAdmissionResult, { success: false }>
): Response {
  switch (result.code) {
    case 'BAD_REQUEST':
      return facadeError(400, 'KILO_PROMPT_ADMISSION_REJECTED', result.error);
    case 'NOT_FOUND':
      return missingRootKiloSessionResponse();
    case 'PENDING_QUEUE_FULL':
      return facadeError(429, 'KILO_PROMPT_QUEUE_FULL', result.error);
    case 'SANDBOX_CONNECT_FAILED':
    case 'WORKSPACE_SETUP_FAILED':
    case 'KILO_SERVER_FAILED':
    case 'WRAPPER_START_FAILED':
    case 'WRAPPER_FINALIZING':
      return facadeError(503, result.code, result.error);
    case 'INTERNAL':
      return facadeError(500, 'KILO_PROMPT_ADMISSION_FAILED', result.error);
  }
}

function promptPreflightError(error: unknown): Response {
  if (!(error instanceof TRPCError)) throw error;
  switch (error.code) {
    case 'BAD_REQUEST':
      return facadeError(400, 'KILO_PROMPT_ADMISSION_REJECTED', error.message);
    case 'NOT_FOUND':
      return missingRootKiloSessionResponse();
    case 'FORBIDDEN':
      return facadeError(403, 'KILO_PROMPT_ADMISSION_REJECTED', error.message);
    case 'SERVICE_UNAVAILABLE':
      return facadeError(503, 'MODEL_VALIDATION_UNAVAILABLE', error.message);
    default:
      throw error;
  }
}

async function admitBasicPrompt(
  context: OwnedRootHandlerContext
): Promise<SessionMessageAdmissionResult | Response> {
  const body = await readRequestJson(context.request);
  if (!body.success) return body.response;
  const parsed = parseBasicKiloPrompt(body.value);
  if (!parsed.success) {
    return facadeError(
      400,
      'KILO_BASIC_PROMPT_UNSUPPORTED',
      'Basic Kilo prompt body is not supported'
    );
  }
  if (!context.authToken) {
    return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Durable prompt admission is unavailable');
  }
  if (context.request.headers.get('x-skip-balance-check') !== null) {
    return facadeError(
      400,
      'KILO_BALANCE_BYPASS_UNSUPPORTED',
      'Balance bypass is not supported for public Kilo prompt mutations'
    );
  }
  const balance = context.deps?.validatePromptBalance
    ? await context.deps.validatePromptBalance({
        env: context.env,
        authToken: context.authToken,
        userId: context.userId,
        cloudAgentSessionId: context.cloudAgentSessionId,
      })
    : await validateBalanceOnly(
        context.authToken,
        await fetchOrgIdForSession(context.env, context.userId, context.cloudAgentSessionId),
        context.env
      );
  if (!balance.success) {
    return facadeError(balance.status, 'KILO_BALANCE_VALIDATION_FAILED', balance.message);
  }

  const command = {
    turn: { type: 'prompt', id: parsed.prompt.messageId, prompt: parsed.prompt.prompt },
    ...(parsed.prompt.agent ? { agent: parsed.prompt.agent } : {}),
  } satisfies QueueExecutionTurnCommand;
  const request: SubmittedSessionMessageRequest = { userId: context.userId as UserId, ...command };
  const injectedAdmitPrompt = context.deps?.admitPrompt;
  const admitPrompt = injectedAdmitPrompt
    ? () =>
        injectedAdmitPrompt({
          env: context.env,
          userId: context.userId,
          cloudAgentSessionId: context.cloudAgentSessionId,
          request,
        })
    : () => {
        const id = context.env.CLOUD_AGENT_SESSION.idFromName(
          `${context.userId}:${context.cloudAgentSessionId}`
        );
        return withDORetry<DurableObjectStub<CloudAgentSession>, SessionMessageAdmissionResult>(
          () => context.env.CLOUD_AGENT_SESSION.get(id),
          stub => stub.admitSubmittedMessage(request),
          'admitSubmittedMessage'
        );
      };
  try {
    return await preflightAndAdmitPromptMessage(
      { cloudAgentSessionId: context.cloudAgentSessionId, ...command },
      { env: context.env, userId: context.userId },
      'kilo.prompt_async',
      admitPrompt
    );
  } catch (error) {
    return promptPreflightError(error);
  }
}

export async function handlePromptAsync(context: OwnedRootHandlerContext): Promise<Response> {
  const selectorResponse = validateIdScopedSelectors(context.url, context.kiloSessionId, new Set());
  if (selectorResponse) return selectorResponse;
  const admission = await admitBasicPrompt(context);
  if (admission instanceof Response) return admission;
  if (!admission.success) return promptAdmissionError(admission);
  return new Response(null, { status: 204 });
}
