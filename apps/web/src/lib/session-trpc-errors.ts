import 'server-only';

import { TRPCClientError } from '@trpc/client';
import { TRPCError } from '@trpc/server';

/**
 * The fields a cloud-agent worker puts in a tRPC client error: the worker's
 * own code, the HTTP status it answered with, and its retryability hint.
 */
type SessionTrpcErrorData = {
  code?: string;
  httpStatus?: number;
  clientError?: { retryable?: unknown };
};

/** The worker error envelope, from `data` or the shape a serialized error keeps. */
function sessionTrpcErrorData(err: unknown): SessionTrpcErrorData | undefined {
  if (!(err instanceof TRPCClientError)) return undefined;
  const data = err.data as SessionTrpcErrorData | undefined;
  const shapeData = (err.shape as { data?: SessionTrpcErrorData } | undefined)?.data;
  if (data === undefined && shapeData === undefined) return undefined;
  return {
    code: data?.code ?? shapeData?.code,
    httpStatus: data?.httpStatus ?? shapeData?.httpStatus,
    clientError: data?.clientError ?? shapeData?.clientError,
  };
}

/**
 * Check if an error indicates the session was not found in the cloud-agent DO.
 * This is expected for legacy sessions created before the new DO-based system.
 */
export function isSessionNotFoundError(err: unknown): boolean {
  const errorData = sessionTrpcErrorData(err);
  return errorData?.code === 'NOT_FOUND' || errorData?.httpStatus === 404;
}

const TRANSIENT_TRPC_CODES = new Set(['SERVICE_UNAVAILABLE', 'TIMEOUT']);
const TRANSIENT_HTTP_STATUSES = new Set([503, 504]);
const TRANSPORT_ERROR_NAMES = new Set([
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'ConnectTimeoutError',
  'AbortError',
  'TimeoutError',
]);

function isTransportFailure(cause: unknown, depth = 0): boolean {
  if (typeof cause !== 'object' || cause === null || depth > 3) return false;
  const name = 'name' in cause ? cause.name : undefined;
  const message = 'message' in cause ? cause.message : undefined;
  if (typeof name === 'string' && TRANSPORT_ERROR_NAMES.has(name)) return true;
  if (cause instanceof TypeError && message === 'fetch failed') return true;
  return isTransportFailure('cause' in cause ? cause.cause : undefined, depth + 1);
}

/** Worker outages, timeouts, and network failures that a later retry may resolve. */
export function isTransientRuntimeError(err: unknown): boolean {
  if (!(err instanceof TRPCClientError)) return false;
  const errorData = sessionTrpcErrorData(err);
  if (errorData === undefined) return isTransportFailure(err.cause);
  if (errorData.code && TRANSIENT_TRPC_CODES.has(errorData.code)) return true;
  if (errorData.httpStatus && TRANSIENT_HTTP_STATUSES.has(errorData.httpStatus)) return true;
  const retryable = errorData.clientError?.retryable === true;
  // Internal errors stay defects even when a Worker envelope marks them retryable.
  return retryable && errorData.code !== undefined && errorData.code !== 'INTERNAL_SERVER_ERROR';
}

/** The worker code a session read failure carried, for callers with their own mapping. */
export function sessionTrpcErrorCode(err: unknown): string | undefined {
  return sessionTrpcErrorData(err)?.code;
}

export type SessionReadErrorMessages = {
  /** The session has no state in the worker (a legacy session, or one that was removed). */
  notFound: string;
  /** A worker outage, timeout, or network failure a later retry may resolve. */
  unavailable: string;
};

/**
 * The tRPC error one cloud-agent worker failure on a session read becomes, or
 * undefined when the failure is unclassified and must surface unchanged.
 *
 * A session read shared by the CLI session and Cloud Agent routers uses this so
 * a worker that is down or missing the session answers with a code the client
 * already renders, instead of an opaque internal error.
 */
export function sessionReadTrpcError(
  error: unknown,
  messages: SessionReadErrorMessages
): TRPCError | undefined {
  if (isSessionNotFoundError(error)) {
    return new TRPCError({ code: 'NOT_FOUND', message: messages.notFound, cause: error });
  }
  if (isTransientRuntimeError(error)) {
    return new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: messages.unavailable,
      cause: error,
    });
  }
  return undefined;
}
