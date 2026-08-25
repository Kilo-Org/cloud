// Pure FSM describing the accessibility presentation for a blocking
// question/permission card. The card itself consumes the result and the
// orchestrator (`session-detail-content.tsx`) consumes the announcement to
// route screen-reader focus. Keeping the logic in a module of pure functions
// lets the repo's `node` vitest env cover the selection + CTA rules without
// rendering React Native.

import { type Component, type RefObject } from 'react';

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { readTrpcErrorField } from '@/lib/trpc-error';

import { type BlockingInteraction } from './agent-interaction-policy';

type BlockingCardKind = 'question' | 'permission';

type BlockingCardUiState = 'happy' | 'retryable' | 'non-retryable';

export type BlockingCardRetryAction = 'answer' | 'reject' | 'respond';

export type BlockingCardSubmissionError =
  | { kind: 'retryable'; message: string; action: BlockingCardRetryAction }
  | { kind: 'non-retryable'; message: string };

type BlockingCardPresentation = {
  kind: BlockingCardKind;
  state: BlockingCardUiState;
  /** Short TalkBack/VoiceOver announcement fired once on appearance. */
  announcement: string;
  /** Body text rendered inside the card explaining why input is blocked. */
  protocolExplanation: string;
  /** True when the primary action button (Send / Allow) should render. */
  hasPrimaryCta: boolean;
  /** True when a Retry affordance should render in place of the primary CTA. */
  hasRetryCta: boolean;
  /**
   * When retryable, the action that the retry CTA should re-attempt so the
   * recovery affordance matches the failed submission (e.g. a failed Skip
   * retries skip, not answer).
   */
  retryAction: BlockingCardRetryAction | null;
  /**
   * True for the question card's "Skip" affordance. Hidden when the active
   * retry is for a failed skip so the user sees a single "Retry skip" action.
   * Permission cards never have an independent reject path, so this is always
   * `false` for `kind: 'permission'`.
   */
  hasRejectCta: boolean;
  /** Inline error text to render above the CTA row (null when no error). */
  errorMessage: string | null;
};

export type BlockingCardA11yDeps = {
  announce: (message: string) => void;
  focus: (ref: RefObject<Component | null>) => boolean;
};

/**
 * Resolve the presentation for a blocking interaction card, or `null` when
 * no card is mounted. The function is pure: callers pass the current
 * `blocking` interaction kind and the optional submission error.
 */
export function getBlockingCardPresentation(input: {
  blocking: BlockingInteraction;
  submissionError: BlockingCardSubmissionError | null;
}): BlockingCardPresentation | null {
  if (input.blocking === 'none') {
    return null;
  }
  return getBlockingCardPresentationForKind({
    kind: input.blocking,
    submissionError: input.submissionError,
  });
}

/**
 * Non-null variant for use by the question/permission card components, which
 * only mount when a blocking interaction is active. Keeping this as a
 * separate function lets the strict TS checker see the non-null return
 * without the component having to assert.
 */
export function getBlockingCardPresentationForKind(input: {
  kind: BlockingCardKind;
  submissionError: BlockingCardSubmissionError | null;
}): BlockingCardPresentation {
  const kind = input.kind;
  const { submissionError } = input;

  if (submissionError?.kind === 'non-retryable') {
    return {
      kind,
      state: 'non-retryable',
      announcement: buildAnnouncement(kind, 'non-retryable'),
      protocolExplanation: buildProtocolExplanation(kind, 'non-retryable'),
      hasPrimaryCta: false,
      hasRetryCta: false,
      retryAction: null,
      hasRejectCta: false,
      errorMessage: submissionError.message,
    };
  }

  if (submissionError?.kind === 'retryable') {
    return {
      kind,
      state: 'retryable',
      announcement: buildAnnouncement(kind, 'retryable'),
      protocolExplanation: buildProtocolExplanation(kind, 'retryable'),
      hasPrimaryCta: false,
      hasRetryCta: true,
      retryAction: submissionError.action,
      hasRejectCta: kind === 'question' && submissionError.action !== 'reject',
      errorMessage: submissionError.message,
    };
  }

  return {
    kind,
    state: 'happy',
    announcement: buildAnnouncement(kind, 'happy'),
    protocolExplanation: buildProtocolExplanation(kind, 'happy'),
    hasPrimaryCta: true,
    hasRetryCta: false,
    retryAction: null,
    hasRejectCta: kind === 'question',
    errorMessage: null,
  };
}

/**
 * Side-effect helper invoked from the card's mount effect. Centralises the
 * "announce + move focus" pair here so the React components execute the same
 * path the unit tests cover. If the focus target has no node handle yet
 * (first-paint race), a follow-up attempt is scheduled on the next tick and the
 * cleanup function clears that timeout on unmount/request change.
 */
export function applyBlockingCardAppearance(
  presentation: BlockingCardPresentation,
  ref: RefObject<Component | null>,
  deps: BlockingCardA11yDeps
): (() => void) | undefined {
  deps.announce(presentation.announcement);
  if (!deps.focus(ref)) {
    const handle = setTimeout(() => {
      deps.focus(ref);
    }, 50);
    return () => {
      clearTimeout(handle);
    };
  }
  return undefined;
}

/**
 * Classify a thrown submission failure into a retryable or non-retryable
 * blocking card error. The `action` argument lets callers distinguish a
 * failed answer from a failed skip, so the recovery message and retry CTA
 * match the action the user attempted.
 *
 * Currently only tRPC `NOT_FOUND` is treated as terminal: the session or wrapper
 * is gone, so retrying the same answer/permission cannot succeed. All other
 * tRPC errors (including `INTERNAL_SERVER_ERROR`, `PRECONDITION_FAILED`, and
 * network failures) default to retryable because the backend does not yet
 * expose a distinct terminal signal for a stale question/permission ID.
 */
export function classifyBlockingSubmissionError(
  error: unknown,
  kind: BlockingCardKind,
  action: BlockingCardRetryAction = 'answer'
): BlockingCardSubmissionError {
  const code = readTrpcErrorField(error, 'code');
  if (code === 'NOT_FOUND') {
    return {
      kind: 'non-retryable',
      message:
        kind === 'question'
          ? i18n.t('agentChat.blockingCard.questionUnavailable')
          : i18n.t('agentChat.blockingCard.permissionUnavailable'),
    };
  }
  return {
    kind: 'retryable',
    message: buildRetryableMessage(kind, action),
    action,
  };
}

function buildRetryableMessage(kind: BlockingCardKind, action: BlockingCardRetryAction): string {
  if (kind === 'question') {
    return action === 'reject'
      ? i18n.t('agentChat.blockingCard.failedToSkipQuestion')
      : i18n.t('agentChat.blockingCard.failedToSubmitAnswer');
  }
  return i18n.t('agentChat.blockingCard.failedToRespondToPermission');
}

function buildAnnouncement(kind: BlockingCardKind, state: BlockingCardUiState): string {
  if (state === 'non-retryable') {
    return kind === 'question'
      ? i18n.t('agentChat.blockingCard.questionUnavailable')
      : i18n.t('agentChat.blockingCard.permissionUnavailable');
  }
  if (state === 'retryable') {
    return i18n.t('agentChat.blockingCard.submissionFailed');
  }
  return kind === 'question'
    ? i18n.t('agentChat.blockingCard.questionAnnouncement')
    : i18n.t('agentChat.blockingCard.permissionAnnouncement');
}

/**
 * Card title with a position hint when more than one blocking request waits.
 * The card always renders the oldest pending request, so the position is
 * always 1. `count` is the total of pending questions plus pending
 * permissions, so the user sees every waiting request in one number.
 */
export function formatBlockingCardTitle(baseTitle: string, count: number): string {
  return count > 1
    ? `${baseTitle} ${i18n.t('agentChat.blockingCard.positionHint', {
        count,
        displayCount: formatNumber(count, i18n.language),
      })}`
    : baseTitle;
}

function buildProtocolExplanation(kind: BlockingCardKind, state: BlockingCardUiState): string {
  if (state === 'non-retryable') {
    return i18n.t('agentChat.blockingCard.movedPastPrompt');
  }
  if (kind === 'question') {
    return i18n.t('agentChat.blockingCard.waitingForAnswer');
  }
  return i18n.t('agentChat.blockingCard.waitingForPermission');
}
