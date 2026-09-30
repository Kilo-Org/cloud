import type { z } from 'zod';
import {
  CONTROL_EVENTS,
  CONTROL_OPERATIONS,
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  controlFrameSchema,
  sandboxHeartbeatPayloadSchema,
  sandboxEventPublicationPayloadSchema,
  sandboxEventBatchPayloadSchema,
  sandboxHelloPayloadSchema,
  sandboxReconcilePayloadSchema,
  sandboxReadyPayloadSchema,
  sandboxShutdownPayloadSchema,
  sandboxStatusPayloadSchema,
  sessionAbortPayloadSchema,
  sessionAttachPayloadSchema,
  sessionDetachPayloadSchema,
  sessionRuntimeRetirePayloadSchema,
  sessionEventPayloadSchema,
  sessionGitSummaryPayloadSchema,
  sessionGitSnapshotPayloadSchema,
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
const INVALID_SESSION_ATTACH_PAYLOAD = 'Invalid session.attach payload';
const MCP_SERVER_COUNT_MESSAGE = 'A session can have at most 20 MCP servers';
const MCP_ENTRY_COUNT_MESSAGE =
  'An MCP server can have at most 50 environment variables or headers';
const MCP_SERIALIZED_SIZE_MESSAGE = 'Serialized MCP configuration exceeds the 80 KiB limit';

const REQUEST_PAYLOAD_SCHEMAS: Record<ControlOperation, z.ZodType> = {
  'sandbox.hello': sandboxHelloPayloadSchema,
  'sandbox.status': sandboxStatusPayloadSchema,
  'sandbox.reconcile': sandboxReconcilePayloadSchema,
  'sandbox.event.publish': sandboxEventPublicationPayloadSchema,
  'sandbox.event.publishBatch': sandboxEventBatchPayloadSchema,
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
  'session.git.snapshot': sessionGitSnapshotPayloadSchema,
  'session.detach': sessionDetachPayloadSchema,
  'session.runtime.retire': sessionRuntimeRetirePayloadSchema,
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

type ValidationIssue = {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  maximum?: unknown;
  issues?: readonly { code: string; maximum?: unknown }[];
};

function issueMaximum(issue: ValidationIssue): unknown {
  if (issue.maximum !== undefined) return issue.maximum;
  return issue.issues?.[0]?.maximum;
}

function sessionAttachMcpValidationReason(
  issues: ReadonlyArray<ValidationIssue>
): string | undefined {
  for (const issue of issues) {
    const [root, _serverName, field] = issue.path;
    if (root !== 'mcp') continue;

    if (issue.path.length === 1) {
      if (
        issue.message === MCP_SERVER_COUNT_MESSAGE ||
        issue.message === MCP_SERIALIZED_SIZE_MESSAGE
      )
        return issue.message === MCP_SERVER_COUNT_MESSAGE
          ? MCP_SERVER_COUNT_MESSAGE
          : MCP_SERIALIZED_SIZE_MESSAGE;
      continue;
    }

    if (
      issue.path.length === 2 &&
      (issue.code === 'too_small' || issue.code === 'too_big' || issue.code === 'invalid_key')
    ) {
      return 'MCP server names must be between 1 and 100 characters';
    }

    if (field === 'timeout') {
      return 'MCP server timeout must be a positive integer no greater than 3600000 ms';
    }

    if (field === 'command' && (issue.code === 'too_small' || issue.code === 'too_big')) {
      return issue.path.length === 3
        ? 'MCP server commands must contain between 1 and 50 arguments'
        : 'MCP server command arguments must not exceed 8192 characters';
    }

    if (field === 'url' && issue.code === 'too_big')
      return 'MCP server URLs must not exceed 4096 characters';

    if (field !== 'headers' && field !== 'environment') continue;
    if (issue.path.length === 3 && issue.message === MCP_ENTRY_COUNT_MESSAGE)
      return MCP_ENTRY_COUNT_MESSAGE;

    const maximum = issueMaximum(issue);
    if (issue.code === 'invalid_key' || maximum === 256 || issue.code === 'too_small')
      return field === 'headers'
        ? 'MCP server header names must be between 1 and 256 characters'
        : 'MCP server environment variable names must be between 1 and 256 characters';
    if (maximum === 8192)
      return field === 'headers'
        ? 'MCP server header values must not exceed 8192 characters'
        : 'MCP server environment variable values must not exceed 8192 characters';
  }
}

function sessionAttachPayloadError(issues: ReadonlyArray<ValidationIssue>): FrameParseFailure {
  const reason = sessionAttachMcpValidationReason(issues);
  return {
    code: 'protocol_error',
    message: reason
      ? `${INVALID_SESSION_ATTACH_PAYLOAD}: ${reason}`.slice(0, 512)
      : INVALID_SESSION_ATTACH_PAYLOAD,
  };
}

export function parseOperationPayload(
  operation: ControlOperation,
  payload: unknown
): { ok: true; payload: unknown } | { ok: false; error: FrameParseFailure } {
  const parsed = REQUEST_PAYLOAD_SCHEMAS[operation].safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        operation === 'session.attach'
          ? sessionAttachPayloadError(parsed.error.issues)
          : { code: 'protocol_error', message: `Invalid ${operation} payload` },
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
      error: { code: 'payload_too_large', message: 'Frame exceeds 12 MiB limit' },
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

export function helloResult(capabilities?: {
  connectionRecovery?: boolean;
  eventReceipts?: boolean;
  eventBatches?: boolean;
  kiloLocalPhase?: boolean;
}): SandboxHelloResult {
  return {
    protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
    handshakeComplete: true,
    capabilities: {
      kiloVersionHeartbeat: true,
      sessionOperationResults: true,
      ...(capabilities?.connectionRecovery ? { connectionRecovery: true } : {}),
      ...(capabilities?.eventReceipts ? { eventReceipts: true } : {}),
      ...(capabilities?.eventBatches ? { eventBatches: true } : {}),
      ...(capabilities?.kiloLocalPhase ? { kiloLocalPhase: true } : {}),
    },
  };
}
