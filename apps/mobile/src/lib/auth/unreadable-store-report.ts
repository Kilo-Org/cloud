import * as Sentry from '@sentry/react-native';

/**
 * One Sentry report per store state this build cannot read, per app process.
 *
 * `unreadable` is a read that failed (a locked device, a keychain error) and it
 * clears as soon as a later read succeeds. `unsupported` is a valid payload
 * this build cannot interpret (an unknown store version, or neither known
 * shape) and `corrupt` is a payload that is not valid JSON; both persist until
 * a write replaces the payload - `unsupported` on purpose, for the build that
 * wrote it. Every logout-cleanup transaction and every read-only view reads the
 * store again, so an ungated capture files an identical event per read for one
 * unchanged condition.
 *
 * The claim lives here rather than in the store module so the process-lifetime
 * state and the report it guards stay in one place with nothing else.
 */

/** A store state this build cannot read; each one reports once. */
type UnreadableStoreStatus = 'unreadable' | 'unsupported' | 'corrupt';

const reportedStatuses = new Set<UnreadableStoreStatus>();

/**
 * Forget the process's store reports. A write that repaired or replaced the
 * store calls this, because the next unreadable state is new information
 * rather than a repeat; tests call it so every case starts unclaimed.
 */
export function forgetUnreadableStoreReports(): void {
  reportedStatuses.clear();
}

/**
 * Report one unreadable store state, at most once per process: the first read
 * of a state claims its report and every later read of the same state is
 * silent.
 */
export function reportUnreadableStore(status: UnreadableStoreStatus): void {
  if (reportedStatuses.has(status)) {
    return;
  }
  reportedStatuses.add(status);
  // Report the state, never the payload: it can hold account ids and device
  // tokens.
  Sentry.captureException(new Error('Logout cleanup store is not readable by this build'), {
    tags: {
      'error.subsystem': 'auth',
      'error.operation': 'read_logout_cleanup_store',
      'logout.cleanup.store': status,
    },
  });
}
