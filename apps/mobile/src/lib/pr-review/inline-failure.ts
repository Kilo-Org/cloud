// Inline failures for the composer family (create comment, add-to-review,
// conversation comment, own-comment edit, thread reply). One object carries the
// kind, the copy the surface renders and the channel that announces it, so a
// view can switch on `kind` without a second "is local"/"blocked" flag beside
// it.
//
// Pure apart from the Terms gate: a `terms-required` rejection re-opens the gate
// and reuses its outcome, exactly as the deleted classification effects did.

import { i18n } from '@/i18n';
import { ensureTermsAcceptedOutcome } from '@/components/pr-review/discussion/reply-input';
import { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import {
  isPrOperationAmbiguous,
  isPrOperationPersistenceFailed,
} from '@/lib/pr-review/merge/pr-operation-ledger';
import { mutationErrorDisplay } from '@/lib/pr-review/mutation-error-display';
import { type ProviderPrPlatform } from '@/lib/pr-review/provider-pr-ref';

export type PrInlineAnnounce = 'here' | 'toast' | 'silent';

/** Which validation/gate outcomes this surface announces itself. */
export type PrInlineSurface = 'composer' | 'edit-comment' | 'reply';

/**
 * A composer-family inline failure. `reconnect` carries no copy because
 * `PrReviewReconnectNotice` owns it; every other arm carries the copy it renders
 * and who announces it (`toast` = the mutation hook already did, `silent` = this
 * surface renders it visual-only, as reply always has).
 */
export type PrInlineFailure =
  | { readonly kind: 'reconnect' }
  | {
      readonly kind:
        | 'body-empty'
        | 'not-recorded'
        | 'retryable'
        | 'bad-request'
        | 'forbidden'
        | 'not-found'
        | 'ambiguous';
      readonly message: string;
      readonly announce: PrInlineAnnounce;
    };

export type PrInlineOptions = {
  readonly surface: PrInlineSurface;
  readonly platform?: ProviderPrPlatform;
  /** Channel for mutation-derived failures; the hook's own `onError` toasts them. */
  readonly announce: PrInlineAnnounce;
};

export type PrInlineOutcome =
  | { readonly kind: 'failure'; readonly failure: PrInlineFailure }
  | { readonly kind: 'abandoned' }; // pre-submit gate cancelled: nothing was sent

/** The ledger persistence marker, raised before classification by the ledger-keyed surfaces. */
export function prInlineNotRecordedFailure(announce: PrInlineAnnounce): PrInlineFailure {
  return { kind: 'not-recorded', message: i18n.t('common.actionNotRecorded'), announce };
}

/** The mutation classifications the reply surface words with its own copy. */
type ReplyClassification = {
  readonly kind: 'retryable' | 'bad-request' | 'forbidden' | 'reconnect';
};

function replyFailure(
  classification: ReplyClassification,
  options: PrInlineOptions
): PrInlineFailure {
  if (classification.kind === 'forbidden') {
    const message = options.platform
      ? i18n.t('prReview.discussion.replyForbiddenTerm', {
          term: i18n.t(providerPrNounKey(options.platform)),
        })
      : i18n.t('prReview.discussion.replyForbidden');
    return { kind: 'forbidden', message, announce: options.announce };
  }
  if (classification.kind === 'bad-request') {
    return {
      kind: 'bad-request',
      message: i18n.t('prReview.discussion.replyBadRequest'),
      announce: options.announce,
    };
  }
  if (classification.kind === 'reconnect') {
    return { kind: 'reconnect' };
  }
  // A generic/transient failure shows the specified retryable copy, never the
  // raw provider error, so the inline line and the toast agree.
  return {
    kind: 'retryable',
    message: i18n.t('prReview.operation.couldNotReply'),
    announce: options.announce,
  };
}

/**
 * Classify a rejected PR write into the inline failure to publish. Async only for
 * the `terms-required` branch, which awaits `ensureTermsAcceptedOutcome()`.
 *
 * `reply` keeps the reply surface's own copy (`replyBadRequest`, the provider
 * refusal, `couldNotReply`) so the inline line cannot disagree with the
 * `couldNotReply` toast. Cancelling the gate while recovering a rejected write
 * publishes `termsAcceptRequired`; only a pre-submit cancellation abandons.
 */
export async function classifyPrInlineFailure(
  error: unknown,
  options: PrInlineOptions
): Promise<PrInlineOutcome> {
  // The ledger persistence marker is retry-blocking: the row never became
  // `reconcile_pending`, so the same key must not be retried.
  if (isPrOperationPersistenceFailed(error)) {
    return { kind: 'failure', failure: prInlineNotRecordedFailure(options.announce) };
  }
  // The effect may have committed: tell the user to verify the PR instead of
  // showing the generic retryable copy.
  if (isPrOperationAmbiguous(error)) {
    return {
      kind: 'failure',
      failure: {
        kind: 'ambiguous',
        message: i18n.t('prReview.operation.ambiguous'),
        announce: options.announce,
      },
    };
  }
  const classification = classifyPrReviewMutationError(error);
  if (classification.kind === 'terms-required') {
    const outcome = await ensureTermsAcceptedOutcome();
    if (outcome.kind === 'accepted') {
      return { kind: 'abandoned' };
    }
    if (outcome.kind === 'outdated') {
      return {
        kind: 'failure',
        failure: {
          kind: 'bad-request',
          message: i18n.t('prReview.discussion.termsOutdatedCopy'),
          announce: options.announce,
        },
      };
    }
    if (outcome.kind === 'unknown') {
      return {
        kind: 'failure',
        failure: {
          kind: 'retryable',
          message: i18n.t('prReview.discussion.termsCheckRetryCopy'),
          announce: options.announce,
        },
      };
    }
    // The gate was cancelled while recovering a rejected write: the write still
    // needs acceptance, so the surface says so instead of going quiet.
    return {
      kind: 'failure',
      failure: {
        kind: 'retryable',
        message: i18n.t('prReview.discussion.termsAcceptRequired'),
        announce: options.surface === 'reply' ? 'silent' : 'here',
      },
    };
  }
  if (options.surface === 'reply') {
    return { kind: 'failure', failure: replyFailure(classification, options) };
  }
  const display = mutationErrorDisplay(options.surface, classification, {
    rawError: error,
    platform: options.platform,
  });
  if (display.kind === 'reconnect') {
    return { kind: 'failure', failure: { kind: 'reconnect' } };
  }
  return {
    kind: 'failure',
    failure: { kind: display.kind, message: display.message, announce: options.announce },
  };
}
