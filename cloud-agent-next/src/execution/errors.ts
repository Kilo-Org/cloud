/**
 * Execution error types and error codes.
 *
 * These errors are surfaced to clients via HTTP status codes:
 * - 409 Conflict: EXECUTION_IN_PROGRESS
 * - 503 Service Unavailable: Retryable errors (sandbox, workspace, server, wrapper)
 * - 4xx/5xx: Non-retryable errors
 */

/**
 * Error codes for transient/retryable failures (503).
 * Client should retry with backoff.
 */
export type RetryableErrorCode =
  | 'SANDBOX_CONNECT_FAILED' // Sandbox may be waking up or network issue
  | 'WORKSPACE_SETUP_FAILED' // Git clone/network transient failure
  | 'KILO_SERVER_FAILED' // Kilo server starting up
  | 'WRAPPER_START_FAILED'; // Wrapper process starting

/**
 * Error codes for conflict errors (409).
 */
export type ConflictErrorCode = 'EXECUTION_IN_PROGRESS';

/**
 * Error codes for non-retryable failures (4xx/5xx).
 */
export type PermanentErrorCode =
  | 'INVALID_REQUEST' // Bad input (missing fields, invalid format)
  | 'SESSION_NOT_FOUND' // Session doesn't exist
  | 'WRAPPER_JOB_CONFLICT'; // Wrapper busy (internal error - shouldn't happen)

/**
 * All possible execution error codes.
 */
export type ExecutionErrorCode = RetryableErrorCode | ConflictErrorCode | PermanentErrorCode;

/**
 * Options for creating an ExecutionError.
 */
export type ExecutionErrorOptions = {
  /** Whether the error is retryable (affects HTTP status code mapping) */
  retryable: boolean;
  /** For EXECUTION_IN_PROGRESS, the ID of the active execution */
  activeExecutionId?: string;
  /** Original error that caused this (for logging/debugging) */
  cause?: unknown;
};

/**
 * Structured error for execution failures.
 * Maps to appropriate HTTP status codes in tRPC handlers.
 */
export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly retryable: boolean;
  readonly activeExecutionId?: string;

  constructor(code: ExecutionErrorCode, message: string, options: ExecutionErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'ExecutionError';
    this.code = code;
    this.retryable = options.retryable;
    this.activeExecutionId = options.activeExecutionId;
  }

  /**
   * Create a retryable error for sandbox connection failures.
   */
  static sandboxConnectFailed(message: string, cause?: unknown): ExecutionError {
    return new ExecutionError('SANDBOX_CONNECT_FAILED', message, { retryable: true, cause });
  }

  /**
   * Create a retryable error for workspace setup failures.
   */
  static workspaceSetupFailed(message: string, cause?: unknown): ExecutionError {
    return new ExecutionError('WORKSPACE_SETUP_FAILED', message, { retryable: true, cause });
  }

  /**
   * Create a retryable error for kilo server failures.
   */
  static kiloServerFailed(message: string, cause?: unknown): ExecutionError {
    return new ExecutionError('KILO_SERVER_FAILED', message, { retryable: true, cause });
  }

  /**
   * Create a retryable error for wrapper start failures.
   */
  static wrapperStartFailed(message: string, cause?: unknown): ExecutionError {
    return new ExecutionError('WRAPPER_START_FAILED', message, { retryable: true, cause });
  }

  /**
   * Create a conflict error when execution is already in progress.
   */
  static executionInProgress(activeExecutionId: string): ExecutionError {
    return new ExecutionError(
      'EXECUTION_IN_PROGRESS',
      `Execution ${activeExecutionId} is in progress`,
      { retryable: false, activeExecutionId }
    );
  }

  /**
   * Create a non-retryable error for invalid requests.
   */
  static invalidRequest(message: string): ExecutionError {
    return new ExecutionError('INVALID_REQUEST', message, { retryable: false });
  }

  /**
   * Create a non-retryable error when session is not found.
   */
  static sessionNotFound(sessionId: string): ExecutionError {
    return new ExecutionError('SESSION_NOT_FOUND', `Session ${sessionId} not found`, {
      retryable: false,
    });
  }

  /**
   * Create a non-retryable error for wrapper job conflicts.
   */
  static wrapperJobConflict(message: string): ExecutionError {
    return new ExecutionError('WRAPPER_JOB_CONFLICT', message, { retryable: false });
  }
}

/**
 * Type guard to check if an error is an ExecutionError.
 * Use error.retryable and error.code directly for condition checks.
 */
export function isExecutionError(error: unknown): error is ExecutionError {
  return error instanceof ExecutionError;
}
