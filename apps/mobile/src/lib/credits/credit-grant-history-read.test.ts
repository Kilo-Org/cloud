// The personal grant history reads a procedure newer than the app, so a server
// from before it answers `NOT_FOUND`. The read resolves that one answer as an
// empty page — a grant-only account otherwise lands on a permanent, no-retry
// error for a list that is simply absent — and rethrows every other failure so
// the screen keeps its own classification.
import { QueryClient, type QueryFunctionContext } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  type CreditGrantHistoryPage,
  creditGrantHistoryQueryFn,
  isMissingGrantHistoryProcedureError,
} from './credit-grant-history-read';

/** The tRPC client error shape: the code under `data`, the message on the error. */
function trpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { data: { code } });
}

/** The context the query function receives; the wrapped read ignores it. */
const queryContext: QueryFunctionContext = {
  client: new QueryClient(),
  queryKey: ['user', 'getCreditGrantHistory'],
  signal: new AbortController().signal,
  meta: undefined,
};

function reading(read: () => Promise<CreditGrantHistoryPage>) {
  return creditGrantHistoryQueryFn(vi.fn(read))(queryContext);
}

/** tRPC's own answer for a path the router does not define. */
const MISSING_PROCEDURE_MESSAGE = 'No "query"-procedure on path "user.getCreditGrantHistory"';

describe('isMissingGrantHistoryProcedureError', () => {
  it('recognizes the procedure-missing NOT_FOUND signature', () => {
    expect(
      isMissingGrantHistoryProcedureError(trpcError('NOT_FOUND', MISSING_PROCEDURE_MESSAGE))
    ).toBe(true);
  });

  it('rejects a bare NOT_FOUND that means something else', () => {
    expect(isMissingGrantHistoryProcedureError(trpcError('NOT_FOUND', 'No credit grants'))).toBe(
      false
    );
  });

  it('rejects the procedure-missing message under another code', () => {
    expect(
      isMissingGrantHistoryProcedureError(
        trpcError('INTERNAL_SERVER_ERROR', MISSING_PROCEDURE_MESSAGE)
      )
    ).toBe(false);
  });

  it('rejects non-tRPC values', () => {
    expect(isMissingGrantHistoryProcedureError(new Error(MISSING_PROCEDURE_MESSAGE))).toBe(false);
    expect(isMissingGrantHistoryProcedureError(null)).toBe(false);
    expect(isMissingGrantHistoryProcedureError(undefined)).toBe(false);
  });
});

describe('creditGrantHistoryQueryFn', () => {
  it('resolves a missing procedure as an empty page', async () => {
    await expect(
      reading(() => Promise.reject(trpcError('NOT_FOUND', MISSING_PROCEDURE_MESSAGE)))
    ).resolves.toEqual({ grants: [], hasMore: false });
  });

  it('rethrows a bare NOT_FOUND so the read is not silently masked', async () => {
    const error = trpcError('NOT_FOUND', 'No credit grants');
    await expect(reading(() => Promise.reject(error))).rejects.toBe(error);
  });

  it('rethrows FORBIDDEN unchanged', async () => {
    const error = trpcError('FORBIDDEN', 'Not allowed');
    await expect(reading(() => Promise.reject(error))).rejects.toBe(error);
  });

  it('returns a successful page unchanged', async () => {
    const page: CreditGrantHistoryPage = {
      grants: [
        {
          id: 'grant-1',
          date: '2026-11-01T00:00:00.000Z',
          amount_mUsd: 5_000_000,
          kind: 'welcome',
        },
      ],
      hasMore: false,
    };
    await expect(reading(() => Promise.resolve(page))).resolves.toBe(page);
  });
});
