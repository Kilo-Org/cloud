import { type QueryFunction, type QueryKey } from '@tanstack/react-query';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import * as z from 'zod';

import { readTrpcErrorField } from '@/lib/trpc-error';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** One page of the personal grant history the credit history merges in. */
export type CreditGrantHistoryPage = RouterOutputs['user']['getCreditGrantHistory'];

// The message travels on the error itself for a tRPC client error (and for the
// plain-object fixtures the suites build), and under the serialized envelope for
// a shaped one. A value with neither carries no signature to match.
const ErrorMessageSchema = z.looseObject({ message: z.string() });

/** The message a failure carries, wherever the transport put it. */
function readErrorMessage(error: unknown): string {
  const envelope = readTrpcErrorField(error, 'message');
  if (envelope !== undefined) {
    return envelope;
  }
  const carrier = ErrorMessageSchema.safeParse(error);
  return carrier.success ? carrier.data.message : '';
}

/**
 * Whether the failure is tRPC's own missing-procedure answer.
 *
 * `@trpc/server` rejects a path its router does not define with `NOT_FOUND` and
 * the message `No "query"-procedure on path "…"`; the message is the one signal
 * that tells it apart from every other `NOT_FOUND`. A bare `NOT_FOUND` (a
 * resource the read looked for and did not find) must still surface, so the
 * screen keeps its not-found state instead of the failure being read as an
 * empty page.
 */
export function isMissingGrantHistoryProcedureError(error: unknown): boolean {
  return (
    readTrpcErrorField(error, 'code') === 'NOT_FOUND' &&
    readErrorMessage(error).includes('No "query"-procedure')
  );
}

/**
 * The grants read, with a server that predates the procedure answering an
 * empty page.
 *
 * `getCreditGrantHistory` is newer than the app: a server from before it
 * rejects the path. Read as a permanent not-found, that leaves a grant-only
 * account on a full-screen error with no Retry, so the missing procedure
 * resolves as "no grants" and the history lists the ledger and purchases
 * alone. Every other failure is rethrown unchanged, so the screen's own
 * classification still sees it.
 */
export function creditGrantHistoryQueryFn<TQueryKey extends QueryKey>(
  read: QueryFunction<CreditGrantHistoryPage, TQueryKey>
): QueryFunction<CreditGrantHistoryPage, TQueryKey> {
  return async context => {
    try {
      return await read(context);
    } catch (error) {
      if (isMissingGrantHistoryProcedureError(error)) {
        // A fresh page per answer: this value is cached, and two accounts must
        // never share one mutable array.
        return { grants: [], hasMore: false };
      }
      throw error;
    }
  };
}
