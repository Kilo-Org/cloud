import {
  SESSION_OPERATIONS,
  sessionPermissionResolvePayloadSchema,
  sessionPromptPayloadSchema,
  sessionQuestionResolvePayloadSchema,
  type SandboxHeartbeatPayload,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import { isKiloServerUnreachableError, type WrapperKiloClient } from '../kilo-api.js';
import { applySessionAttach, type AttachPreparingEmitter } from './apply-attach';

export type HandlerSessionSnapshot = {
  kiloSessionId: string;
  state: 'idle' | 'active' | 'finalizing';
  idleForMs: number;
  waitingOn?: 'model' | 'tool' | 'finalizing';
};

export type HandlerDeps = {
  kiloClient?: WrapperKiloClient;
  version: string;
  kiloReady: boolean;
  getStatus: () => { state: 'idle' | 'active' | 'finalizing'; pendingMessages: string[] };
  sessions: HandlerSessionSnapshot[];
  emitPreparing?: AttachPreparingEmitter;
};

export type ControlHandlerResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

const SESSION_OPERATION_SET = new Set<string>(SESSION_OPERATIONS);

function ok(result: unknown): ControlHandlerResult {
  return { ok: true, result };
}

function fail(code: string, message: string, retryable: boolean): ControlHandlerResult {
  return { ok: false, error: { code, message, retryable } };
}

function kiloFailure(error: unknown): ControlHandlerResult {
  return fail('not_ready', 'Kilo request failed', isKiloServerUnreachableError(error));
}

export function buildHeartbeatPayload(deps: HandlerDeps): SandboxHeartbeatPayload {
  const status = deps.getStatus();
  return {
    state: status.state,
    pendingMessages: status.pendingMessages.length,
    kilo: { ready: deps.kiloReady },
    sessions: deps.sessions,
  };
}

export async function handleControlRequest(
  operation: string,
  session: SessionRequestIdentity | undefined,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  if (operation === 'sandbox.status') {
    const status = deps.getStatus();
    return ok({
      healthy: true,
      state: status.state,
      version: deps.version,
      kiloReady: deps.kiloReady,
    });
  }
  if (operation === 'sandbox.shutdown') {
    return ok({ shuttingDown: true });
  }
  if (!SESSION_OPERATION_SET.has(operation)) {
    return fail('unknown_operation', 'Unknown operation', false);
  }
  if (!session) {
    return fail('protocol_error', 'session identity is required', false);
  }

  switch (operation) {
    case 'session.attach':
      return applySessionAttach(session, payload, {
        kiloClient: deps.kiloClient,
        ...(deps.emitPreparing ? { emitPreparing: deps.emitPreparing } : {}),
      });
    case 'session.detach':
      return ok({ detached: true });
    case 'session.prompt':
      return handlePrompt(session, payload, deps);
    case 'session.abort':
      return handleAbort(session, deps);
    case 'session.permission.resolve':
      return handlePermissionResolve(payload, deps);
    case 'session.question.resolve':
      return handleQuestionResolve(payload, deps);
    case 'session.sync':
      return handleSync(session, deps);
    default:
      return fail('unknown_operation', 'Unknown operation', false);
  }
}

function missingKilo(): ControlHandlerResult {
  return fail('not_ready', 'Kilo is not ready', true);
}

async function handlePrompt(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const kiloClient = deps.kiloClient;
  if (!kiloClient) return missingKilo();
  const parsed = sessionPromptPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return fail('protocol_error', 'Invalid payload', false);
  }
  try {
    const { messageId, turn, agent } = parsed.data;
    if (turn.type === 'prompt') {
      await kiloClient.sendPromptAsync({
        sessionId: session.kiloSessionId,
        messageId,
        prompt: turn.prompt,
        ...(turn.parts ? { parts: turn.parts } : {}),
        agent: agent.mode,
        model: { modelID: agent.model },
        ...(agent.variant ? { variant: agent.variant } : {}),
      });
    } else {
      await kiloClient.sendCommand({
        sessionId: session.kiloSessionId,
        command: turn.command,
        args: turn.arguments,
        messageId,
      });
    }
    return ok({ messageId, status: 'accepted' });
  } catch (error) {
    return kiloFailure(error);
  }
}

async function handleAbort(
  session: SessionRequestIdentity,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const kiloClient = deps.kiloClient;
  if (!kiloClient) return missingKilo();
  try {
    await kiloClient.abortSession({ sessionId: session.kiloSessionId });
    return ok({ status: 'aborted' });
  } catch (error) {
    return kiloFailure(error);
  }
}

async function handlePermissionResolve(
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const kiloClient = deps.kiloClient;
  if (!kiloClient) return missingKilo();
  const parsed = sessionPermissionResolvePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return fail('protocol_error', 'Invalid payload', false);
  }
  try {
    await kiloClient.answerPermission(
      parsed.data.permissionId,
      parsed.data.response,
      parsed.data.message
    );
    return ok({ success: true });
  } catch (error) {
    return kiloFailure(error);
  }
}

async function handleQuestionResolve(
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const kiloClient = deps.kiloClient;
  if (!kiloClient) return missingKilo();
  const parsed = sessionQuestionResolvePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return fail('protocol_error', 'Invalid payload', false);
  }
  try {
    if (parsed.data.action === 'answer') {
      await kiloClient.answerQuestion(parsed.data.questionId, parsed.data.answers);
    } else {
      await kiloClient.rejectQuestion(parsed.data.questionId);
    }
    return ok({ success: true });
  } catch (error) {
    return kiloFailure(error);
  }
}

async function handleSync(
  session: SessionRequestIdentity,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const kiloClient = deps.kiloClient;
  if (!kiloClient) return missingKilo();
  try {
    const [statuses, questions, permissions] = await Promise.all([
      kiloClient.getSessionStatuses(),
      kiloClient.getQuestions(),
      kiloClient.getPermissions(),
    ]);
    return ok({
      status: statuses[session.kiloSessionId] ?? { type: 'idle' },
      questions: questions.filter(question => question.sessionID === session.kiloSessionId),
      permissions: permissions.filter(permission => permission.sessionID === session.kiloSessionId),
    });
  } catch (error) {
    return kiloFailure(error);
  }
}
