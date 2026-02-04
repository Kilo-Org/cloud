/**
 * Base error for all KiloClient errors.
 */
export class KiloClientError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'KiloClientError';
  }
}

/**
 * HTTP error from kilo server (4xx/5xx).
 */
export class KiloApiError extends KiloClientError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly response?: string
  ) {
    super(message);
    this.name = 'KiloApiError';
  }
}

/**
 * Request timed out.
 */
export class KiloTimeoutError extends KiloClientError {
  constructor(
    message: string,
    public readonly timeoutMs: number
  ) {
    super(message);
    this.name = 'KiloTimeoutError';
  }
}

/**
 * Method called without active session.
 */
export class KiloSessionNotSetError extends KiloClientError {
  constructor() {
    super('No session set. Call createSession() or resumeSession() first.');
    this.name = 'KiloSessionNotSetError';
  }
}

/**
 * Session not found (404).
 */
export class KiloSessionNotFoundError extends KiloClientError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'KiloSessionNotFoundError';
  }
}

/**
 * Server not ready/healthy.
 */
export class KiloServerNotReadyError extends KiloClientError {
  constructor(message: string) {
    super(message);
    this.name = 'KiloServerNotReadyError';
  }
}
