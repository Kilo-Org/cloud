import { getCloudSessionCreationOperation, type CloudSessionCreationOperation } from './types';

export type FirstChatCreationAttempt = CloudSessionCreationOperation & {
  initialMessageId: string;
};

/**
 * Resolve the attempt to submit. A retry of the same intent — the previous
 * request may have reached the server before its response was lost — reuses the
 * operation key and the initial message id, so the server's idempotency sees
 * one operation. A different intent starts a new attempt.
 */
export function resolveFirstChatCreationAttempt(
  current: FirstChatCreationAttempt | null,
  intent: string,
  createOperationKey: () => string,
  createMessageId: () => string
): FirstChatCreationAttempt {
  const operation = getCloudSessionCreationOperation(current, intent, createOperationKey);
  if (current && operation === current) return current;
  return { ...operation, initialMessageId: createMessageId() };
}

export type FirstChatCreationGuard = {
  /** Take the guard. False when a submission is already in flight. */
  tryBegin: () => boolean;
  end: () => void;
};

/**
 * A synchronous single-flight guard. `firstChatCreationOperation` and
 * `pendingCreation` are React state, so two invocations in the same render both
 * read the pre-commit value and would each mint their own operation key. The
 * ref-backed lock refuses the second invocation before either can start.
 */
export function createFirstChatCreationGuard(): FirstChatCreationGuard {
  let inFlight = false;
  return {
    tryBegin: () => {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    end: () => {
      inFlight = false;
    },
  };
}
