// Pure classification of a tRPC query error for the PR Review Overview /
// Checks surfaces. The PR review surface has a slightly different error
// matrix than the rest of the app: PRECONDITION_FAILED is treated as a
// configuration/connect-state problem (the user must reopen the connect
// flow rather than retry the request), and the App Store rules forbid
// any retryable UI on permanent permission errors.
//
// Lives in `lib/pr-review/` so screens (and their unit tests) can import
// the same decision tree. No React, no react-query, no expo modules —
// that keeps it testable in plain Node.

type PrReviewQueryState =
  | {
      /**
       * The fetch failed with a transient error (network, 5xx, etc.). The
       * caller should render `QueryError` with a Retry CTA.
       */
      kind: 'retryable';
    }
  | {
      /**
       * The fetch failed with a tRPC code the user can't recover from by
       * retrying (e.g. they don't have access to this PR). The caller
       * should render a terminal permission message with NO CTA.
       */
      kind: 'permission';
    }
  | {
      /**
       * The PR / checks were not found. The caller should render the
       * "PR unavailable" empty state with a single CTA pointing at the
       * Kilo GitHub App install flow, and NO retry.
       */
      kind: 'not-found';
    }
  | {
      /**
       * The connect gate's own precondition check failed. The reviewer
       * is most likely disconnected or revoked, so the caller should
       * surface a reconnect CTA rather than a generic retry — retrying
       * the same query without fixing the underlying connection will
       * keep failing in the same way.
       */
      kind: 'reconnect';
    };

/**
 * Extracts the tRPC error code from an unknown thrown value. tRPC v11
 * client errors expose `data.code`; server-shaped errors expose
 * `shape.data.code`. Anything else is treated as an unknown transient
 * error (retryable).
 */
function readTrpcErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  // Direct TRPCClientError — `data` is the shape's data.
  const data = record.data;
  if (data && typeof data === 'object') {
    const code = (data as Record<string, unknown>).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  // Nested `shape` form (some tRPC versions wrap the shape).
  const shape = record.shape;
  if (shape && typeof shape === 'object') {
    const shapeData = (shape as Record<string, unknown>).data;
    if (shapeData && typeof shapeData === 'object') {
      const code = (shapeData as Record<string, unknown>).code;
      if (typeof code === 'string') {
        return code;
      }
    }
  }
  // Some helpers expose the code at the top level.
  const top = record.code;
  if (typeof top === 'string') {
    return top;
  }
  return undefined;
}

export function classifyPrReviewQueryState(error: unknown): PrReviewQueryState {
  const code = readTrpcErrorCode(error);
  if (code === 'PRECONDITION_FAILED') {
    return { kind: 'reconnect' };
  }
  if (code === 'NOT_FOUND') {
    return { kind: 'not-found' };
  }
  if (code === 'FORBIDDEN') {
    return { kind: 'permission' };
  }
  if (code === 'UNAUTHORIZED') {
    return { kind: 'reconnect' };
  }
  return { kind: 'retryable' };
}

type PrReviewMutationErrorState =
  | {
      /**
       * The mutation failed with a transient error (network, 5xx, rate
       * limit, etc.). The caller should keep the retry affordance
       * available.
       */
      kind: 'retryable';
    }
  | {
      /**
       * The mutation failed with a validation / 422-class error (e.g.
       * approving your own PR or a stale comment line). The caller should
       * show a specific inline message and remove the retry affordance;
       * the user must change the input or event before submitting again.
       */
      kind: 'bad-request';
      /** Original error message, suitable for logging but not the UI. */
      message: string;
    }
  | {
      /**
       * The mutation failed with a permanent permission error. The
       * caller should show a specific inline message and remove the
       * retry affordance; no retry can succeed.
       */
      kind: 'forbidden';
      message: string;
    }
  | {
      /**
       * The mutation failed because the GitHub authorization is no
       * longer valid. The caller should remove the retry affordance and
       * surface a reconnect CTA that invalidates the gate's auth query.
       */
      kind: 'reconnect';
      message: string;
    };

export function classifyPrReviewMutationError(error: unknown): PrReviewMutationErrorState {
  const code = readTrpcErrorCode(error);
  if (code === 'BAD_REQUEST') {
    return {
      kind: 'bad-request',
      message: error instanceof Error ? error.message : 'Bad request',
    };
  }
  if (code === 'FORBIDDEN') {
    return {
      kind: 'forbidden',
      message: error instanceof Error ? error.message : 'Forbidden',
    };
  }
  if (code === 'PRECONDITION_FAILED' || code === 'UNAUTHORIZED') {
    return {
      kind: 'reconnect',
      message: error instanceof Error ? error.message : 'GitHub connection expired',
    };
  }
  return { kind: 'retryable' };
}
