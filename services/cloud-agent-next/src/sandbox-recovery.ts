import { logger } from './logger.js';

type DestroyableSandbox = {
  destroy(): Promise<void>;
};

type RecoveryContext = {
  sandbox: DestroyableSandbox;
  sandboxId: string;
  sessionId?: string;
  phase: string;
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

export async function withSandboxInternalServerErrorRecovery<T>(
  context: RecoveryContext,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const cause = getNestedProperty(error, 'cause');
    const recoveryError = isSandboxInternalServerError(cause) ? cause : error;
    await destroySandboxAfterInternalServerError(context, recoveryError);
    throw error;
  }
}
