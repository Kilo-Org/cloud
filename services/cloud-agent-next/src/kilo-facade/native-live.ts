import { z } from 'zod';
import type {
  ControlPlaneControlResult,
  ControlPlaneNativeOperation,
} from '../shared/control-plane-protocol.js';
import type { SandboxSessionV2 } from '../control-plane/session/session-do.js';
import type { Env } from '../types.js';
import type { SessionId } from '../types/ids.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import { withDORetry } from '../utils/do-retry.js';
import {
  projectPublicStructuredPaths,
  publicCloudAgentDirectory,
} from './public-sdk-projection.js';

/**
 * The native read subset the VS Code and JetBrains clients exercise on a live
 * hosted session. Every operation is an allowlisted name; Cloud resolves the
 * route identity itself, so the facade never forwards a caller-supplied path,
 * URL, or session selector to the sandbox.
 */

const MAX_PUBLIC_NATIVE_JSON_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_MESSAGE_WINDOW = 100;
const MAX_NATIVE_STATUSES = 1_000;
/**
 * Keys that name a private workspace location. They are dropped rather than
 * rewritten: no public response should point at a sandbox path it cannot use.
 */
const PRIVATE_PATH_KEYS = new Set(['path', 'cwd', 'root', 'directory', 'worktree']);

const todoSchema = z
  .object({
    content: z.string().max(4096),
    status: z.string().max(64),
    priority: z.string().max(64),
  })
  .strict();

const diffFileSchema = z
  .object({
    file: z.string().max(4096).optional(),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    status: z.string().max(64).optional(),
    patch: z.string().optional(),
    before: z.string().optional(),
    after: z.string().optional(),
  })
  .strip();

const nativeQuestionSchema = z.object({ id: z.string().min(1) }).passthrough();
const nativePermissionSchema = z.object({ id: z.string().min(1) }).passthrough();

/** Native session detail; only the identity is required for the public shape. */
const nativeSessionSchema = z
  .object({ id: z.string().min(1), directory: z.string().optional() })
  .passthrough();

const nativeMessageSchema = z.object({ info: z.object({ id: z.string().min(1) }) }).passthrough();

export type NativeReadOutcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'too_large' }
  | { kind: 'not_ready'; message: string }
  | { kind: 'failed'; code: string; message: string; retryable: boolean };

export type NativeLiveReader = (
  operation: ControlPlaneNativeOperation
) => Promise<ControlPlaneControlResult>;

export type NativeLiveReadInput = {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
  kiloSessionId: string;
  operation: ControlPlaneNativeOperation;
  /** Test seam; production uses `defaultNativeLiveReader`. */
  read?: NativeLiveReader;
};

function invalidNativeResult(): NativeReadOutcome {
  return {
    kind: 'failed',
    code: 'KILO_UPSTREAM_RESPONSE_INVALID',
    message: 'Kilo runtime returned an invalid native response',
    retryable: false,
  };
}

function withoutPrivatePaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPrivatePaths);
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_PATH_KEYS.has(key)) continue;
    output[key] = withoutPrivatePaths(item);
  }
  return output;
}

function bounded(publicValue: unknown): NativeReadOutcome {
  const bytes = new TextEncoder().encode(JSON.stringify(publicValue)).length;
  if (bytes > MAX_PUBLIC_NATIVE_JSON_BYTES) return { kind: 'too_large' };
  return { kind: 'ok', body: publicValue };
}

/** A collection read answers an empty list when the runtime reports nothing. */
function absentAsEmpty(value: unknown): unknown {
  return value === null || value === undefined ? [] : value;
}

function sessionPublicShape(value: unknown, kiloSessionId: string): NativeReadOutcome {
  const parsed = nativeSessionSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== kiloSessionId) return invalidNativeResult();
  return bounded({
    ...projectPublicStructuredPaths(parsed.data, kiloSessionId),
    directory: publicCloudAgentDirectory(kiloSessionId),
  });
}

function messagesPublicShape(
  value: unknown,
  kiloSessionId: string,
  limit: number
): NativeReadOutcome {
  if (!Array.isArray(value)) return invalidNativeResult();
  const window = value.slice(-limit);
  if (!window.every(message => nativeMessageSchema.safeParse(message).success)) {
    return invalidNativeResult();
  }
  return bounded(projectPublicStructuredPaths(window, kiloSessionId));
}

function parseNativeResult(
  operation: ControlPlaneNativeOperation,
  value: unknown,
  kiloSessionId: string
): NativeReadOutcome {
  switch (operation.name) {
    case 'session.get':
      return sessionPublicShape(value, kiloSessionId);
    case 'session.messages':
      return messagesPublicShape(
        value,
        kiloSessionId,
        operation.limit ?? MAX_NATIVE_MESSAGE_WINDOW
      );
    case 'session.status': {
      const parsed = z.record(z.string(), z.unknown()).safeParse(value);
      if (!parsed.success || Object.keys(parsed.data).length > MAX_NATIVE_STATUSES) {
        return invalidNativeResult();
      }
      return bounded(
        Object.fromEntries(
          Object.entries(parsed.data).map(([sessionId, status]) => [
            sessionId,
            withoutPrivatePaths(status),
          ])
        )
      );
    }
    case 'session.todo': {
      const parsed = z.array(todoSchema).safeParse(absentAsEmpty(value));
      if (!parsed.success) return invalidNativeResult();
      return bounded(parsed.data);
    }
    case 'session.diff': {
      const parsed = z.array(diffFileSchema).safeParse(absentAsEmpty(value));
      if (!parsed.success) return invalidNativeResult();
      return bounded(projectPublicStructuredPaths(parsed.data, kiloSessionId));
    }
    case 'question.list': {
      const parsed = z.array(nativeQuestionSchema).safeParse(absentAsEmpty(value));
      if (!parsed.success) return invalidNativeResult();
      return bounded(projectPublicStructuredPaths(parsed.data, kiloSessionId));
    }
    case 'permission.list': {
      const parsed = z.array(nativePermissionSchema).safeParse(absentAsEmpty(value));
      if (!parsed.success) return invalidNativeResult();
      return bounded(projectPublicStructuredPaths(parsed.data, kiloSessionId));
    }
  }
}

export type DefaultNativeLiveReaderDeps = {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
};

/** Production reader: one allowlisted read on the Session DO; never wakes compute. */
export function defaultNativeLiveReader(deps: DefaultNativeLiveReaderDeps): NativeLiveReader {
  return operation =>
    withDORetry<DurableObjectStub<SandboxSessionV2>, ControlPlaneControlResult>(
      () => getSandboxSessionStub(deps.env, deps.userId, deps.cloudAgentSessionId as SessionId),
      stub => stub.kiloRequest(operation),
      'kiloRequest'
    );
}

/**
 * Reads one allowlisted native operation. A stopped session returns `not_ready`
 * without waking or billing compute; the Session DO and Sandbox DO fence the
 * request to the current route attempt and wrapper socket.
 */
export async function readNativeLiveOperation(
  params: NativeLiveReadInput
): Promise<NativeReadOutcome> {
  const read =
    params.read ??
    defaultNativeLiveReader({
      env: params.env,
      userId: params.userId,
      cloudAgentSessionId: params.cloudAgentSessionId,
    });
  let result: ControlPlaneControlResult;
  try {
    result = await read(params.operation);
  } catch {
    return {
      kind: 'failed',
      code: 'KILO_LIVE_RUNTIME_UNAVAILABLE',
      message: 'Cloud Agent Kilo runtime is not live',
      retryable: true,
    };
  }
  if (!result.ok) {
    if (result.error.code === 'not_ready' || result.error.code === 'not_found') {
      return { kind: 'not_ready', message: result.error.message };
    }
    if (result.error.code === 'too_large') return { kind: 'too_large' };
    return {
      kind: 'failed',
      code: 'KILO_UPSTREAM_RESPONSE_INVALID',
      message: result.error.message,
      retryable: result.error.retryable,
    };
  }
  return parseNativeResult(params.operation, result.result, params.kiloSessionId);
}
