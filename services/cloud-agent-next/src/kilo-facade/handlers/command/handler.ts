import { TRPCError } from '@trpc/server';
import { fetchOrgIdForSession, validateBalanceOnly } from '../../../balance-validation.js';
import type {
  QueueExecutionTurnCommand,
  SessionMessageAdmissionResult,
  SubmittedSessionMessageRequest,
} from '../../../execution/types.js';
import type { CloudAgentSession } from '../../../persistence/CloudAgentSession.js';
import { createMessageId } from '../../../session/message-id.js';
import { preflightAndAdmitPromptMessage } from '../../../session/queue-message.js';
import type { UserId } from '../../../types/ids.js';
import { withDORetry } from '../../../utils/do-retry.js';
import {
  buildSyntheticCommandResponse,
  parseBasicKiloCommand,
  type BasicKiloCommand,
} from '../../basic-command.js';
import type { OwnedRootHandlerContext } from '../../contracts.js';
import {
  facadeError,
  missingRootKiloSessionResponse,
  readBoundedBody,
  unsupportedSessionSelectorResponse,
  validateIdScopedSelectors,
} from '../../http-contract.js';
import { publicCloudAgentDirectory } from '../../public-sdk-projection.js';

const MAX_KILO_COMMAND_JSON_BYTES = 256 * 1024;

async function readCommandBody(request: Request): Promise<BasicKiloCommand | Response> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const bodyBytes = Number(declaredLength);
    if (
      !Number.isSafeInteger(bodyBytes) ||
      bodyBytes < 0 ||
      bodyBytes > MAX_KILO_COMMAND_JSON_BYTES
    ) {
      return facadeError(400, 'KILO_COMMAND_BODY_INVALID', 'Kilo command body is not valid');
    }
  }

  const bytes = await readBoundedBody(new Response(request.body), MAX_KILO_COMMAND_JSON_BYTES);
  if (!bytes) {
    return facadeError(400, 'KILO_COMMAND_BODY_INVALID', 'Kilo command body is not valid');
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return facadeError(400, 'KILO_COMMAND_BODY_INVALID', 'Kilo command body is not valid');
  }
  const parsed = parseBasicKiloCommand(value);
  if (!parsed.success) {
    return parsed.reason === 'parts-unsupported'
      ? facadeError(
          400,
          'KILO_COMMAND_PARTS_UNSUPPORTED',
          'File attachments are not supported for public Kilo commands'
        )
      : facadeError(400, 'KILO_COMMAND_BODY_INVALID', 'Kilo command body is not valid');
  }
  return parsed.command;
}

function commandAdmissionError(
  result: Extract<SessionMessageAdmissionResult, { success: false }>
): Response {
  switch (result.code) {
    case 'BAD_REQUEST':
      return facadeError(
        400,
        'KILO_COMMAND_ADMISSION_REJECTED',
        'Kilo command admission was rejected'
      );
    case 'NOT_FOUND':
      return missingRootKiloSessionResponse();
    case 'PENDING_QUEUE_FULL':
      return facadeError(429, 'KILO_COMMAND_QUEUE_FULL', 'Kilo command queue is full');
    case 'SANDBOX_CONNECT_FAILED':
    case 'WORKSPACE_SETUP_FAILED':
    case 'KILO_SERVER_FAILED':
    case 'WRAPPER_START_FAILED':
    case 'WRAPPER_FINALIZING':
      return facadeError(503, result.code, 'Kilo command runtime is temporarily unavailable');
    case 'INTERNAL':
      return facadeError(500, 'KILO_COMMAND_ADMISSION_FAILED', 'Kilo command admission failed');
  }
}

function commandPreflightError(error: unknown): Response {
  if (!(error instanceof TRPCError)) {
    return facadeError(500, 'KILO_COMMAND_ADMISSION_FAILED', 'Kilo command admission failed');
  }
  switch (error.code) {
    case 'BAD_REQUEST':
      return facadeError(
        400,
        'KILO_COMMAND_ADMISSION_REJECTED',
        'Kilo command model selection is not available'
      );
    case 'NOT_FOUND':
      return missingRootKiloSessionResponse();
    case 'FORBIDDEN':
      return facadeError(
        403,
        'KILO_COMMAND_ADMISSION_REJECTED',
        'Kilo command model selection is not available'
      );
    case 'SERVICE_UNAVAILABLE':
      return facadeError(
        503,
        'MODEL_VALIDATION_UNAVAILABLE',
        'Command model validation is temporarily unavailable'
      );
    default:
      return facadeError(500, 'KILO_COMMAND_ADMISSION_FAILED', 'Kilo command admission failed');
  }
}

async function validateCommandMutation(
  context: OwnedRootHandlerContext
): Promise<BasicKiloCommand | Response> {
  const command = await readCommandBody(context.request);
  if (command instanceof Response) return command;
  if (!context.authToken) {
    return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Durable command admission is unavailable');
  }
  if (context.request.headers.get('x-skip-balance-check') !== null) {
    return facadeError(
      400,
      'KILO_BALANCE_BYPASS_UNSUPPORTED',
      'Balance bypass is not supported for public Kilo command mutations'
    );
  }

  const balance = context.deps?.validateCommandBalance
    ? await context.deps.validateCommandBalance({
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
  return command;
}

async function admitCommand(
  context: OwnedRootHandlerContext,
  parsed: BasicKiloCommand
): Promise<SessionMessageAdmissionResult | Response> {
  const command = {
    turn: {
      type: 'command',
      id: parsed.messageId,
      command: parsed.command,
      arguments: parsed.arguments,
      snapshotInitialization: parsed.snapshotInitialization,
    },
    ...(parsed.agent ? { agent: parsed.agent } : {}),
  } satisfies QueueExecutionTurnCommand;
  const request: SubmittedSessionMessageRequest = { userId: context.userId as UserId, ...command };
  const injectedAdmission = context.deps?.admitCommand;
  const admit = injectedAdmission
    ? () =>
        injectedAdmission({
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
      'kilo.session.command',
      admit
    );
  } catch (error) {
    return commandPreflightError(error);
  }
}

export async function handleCommand(context: OwnedRootHandlerContext): Promise<Response> {
  const selectorResponse = validateIdScopedSelectors(context.url, context.kiloSessionId, new Set());
  if (selectorResponse) return selectorResponse;
  if (context.url.searchParams.get('directory') === null) {
    return unsupportedSessionSelectorResponse();
  }

  const parsed = await validateCommandMutation(context);
  if (parsed instanceof Response) return parsed;
  const admission = await admitCommand(context, parsed);
  if (admission instanceof Response) return admission;
  if (!admission.success) return commandAdmissionError(admission);

  const now = Date.now();
  const generatedId = createMessageId(now);
  const assistantMessageId =
    generatedId === admission.messageId ? createMessageId(now + 1) : generatedId;
  return Response.json(
    buildSyntheticCommandResponse({
      now,
      assistantMessageId,
      admittedMessageId: admission.messageId,
      kiloSessionId: context.kiloSessionId,
      publicDirectory: publicCloudAgentDirectory(context.kiloSessionId),
      requestedAgent: parsed.agent?.mode,
      requestedModel: parsed.agent?.model,
      variant: parsed.agent?.variant,
    })
  );
}
