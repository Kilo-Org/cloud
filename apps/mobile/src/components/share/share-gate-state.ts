import { type SharePayload } from '@/lib/share-payload';

import { type SharePayloadValidation } from './share-payload-validation';

export type ShareGateState =
  | {
      kind: 'stale-share';
      message: string;
      showNewSession: false;
      showRetry: false;
      showList: false;
    }
  | {
      kind: 'non-retryable-classification';
      message: string;
      showNewSession: false;
      showRetry: false;
      showList: false;
    }
  | {
      kind: 'loading';
      showNewSession: true;
      showRetry: false;
      showList: true;
      listMode: 'skeleton';
    }
  | {
      kind: 'retryable';
      message: string;
      showNewSession: true;
      showRetry: true;
      showList: false;
    }
  | {
      kind: 'empty';
      message: string;
      showNewSession: true;
      showRetry: false;
      showList: false;
    }
  | {
      kind: 'happy';
      showNewSession: true;
      showRetry: false;
      showList: true;
      listMode: 'rows';
    };

export type ShareGateStateInput = {
  shareId: string | undefined;
  payload: SharePayload | null;
  /** null while Task-3 async validation has not settled. */
  validation: SharePayloadValidation | null;
  storedIsError: boolean;
  storedIsSuccess: boolean;
  activeIsError: boolean;
  storedRowCount: number;
  isLoading: boolean;
};

const STALE_MESSAGE = 'This share is no longer available.';
const RETRYABLE_MESSAGE = "Couldn't load your sessions.";
const EMPTY_MESSAGE = 'No sessions yet — start a new one to send this.';

/**
 * New session is only committable once org is loaded and validation settled
 * to `ok`. Pending validation (`null`) and `all-rejected` both disable commit
 * so the user cannot navigate into a dead end.
 */
export function isShareCommitEnabled(input: {
  orgLoaded: boolean;
  validation: SharePayloadValidation | null;
}): boolean {
  return input.orgLoaded && input.validation?.kind === 'ok';
}

/**
 * Pure selector for the share gate's terminal/loading states.
 *
 * Priority:
 *   1. stale-share (missing/unknown/consumed shareId) — before any validation
 *   2. non-retryable-classification (all files rejected, no usable text)
 *   3. loading (validation or destination queries in flight)
 *   4. retryable (storedIsError with zero stored rows — never activeIsError alone)
 *   5. empty (settled, not errored, zero destinations)
 *   6. happy
 */
export function selectShareGateState(input: ShareGateStateInput): ShareGateState {
  const shareId = input.shareId?.trim() ?? '';
  if (shareId === '' || input.payload === null) {
    return {
      kind: 'stale-share',
      message: STALE_MESSAGE,
      showNewSession: false,
      showRetry: false,
      showList: false,
    };
  }

  if (input.validation?.kind === 'all-rejected') {
    return {
      kind: 'non-retryable-classification',
      message: input.validation.message,
      showNewSession: false,
      showRetry: false,
      showList: false,
    };
  }

  const validationPending = input.validation === null;
  const destinationsPending = input.isLoading || (!input.storedIsSuccess && !input.storedIsError);

  if (validationPending || destinationsPending) {
    return {
      kind: 'loading',
      showNewSession: true,
      showRetry: false,
      showList: true,
      listMode: 'skeleton',
    };
  }

  // Retryable only when the stored list failed with no rows. activeIsError
  // alone is indistinguishable from "nothing live" (list swallows failures).
  if (input.storedIsError && input.storedRowCount === 0) {
    return {
      kind: 'retryable',
      message: RETRYABLE_MESSAGE,
      showNewSession: true,
      showRetry: true,
      showList: false,
    };
  }

  if (input.storedRowCount === 0) {
    return {
      kind: 'empty',
      message: EMPTY_MESSAGE,
      showNewSession: true,
      showRetry: false,
      showList: false,
    };
  }

  return {
    kind: 'happy',
    showNewSession: true,
    showRetry: false,
    showList: true,
    listMode: 'rows',
  };
}
