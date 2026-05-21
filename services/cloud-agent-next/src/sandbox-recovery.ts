import { logger } from './logger.js';
import { WorkspaceFilesystemPreparationError } from './workspace-errors.js';

type DestroyableSandbox = {
  destroy(): Promise<void>;
};

type RecoveryContext = {
  sandbox: DestroyableSandbox;
  sandboxId: string;
  sessionId?: string;
  phase: string;
};

type PreparationInfrastructureFailure =
  | {
      type: 'sandbox_internal_server_error';
      error: unknown;
      message: 'Sandbox returned 500 during workspace preparation';
    }
  | {
      type: 'sandbox_workspace_probe_timeout';
      error: unknown;
      message: string;
    }
  | {
      type: 'workspace_filesystem_preparation_error';
      error: WorkspaceFilesystemPreparationError;
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;

  const property = value[key];
  return typeof property === 'string' ? property : undefined;
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;

  const property = value[key];
  return typeof property === 'number' ? property : undefined;
}

function getNestedProperty(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export const SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE =
  'Sandbox workspace Git probe timed out before wrapper bootstrap';

export function isSandboxWorkspaceProbeTimeoutError(error: unknown): boolean {
  const message = getStringProperty(error, 'message') ?? getErrorMessage(error);
  return message.startsWith(SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE);
}

function messageLooksLikeSandboxInternalServerError(message: string): boolean {
  return (
    /http\s+error!\s+status:\s*500\b/i.test(message) ||
    /http\s*500\b/i.test(message) ||
    /status:\s*500\b/i.test(message) ||
    (/internal server error/i.test(message) && /(sandbox|container|cloudflare)/i.test(message))
  );
}

function isSandboxErrorObject(value: unknown): boolean {
  const name = getStringProperty(value, 'name');
  const code = getStringProperty(value, 'code');

  return name === 'SandboxError' || code === 'INTERNAL_ERROR';
}

function hasInternalServerStatus(value: unknown): boolean {
  if (getNumberProperty(value, 'httpStatus') === 500) return true;

  const errorResponse = getNestedProperty(value, 'errorResponse');
  if (getNumberProperty(errorResponse, 'httpStatus') === 500) return true;

  return (
    getNumberProperty(value, 'status') === 500 &&
    (isSandboxErrorObject(value) || isSandboxErrorObject(errorResponse))
  );
}

function isSandboxInternalServerErrorWithSeen(error: unknown, seen: WeakSet<object>): boolean {
  if (typeof error === 'string') {
    return messageLooksLikeSandboxInternalServerError(error);
  }

  if (!isRecord(error)) {
    return false;
  }

  if (seen.has(error)) {
    return false;
  }
  seen.add(error);

  if (hasInternalServerStatus(error)) {
    return true;
  }

  const sandboxErrorObject = isSandboxErrorObject(error);
  const message = getStringProperty(error, 'message') ?? getErrorMessage(error);
  if (messageLooksLikeSandboxInternalServerError(message) && sandboxErrorObject) {
    return true;
  }

  // Wrapped errors (e.g. ExecutionError with code WRAPPER_START_FAILED, or
  // workspace setup wrappers) are classified by walking errorResponse and cause
  // so we recover whenever the underlying SandboxError is a 500.
  const errorResponse = getNestedProperty(error, 'errorResponse');
  if (isSandboxInternalServerErrorWithSeen(errorResponse, seen)) {
    return true;
  }

  const cause = getNestedProperty(error, 'cause');
  return isSandboxInternalServerErrorWithSeen(cause, seen);
}

export function isSandboxInternalServerError(error: unknown): boolean {
  return isSandboxInternalServerErrorWithSeen(error, new WeakSet());
}

function getWorkspaceFilesystemPreparationErrorWithSeen(
  error: unknown,
  seen: WeakSet<object>
): WorkspaceFilesystemPreparationError | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  if (seen.has(error)) {
    return undefined;
  }
  seen.add(error);

  if (error instanceof WorkspaceFilesystemPreparationError) {
    return error;
  }

  const cause = getNestedProperty(error, 'cause');
  return getWorkspaceFilesystemPreparationErrorWithSeen(cause, seen);
}

function getWorkspaceFilesystemPreparationError(
  error: unknown
): WorkspaceFilesystemPreparationError | undefined {
  return getWorkspaceFilesystemPreparationErrorWithSeen(error, new WeakSet());
}

export function getPreparationInfrastructureFailure(
  error: unknown
): PreparationInfrastructureFailure | undefined {
  const cause = getNestedProperty(error, 'cause');
  const sandboxError = isSandboxInternalServerError(cause)
    ? cause
    : isSandboxInternalServerError(error)
      ? error
      : undefined;

  if (sandboxError !== undefined) {
    return {
      type: 'sandbox_internal_server_error',
      error: sandboxError,
      message: 'Sandbox returned 500 during workspace preparation',
    };
  }

  const workspaceProbeTimeoutError = isSandboxWorkspaceProbeTimeoutError(cause)
    ? cause
    : isSandboxWorkspaceProbeTimeoutError(error)
      ? error
      : undefined;

  if (workspaceProbeTimeoutError !== undefined) {
    return {
      type: 'sandbox_workspace_probe_timeout',
      error: workspaceProbeTimeoutError,
      message: SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE,
    };
  }

  const workspaceError = getWorkspaceFilesystemPreparationError(error);
  if (workspaceError) {
    return {
      type: 'workspace_filesystem_preparation_error',
      error: workspaceError,
      message: workspaceError.message,
    };
  }

  return undefined;
}

export async function destroySandboxAfterInternalServerError(
  context: RecoveryContext,
  error: unknown
): Promise<boolean> {
  if (!isSandboxInternalServerError(error)) {
    return false;
  }

  const errorMessage = getErrorMessage(error);
  logger
    .withFields({
      sandboxId: context.sandboxId,
      sessionId: context.sessionId,
      phase: context.phase,
      error: errorMessage,
      logTag: 'sandbox_500_detected',
    })
    .error('Sandbox returned 500 during workspace preparation; destroying sandbox');

  try {
    await context.sandbox.destroy();
    logger
      .withFields({
        sandboxId: context.sandboxId,
        sessionId: context.sessionId,
        phase: context.phase,
        logTag: 'sandbox_500_destroyed',
      })
      .info('Destroyed sandbox after workspace preparation 500');
    return true;
  } catch (destroyError) {
    logger
      .withFields({
        sandboxId: context.sandboxId,
        sessionId: context.sessionId,
        phase: context.phase,
        originalError: errorMessage,
        destroyError: getErrorMessage(destroyError),
        logTag: 'sandbox_500_destroy_failed',
      })
      .error('Failed to destroy sandbox after workspace preparation 500');
    return false;
  }
}

export async function destroySandboxAfterPreparationInfrastructureFailure(
  context: RecoveryContext,
  error: unknown
): Promise<boolean> {
  const failure = getPreparationInfrastructureFailure(error);
  if (!failure) {
    return false;
  }

  if (failure.type === 'sandbox_internal_server_error') {
    return destroySandboxAfterInternalServerError(context, failure.error);
  }

  if (failure.type === 'sandbox_workspace_probe_timeout') {
    const errorMessage = getErrorMessage(failure.error);
    logger
      .withFields({
        sandboxId: context.sandboxId,
        sessionId: context.sessionId,
        phase: context.phase,
        error: errorMessage,
        logTag: 'sandbox_workspace_probe_timeout_detected',
      })
      .error('Sandbox workspace Git probe timed out; destroying sandbox');

    try {
      await context.sandbox.destroy();
      logger
        .withFields({
          sandboxId: context.sandboxId,
          sessionId: context.sessionId,
          phase: context.phase,
          logTag: 'sandbox_workspace_probe_timeout_destroyed',
        })
        .info('Destroyed sandbox after workspace Git probe timeout');
      return true;
    } catch (destroyError) {
      logger
        .withFields({
          sandboxId: context.sandboxId,
          sessionId: context.sessionId,
          phase: context.phase,
          originalError: errorMessage,
          destroyError: getErrorMessage(destroyError),
          logTag: 'sandbox_workspace_probe_timeout_destroy_failed',
        })
        .error('Failed to destroy sandbox after workspace Git probe timeout');
      return false;
    }
  }

  const errorMessage = getErrorMessage(failure.error);
  logger
    .withFields({
      sandboxId: context.sandboxId,
      sessionId: context.sessionId,
      phase: context.phase,
      target: failure.error.target,
      error: errorMessage,
      logTag: 'workspace_filesystem_preparation_failed',
    })
    .error('Workspace filesystem preparation failed; destroying sandbox');

  try {
    await context.sandbox.destroy();
    logger
      .withFields({
        sandboxId: context.sandboxId,
        sessionId: context.sessionId,
        phase: context.phase,
        target: failure.error.target,
        logTag: 'workspace_filesystem_preparation_destroyed',
      })
      .info('Destroyed sandbox after workspace filesystem preparation failure');
    return true;
  } catch (destroyError) {
    logger
      .withFields({
        sandboxId: context.sandboxId,
        sessionId: context.sessionId,
        phase: context.phase,
        target: failure.error.target,
        originalError: errorMessage,
        destroyError: getErrorMessage(destroyError),
        logTag: 'workspace_filesystem_preparation_destroy_failed',
      })
      .error('Failed to destroy sandbox after workspace filesystem preparation failure');
    return false;
  }
}

export async function withPreparationInfrastructureRecovery<T>(
  context: RecoveryContext,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await destroySandboxAfterPreparationInfrastructureFailure(context, error);
    throw error;
  }
}
