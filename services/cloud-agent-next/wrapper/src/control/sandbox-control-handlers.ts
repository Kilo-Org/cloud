import {
  SESSION_OPERATIONS,
  sessionAttachPayloadSchema,
  sessionDetachPayloadSchema,
  sessionPermissionResolvePayloadSchema,
  sessionPromptPayloadSchema,
  sessionQuestionResolvePayloadSchema,
  sessionTerminalClosePayloadSchema,
  sessionTerminalCloseResultSchema,
  sessionTerminalConnectPayloadSchema,
  sessionTerminalConnectResultSchema,
  sessionTerminalCreatePayloadSchema,
  sessionTerminalCreateResultSchema,
  sessionTerminalResizePayloadSchema,
  sessionTerminalResizeResultSchema,
  type SandboxHeartbeatPayload,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import { isKiloServerUnreachableError, type WrapperKiloClient } from '../kilo-api.js';
import { applySessionAttach, type AttachPreparingEmitter } from './apply-attach';
import { ControlTerminalRuntimeError, type ControlTerminalRuntime } from './terminal-runtime.js';

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
  terminalRuntime?: ControlTerminalRuntime;
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
    deps.terminalRuntime?.shutdown();
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
      return handleAttach(session, payload, deps);
    case 'session.detach':
      return handleDetach(session, payload, deps);
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
    case 'session.terminal.create':
      return handleTerminalOperation(
        session,
        payload,
        deps.terminalRuntime,
        sessionTerminalCreatePayloadSchema,
        sessionTerminalCreateResultSchema,
        (runtime, identity, parsed) => runtime.create(identity, parsed)
      );
    case 'session.terminal.resize':
      return handleTerminalOperation(
        session,
        payload,
        deps.terminalRuntime,
        sessionTerminalResizePayloadSchema,
        sessionTerminalResizeResultSchema,
        (runtime, identity, parsed) => runtime.resize(identity, parsed)
      );
    case 'session.terminal.close':
      return handleTerminalOperation(
        session,
        payload,
        deps.terminalRuntime,
        sessionTerminalClosePayloadSchema,
        sessionTerminalCloseResultSchema,
        (runtime, identity, parsed) => runtime.close(identity, parsed)
      );
    case 'session.terminal.connect':
      return handleTerminalOperation(
        session,
        payload,
        deps.terminalRuntime,
        sessionTerminalConnectPayloadSchema,
        sessionTerminalConnectResultSchema,
        (runtime, identity, parsed) => runtime.connect(identity, parsed)
      );
    default:
      return fail('unknown_operation', 'Unknown operation', false);
  }
}

function missingKilo(): ControlHandlerResult {
  return fail('not_ready', 'Kilo is not ready', true);
}

function terminalFailure(error: unknown): ControlHandlerResult {
  if (error instanceof ControlTerminalRuntimeError) {
    return fail(error.code, error.message, error.retryable);
  }
  return fail('not_ready', 'Terminal request failed', isKiloServerUnreachableError(error));
}

async function handleAttach(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  const parsed = sessionAttachPayloadSchema.safeParse(payload ?? {});
  if (!parsed.success) return fail('protocol_error', 'Invalid payload', false);

  if (
    parsed.data.env &&
    CONTROL_RUNTIME_RESERVED_ENV_VARS.some(name =>
      Object.prototype.hasOwnProperty.call(parsed.data.env, name)
    )
  ) {
    return fail('protocol_error', 'Reserved control runtime environment variable', false);
  }

  const result = await applySessionAttach(session, parsed.data, {
    kiloClient: deps.kiloClient,
    ...(deps.emitPreparing ? { emitPreparing: deps.emitPreparing } : {}),
  });
  if (
    result.ok &&
    deps.terminalRuntime &&
    (parsed.data.directory ?? session.directory) === session.directory &&
    (parsed.data.snapshotIdentity ?? session.kiloSessionId) === session.kiloSessionId
  ) {
    try {
      deps.terminalRuntime.rememberAttachedSession(session);
    } catch (error) {
      return terminalFailure(error);
    }
  }
  return result;
}

async function handleDetach(
  session: SessionRequestIdentity,
  payload: unknown,
  deps: HandlerDeps
): Promise<ControlHandlerResult> {
  if (!sessionDetachPayloadSchema.safeParse(payload).success) {
    return fail('protocol_error', 'Invalid payload', false);
  }
  try {
    await deps.terminalRuntime?.detachSession(session);
    return ok({ detached: true });
  } catch (error) {
    return terminalFailure(error);
  }
}

type RuntimeSchema<Value> = {
  safeParse(value: unknown): { success: true; data: Value } | { success: false };
};

async function handleTerminalOperation<Payload, Result>(
  session: SessionRequestIdentity,
  payload: unknown,
  runtime: ControlTerminalRuntime | undefined,
  payloadSchema: RuntimeSchema<Payload>,
  resultSchema: RuntimeSchema<Result>,
  invoke: (
    terminalRuntime: ControlTerminalRuntime,
    identity: SessionRequestIdentity,
    parsed: Payload
  ) => Promise<Result>
): Promise<ControlHandlerResult> {
  const parsedPayload = payloadSchema.safeParse(payload);
  if (!parsedPayload.success) return fail('protocol_error', 'Invalid payload', false);
  if (!runtime) return fail('not_ready', 'Terminal is not available', false);

  try {
    const result = resultSchema.safeParse(await invoke(runtime, session, parsedPayload.data));
    if (!result.success) return fail('protocol_error', 'Invalid terminal result', false);
    return ok(result.data);
  } catch (error) {
    return terminalFailure(error);
  }
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
      if (agent.model === undefined) return fail('protocol_error', 'Invalid payload', false);
      await kiloClient.sendPromptAsync({
        sessionId: session.kiloSessionId,
        messageId,
        prompt: turn.prompt,
        ...(turn.parts ? { parts: turn.parts } : {}),
        agent: agent.mode,
        model: { providerID: 'kilo', modelID: agent.model },
        ...(agent.variant ? { variant: agent.variant } : {}),
      });
    } else {
      await kiloClient.sendCommand({
        sessionId: session.kiloSessionId,
        command: turn.command,
        args: turn.arguments,
        messageId,
        agent: agent.mode,
        ...(agent.model !== undefined
          ? { model: { providerID: 'kilo', modelID: agent.model } }
          : {}),
        ...(agent.variant ? { variant: agent.variant } : {}),
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
