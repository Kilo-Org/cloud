import { logger } from './logger.js';
import { DEFAULT_BACKEND_URL } from './constants.js';

type DestroyableSandbox = {
  destroy(): Promise<void>;
};

type RecoveryEnv = {
  KILOCODE_BACKEND_BASE_URL?: string;
  INTERNAL_API_SECRET?: string;
};

export const SANDBOX_DESTROYED_AFTER_500_ERROR = 'SANDBOX_DESTROYED_AFTER_500' as const;

export type SandboxDestroyedAfter500Data = {
  code: typeof SANDBOX_DESTROYED_AFTER_500_ERROR;
  sandboxId: string;
  phase: string;
  sessionId?: string;
  destroyedAt: string;
};

export type SandboxRecoveryResult =
  | { destroyed: false }
  | { destroyed: true; data: SandboxDestroyedAfter500Data };

const SANDBOX_DESTROYED_DATA_FIELD = '__sandboxDestroyedAfter500';

export class SandboxDestroyedAfter500Error extends Error {
  readonly code = SANDBOX_DESTROYED_AFTER_500_ERROR;
  readonly data: SandboxDestroyedAfter500Data;

  constructor(originalError: unknown, data: SandboxDestroyedAfter500Data) {
    super(getErrorMessage(originalError), { cause: originalError });
    this.name = 'SandboxDestroyedAfter500Error';
    this.data = data;
  }
}

function isSandboxDestroyedAfter500Data(value: unknown): value is SandboxDestroyedAfter500Data {
  return (
    isRecord(value) &&
    value.code === SANDBOX_DESTROYED_AFTER_500_ERROR &&
    typeof value.sandboxId === 'string' &&
    typeof value.phase === 'string' &&
    typeof value.destroyedAt === 'string'
  );
}

export function attachSandboxDestroyedAfter500Data(
  error: unknown,
  data: SandboxDestroyedAfter500Data
): void {
  if (!isRecord(error)) return;
  Object.defineProperty(error, SANDBOX_DESTROYED_DATA_FIELD, {
    value: data,
    configurable: true,
  });
}

export function getSandboxDestroyedAfter500Error(
  error: unknown
): SandboxDestroyedAfter500Error | undefined {
  if (error instanceof SandboxDestroyedAfter500Error) return error;
  if (!isRecord(error)) return undefined;
  const data = error[SANDBOX_DESTROYED_DATA_FIELD];
  if (isSandboxDestroyedAfter500Data(data)) {
    return new SandboxDestroyedAfter500Error(error, data);
  }
  return getSandboxDestroyedAfter500Error(error.cause);
}

type RecoveryContext = {
  sandbox: DestroyableSandbox;
  sandboxId: string;
  sessionId?: string;
  phase: string;
  env?: RecoveryEnv;
  onSandboxDestroyed?: (data: SandboxDestroyedAfter500Data) => Promise<void> | void;
};

export type CodeReviewSandboxDestroyedNotification = {
  sandboxId: string;
  triggeringSessionId?: string;
  phase: string;
  reason: 'sandbox_500';
  destroyedAt: string;
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

export async function notifyCodeReviewSandboxDestroyed(
  env: RecoveryEnv | undefined,
  payload: CodeReviewSandboxDestroyedNotification
): Promise<void> {
  if (!env?.INTERNAL_API_SECRET) {
    logger
      .withFields({ sandboxId: payload.sandboxId, phase: payload.phase })
      .error('Skipping code review sandbox recovery notification: internal secret unavailable');
    return;
  }

  const backendUrl = env.KILOCODE_BACKEND_BASE_URL || DEFAULT_BACKEND_URL;
  let response: Response;
  try {
    response = await fetch(`${backendUrl}/api/internal/code-review-sandbox-destroyed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': env.INTERNAL_API_SECRET,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    logger
      .withFields({
        sandboxId: payload.sandboxId,
        phase: payload.phase,
        error: getErrorMessage(error),
      })
      .error('Failed to notify web app of destroyed sandbox');
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    logger
      .withFields({
        sandboxId: payload.sandboxId,
        phase: payload.phase,
        status: response.status,
        body: body.slice(0, 500),
      })
      .error('Web app rejected destroyed sandbox notification');
  }
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
): Promise<SandboxRecoveryResult> {
  if (!isSandboxInternalServerError(error)) {
    return { destroyed: false };
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
    const data: SandboxDestroyedAfter500Data = {
      code: SANDBOX_DESTROYED_AFTER_500_ERROR,
      sandboxId: context.sandboxId,
      phase: context.phase,
      destroyedAt: new Date().toISOString(),
    };
    if (context.sessionId) {
      data.sessionId = context.sessionId;
    }
    logger
      .withFields({
        sandboxId: context.sandboxId,
        sessionId: context.sessionId,
        phase: context.phase,
        logTag: 'sandbox_500_destroyed',
      })
      .info('Destroyed sandbox after workspace preparation 500');

    try {
      await context.onSandboxDestroyed?.(data);
    } catch (metadataError) {
      logger
        .withFields({
          sandboxId: context.sandboxId,
          sessionId: context.sessionId,
          phase: context.phase,
          error: getErrorMessage(metadataError),
        })
        .warn('Failed to persist sandbox destroyed metadata');
    }

    await notifyCodeReviewSandboxDestroyed(context.env, {
      sandboxId: context.sandboxId,
      triggeringSessionId: context.sessionId,
      phase: context.phase,
      reason: 'sandbox_500',
      destroyedAt: data.destroyedAt,
    });

    return { destroyed: true, data };
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
    return { destroyed: false };
  }
}

export async function withSandboxInternalServerErrorRecovery<T>(
  context: RecoveryContext,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const existingRecoveryError = getSandboxDestroyedAfter500Error(error);
    if (existingRecoveryError) {
      throw error;
    }

    const cause = getNestedProperty(error, 'cause');
    const recoveryError = isSandboxInternalServerError(cause) ? cause : error;
    const recovery = await destroySandboxAfterInternalServerError(context, recoveryError);
    if (recovery.destroyed) {
      attachSandboxDestroyedAfter500Data(error, recovery.data);
      throw error;
    }
    throw error;
  }
}
