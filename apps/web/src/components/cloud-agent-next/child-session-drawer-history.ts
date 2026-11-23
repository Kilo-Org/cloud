import type {
  ChildSessionHydrationState,
  SessionSnapshotFailureKind,
} from '@kilocode/cloud-agent-sdk';

type ChildDrawerHistoryFailureState = Extract<ChildSessionHydrationState, { status: 'error' }>;

type ChildDrawerHistoryFailure = {
  /** Copy shown under the banner title, in place of the raw failure text. */
  message: string;
  /** True when reading the same page again can recover. */
  canRetry: boolean;
};

const TERMINAL_FAILURE_MESSAGES = {
  too_large: "This sub-agent's history is too large to load.",
  invalid_data: "This sub-agent's history isn't available.",
} satisfies Record<Exclude<SessionSnapshotFailureKind, 'retryable_failure'>, string>;

/**
 * Decide the copy and the retry affordance for a sub-agent hydration failure.
 * The terminal kinds describe a page a retry re-reads unchanged, so they show
 * fixed copy and no retry. A retryable failure or a null kind keeps the stored
 * message and its retry.
 */
export function describeChildDrawerHistoryFailure(
  state: ChildDrawerHistoryFailureState
): ChildDrawerHistoryFailure {
  if (state.kind === 'too_large' || state.kind === 'invalid_data') {
    return { message: TERMINAL_FAILURE_MESSAGES[state.kind], canRetry: false };
  }
  return { message: state.message, canRetry: true };
}
