import * as Sentry from '@sentry/react-native';

/**
 * One Sentry report per unreadable logout-cleanup store state per app process.
 *
 * Both state kinds persist until a write replaces the payload: `corrupt` until
 * the next write repairs it, `unreadable` (an unknown store version) on
 * purpose, for the build that wrote it. Every logout-cleanup transaction and
 * every read-only view reads the store again, so an ungated capture files an
 * identical event per read for one unchanged condition.
 *
 * The claim lives here rather than in the store module so the process-lifetime
 * state and the report it guards stay in one place with nothing else.
 */

/** A store state this build cannot interpret; each one reports once. */
type UnreadableStoreStatus = 'unreadable' | 'corrupt';

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
