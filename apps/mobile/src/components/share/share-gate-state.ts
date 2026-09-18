import { i18n } from '@/i18n';
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
  /** Live destination rows the gate can offer (see `selectShareDestinations`). */
  liveRowCount: number;
  /** Stored sessions loaded for this context, live or not. */
  storedSessionCount: number;
  isLoading: boolean;
};

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
 *   4. retryable (no live rows and the query that decides liveness failed)
 *   5. empty (settled, zero live rows) — live-aware copy when stored sessions
 *      exist but none are live, `share.emptyMessage` only when there are none
 *   6. happy
 */
export function selectShareGateState(input: ShareGateStateInput): ShareGateState {
  const shareId = input.shareId?.trim() ?? '';
  if (shareId === '' || input.payload === null) {
    return {
      kind: 'stale-share',
      message: i18n.t('share.staleMessage'),
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

  // Retryable when nothing live can be offered and a query that decides
  // liveness failed. The stored list blocks the list on its own; a live-lookup
  // failure with no live rows is indistinguishable from "nothing live", so it
  // must offer a retry instead of a settled empty state. Retry refetches both
  // queries (`useAgentSessions().refetch`), matching the Agents list.
  const livenessUnknown = input.storedIsError || input.activeIsError;
  if (input.liveRowCount === 0 && livenessUnknown) {
    return {
      kind: 'retryable',
      message: i18n.t('share.retryableMessage'),
      showNewSession: true,
      showRetry: true,
      showList: false,
    };
  }

  if (input.liveRowCount === 0) {
    return {
      kind: 'empty',
      // Sessions that exist but are offline are not "no sessions": use the
      // app's live-empty copy, and only claim there are none when the stored
      // page really is empty.
      message:
        input.storedSessionCount > 0 ? i18n.t('home.noLiveSessions') : i18n.t('share.emptyMessage'),
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
