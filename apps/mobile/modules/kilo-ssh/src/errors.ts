import { SSH_ERROR_CODES, type SshErrorCode } from './ReactNativeSsh.types';
import ReactNativeSsh from './ReactNativeSshModule';

/** A failed SSH call, categorised by [`SshErrorCode`]. */
export class SshError extends Error {
  readonly code: SshErrorCode;

  constructor(code: SshErrorCode, message: string) {
    super(message);
    this.name = 'SshError';
    this.code = code;
  }
}

/**
 * Whether repeating the call that failed can succeed without changing its
 * inputs. Only transient transport failures are retryable.
 */
export function isRetryableError(error: SshError): boolean {
  return ReactNativeSsh.isRetryableCode(error.code);
}

export async function guard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw translate(cause);
  }
}

export function translate(cause: unknown): SshError {
  if (cause instanceof SshError) {
    return cause;
  }

  const message = cause instanceof Error ? cause.message : String(cause);
  return new SshError(codeOf(cause), message);
}

function codeOf(cause: unknown): SshErrorCode {
  const candidate = hasCode(cause) ? cause.code : undefined;
  const match = SSH_ERROR_CODES.find((code) => code === candidate);

  return match ?? 'Protocol';
}

function hasCode(cause: unknown): cause is { code: unknown } {
  return typeof cause === 'object' && cause !== null && 'code' in cause;
}
