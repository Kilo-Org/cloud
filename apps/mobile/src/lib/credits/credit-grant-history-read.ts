import { type QueryFunction, type QueryKey } from '@tanstack/react-query';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { readTrpcErrorField } from '@/lib/trpc-error';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** One page of the personal grant history the credit history merges in. */
export type CreditGrantHistoryPage = RouterOutputs['user']['getCreditGrantHistory'];

/**
 * Whether the failure is tRPC's own missing-procedure answer.
 *
 * `@trpc/server` rejects a path its router does not define with `NOT_FOUND` and
 * the message `No "query"-procedure on path "…"`. That is the one signal the
 * wire carries, so it is matched by message. A bare `NOT_FOUND` is a different
 * answer — the read ran and failed for its own reason — and must still surface,
 * so the screen keeps its not-found state instead of the failure being masked
 * as an empty page.
 */
export function isMissingGrantHistoryProcedureError(error: unknown): boolean {
  return (
    readTrpcErrorField(error, 'code') === 'NOT_FOUND' &&
    (readTrpcErrorField(error, 'message') ?? '').includes('No "query"-procedure')
  );
}

/**
 * The grants read, with a pre-procedure server answering an empty page.
 *
 * `getCreditGrantHistory` is newer than the app: a server from before it
 * rejects the path. Read as a permanent not-found, that leaves a grant-only
 * account on a full-screen error with no Retry, so the missing procedure
 * resolves as "no grants" and the history lists the ledger and purchases
 * alone. Every other failure is rethrown unchanged.
 */
export function creditGrantHistoryQueryFn<TQueryKey extends QueryKey>(
  read: QueryFunction<CreditGrantHistoryPage, TQueryKey>
): QueryFunction<CreditGrantHistoryPage, TQueryKey> {
  return async context => {
    try {
      return await read(context);
    } catch (error) {
      if (isMissingGrantHistoryProcedureError(error)) {
        // A fresh page per answer: the object is cached, and two accounts must
        // never share one mutable array.
        return { grants: [], hasMore: false };
      }
      throw error;
    }
  };
}
