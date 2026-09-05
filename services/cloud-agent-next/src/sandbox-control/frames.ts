import type { z } from 'zod';
import {
  CONTROL_EVENTS,
  CONTROL_OPERATIONS,
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  controlFrameSchema,
  sandboxHeartbeatPayloadSchema,
  sandboxHelloPayloadSchema,
  sandboxReadyPayloadSchema,
  sandboxShutdownPayloadSchema,
  sandboxStatusPayloadSchema,
  sessionAbortPayloadSchema,
  sessionAttachPayloadSchema,
  sessionDetachPayloadSchema,
  sessionEventPayloadSchema,
  sessionGitSummaryPayloadSchema,
  sessionPreparingPayloadSchema,
  sessionPermissionResolvePayloadSchema,
  sessionPromptPayloadSchema,
  sessionQuestionResolvePayloadSchema,
  sessionSyncPayloadSchema,
  sessionTerminalClosePayloadSchema,
  sessionTerminalConnectPayloadSchema,
  sessionTerminalCreatePayloadSchema,
  sessionTerminalResizePayloadSchema,
  sessionOperationAuthorizationSchema,
  sessionOperationAckSchema,
  worktreeDeletePayloadSchema,
  type ControlError,
  type ControlErrorCode,
  type ControlEvent,
  type ControlFrame,
  type ControlOperation,
  type ResponseFrame,
  type SandboxHelloPayload,
  type SandboxHelloResult,
} from '../shared/sandbox-control-protocol.js';

const encoder = new TextEncoder();
const CONTROL_OPERATION_SET = new Set<string>(CONTROL_OPERATIONS);
const CONTROL_EVENT_SET = new Set<string>(CONTROL_EVENTS);

const REQUEST_PAYLOAD_SCHEMAS: Record<ControlOperation, z.ZodType> = {
  'sandbox.hello': sandboxHelloPayloadSchema,
  'sandbox.status': sandboxStatusPayloadSchema,
  'sandbox.shutdown': sandboxShutdownPayloadSchema,
  'worktree.prepareDeletion': worktreeDeletePayloadSchema,
  'worktree.delete': worktreeDeletePayloadSchema,
  'session.attach': sessionAttachPayloadSchema,
  'session.prompt': sessionPromptPayloadSchema,
  'session.permission.resolve': sessionPermissionResolvePayloadSchema,
  'session.question.resolve': sessionQuestionResolvePayloadSchema,
  'session.abort': sessionAbortPayloadSchema,
  'session.sync': sessionSyncPayloadSchema,
  'session.git.summary': sessionGitSummaryPayloadSchema,
  'session.detach': sessionDetachPayloadSchema,
  'session.terminal.create': sessionTerminalCreatePayloadSchema,
  'session.terminal.resize': sessionTerminalResizePayloadSchema,
  'session.terminal.close': sessionTerminalClosePayloadSchema,
  'session.terminal.connect': sessionTerminalConnectPayloadSchema,
  'session.operation.get': sessionOperationAuthorizationSchema,
  'session.operation.ack': sessionOperationAckSchema,
};

const EVENT_PAYLOAD_SCHEMAS: Record<ControlEvent, z.ZodType> = {
  'sandbox.ready': sandboxReadyPayloadSchema,
  'sandbox.heartbeat': sandboxHeartbeatPayloadSchema,
  'session.event': sessionEventPayloadSchema,
  'session.preparing': sessionPreparingPayloadSchema,
};

export type FrameParseFailure = {
  code: ControlErrorCode;
  message: string;
};

export type FrameParseResult =
  | { ok: true; frame: ControlFrame; bytes: number }
  | { ok: false; error: FrameParseFailure };

export function isControlOperation(value: string): value is ControlOperation {
  return CONTROL_OPERATION_SET.has(value);
}

export function isControlEvent(value: string): value is ControlEvent {
  return CONTROL_EVENT_SET.has(value);
}

export function isSessionOperation(value: string): boolean {
  return value.startsWith('session.') && CONTROL_OPERATION_SET.has(value);
}

export function parseOperationPayload(
  operation: ControlOperation,
  payload: unknown
): { ok: true; payload: unknown } | { ok: false; error: FrameParseFailure } {
  const parsed = REQUEST_PAYLOAD_SCHEMAS[operation].safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'protocol_error', message: `Invalid ${operation} payload` },
    };
  }
  return { ok: true, payload: parsed.data };
}

export function parseEventPayload(
  event: ControlEvent,
  payload: unknown
): { ok: true; payload: unknown } | { ok: false; error: FrameParseFailure } {
  const parsed = EVENT_PAYLOAD_SCHEMAS[event].safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'protocol_error', message: `Invalid ${event} payload` },
    };
  }
  return { ok: true, payload: parsed.data };
}

export function parseControlFrame(message: string | ArrayBuffer): FrameParseResult {
  if (typeof message !== 'string') {
    return {
      ok: false,
      error: { code: 'protocol_error', message: 'Binary frames are not supported' },
    };
  }

  const bytes = encoder.encode(message).byteLength;
  if (bytes > MAX_SANDBOX_CONTROL_FRAME_BYTES) {
    return {
      ok: false,
      error: { code: 'payload_too_large', message: 'Frame exceeds 1 MiB limit' },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message) as unknown;
  } catch {
    return {
      ok: false,
      error: { code: 'protocol_error', message: 'Frame is not valid JSON' },
    };
  }

  const frame = controlFrameSchema.safeParse(parsed);
  if (!frame.success) {
    return {
      ok: false,
      error: { code: 'protocol_error', message: 'Frame does not match the control envelope' },
    };
  }

  return { ok: true, frame: frame.data, bytes };
}

export function parseSandboxHelloPayload(payload: unknown): SandboxHelloPayload | null {
  const parsed = sandboxHelloPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function okResponse(requestId: string, result?: unknown): ResponseFrame {
  return result === undefined
    ? { type: 'response', requestId, ok: true }
    : { type: 'response', requestId, ok: true, result };
}

export function errorResponse(
  requestId: string,
  code: ControlErrorCode,
  message: string,
  retryable = false
): ResponseFrame {
  const error: ControlError = { code, message, retryable };
  return { type: 'response', requestId, ok: false, error };
}

export function helloResult(): SandboxHelloResult {
  return {
    protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
    handshakeComplete: true,
    capabilities: {
      kiloVersionHeartbeat: true,
      sessionOperationResults: true,
      scopedStopAbort: true,
      nativeRuntimeRetirement: true,
    },
  };
}
