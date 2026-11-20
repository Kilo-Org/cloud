import { NextResponse } from 'next/server';
import {
  readDb,
  sql,
  type DrizzleTransaction,
  type ReadTransactionConfig,
  type ReadTransactionRunner,
} from '@kilocode/web-shared/lib/drizzle';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { boundedReadErrorSqlState } from '@kilocode/web-shared/lib/organizations/bounded-replica-read';

/**
 * Server-side bounds for the replica reads that admit a gateway request before the upstream
 * request starts. These reads normally take milliseconds. Without a bound, a read stuck behind
 * WAL replay, replica lag or contention waits for the role's default statement timeout while it
 * holds the request and a pool connection. A read that needs more than 3 s, or waits more than
 * 1 s for a lock, is already failing the caller, so it ends with a retryable 503 instead.
 * `withBoundedReplicaRead` in `organizations/bounded-replica-read` bounds optional dashboard reads
 * more loosely.
 */
export const GATEWAY_REPLICA_STATEMENT_TIMEOUT_MS = 3_000;
export const GATEWAY_REPLICA_LOCK_TIMEOUT_MS = 1_000;

/**
 * Supavisor in transaction mode drops session `SET` and startup parameters, so the bounds are
 * `SET LOCAL` inside the read's own transaction, like `workerTransactionBoundsSql` in
 * `@kilocode/db/client`.
 */
export const gatewayReplicaReadBoundsSql =
  `SET LOCAL statement_timeout = '${GATEWAY_REPLICA_STATEMENT_TIMEOUT_MS}ms'; ` +
  `SET LOCAL lock_timeout = '${GATEWAY_REPLICA_LOCK_TIMEOUT_MS}ms'`;

/**
 * Runs `read` on `readDb` in a read-only transaction bounded by `gatewayReplicaReadBoundsSql`.
 * Only for reads: a primary write must not run inside `read`, because the replica transaction
 * would stay open for its whole round trip.
 *
 * A read that fails because of a bound (SQLSTATE `57014` or `55P03`), or that the replica cancels
 * for a recovery conflict (`40001`), throws `GatewayReplicaReadUnavailableError`; see
 * `boundedReadErrorSqlState`. Other errors propagate unchanged.
 */
export async function boundedGatewayReplicaRead<T>(
  operation: string,
  read: (tx: DrizzleTransaction) => Promise<T>,
  config: ReadTransactionConfig = {}
): Promise<T> {
  try {
    return await readDb.transaction(
      async tx => {
        await tx.execute(sql.raw(gatewayReplicaReadBoundsSql));
        return await read(tx);
      },
      { ...config, accessMode: 'read only' }
    );
  } catch (error) {
    const sqlState = boundedReadErrorSqlState(error);
    if (!sqlState) throw error;
    console.warn('AI gateway replica read hit its bound', { operation, sqlState });
    throw new GatewayReplicaReadUnavailableError(operation, sqlState, error);
  }
}

/** A `ReadTransactionRunner` for gateway helpers; `operation` names the read in the warning. */
export function gatewayReplicaReader(operation: string): ReadTransactionRunner {
  return (read, config) => boundedGatewayReplicaRead(operation, read, config);
}

export class GatewayReplicaReadUnavailableError extends Error {
  constructor(
    readonly operation: string,
    readonly sqlState: string,
    cause: unknown
  ) {
    super(`AI gateway replica read '${operation}' hit its bound (SQLSTATE ${sqlState})`, {
      cause,
    });
    this.name = 'GatewayReplicaReadUnavailableError';
  }
}

export const GATEWAY_REPLICA_READ_RETRY_AFTER_SECONDS = 2;

export function replicaReadUnavailableResponse() {
  const message = 'The service is temporarily unavailable. Please retry in a few seconds.';
  return NextResponse.json(
    { error: 'Service Unavailable', error_type: ProxyErrorType.temporarily_unavailable, message },
    {
      status: 503,
      headers: { 'Retry-After': String(GATEWAY_REPLICA_READ_RETRY_AFTER_SECONDS) },
    }
  );
}

/**
 * Answers a request whose admission read hit its bound with the retryable 503. Other errors
 * propagate unchanged. The bounded reads all run before the upstream request starts, so the
 * handler has not returned a response yet when one fails.
 */
export function withReplicaReadUnavailableResponse<Args extends unknown[], R extends Response>(
  handler: (...args: Args) => Promise<R>
): (...args: Args) => Promise<R | NextResponse> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof GatewayReplicaReadUnavailableError) {
        return replicaReadUnavailableResponse();
      }
      throw error;
    }
  };
}
