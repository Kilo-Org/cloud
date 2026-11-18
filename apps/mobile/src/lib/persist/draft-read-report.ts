import * as Sentry from '@sentry/react-native';

/**
 * One Sentry report per stored draft per app process for a value that is valid
 * JSON but fails the caller's shape validator.
 *
 * Such a value is not corrupt: another build of the app can read it, so it may
 * be that build's draft (a downgrade, or a field this build has not learned
 * yet) and removing it would discard the user's text for good. It therefore
 * stays stored, and every composer mount (`useFencedDraftLoad`) reads it again;
 * the claim is what keeps one unchanged value from filing an event per mount.
 *
 * The claim is keyed by storage scope and entity key. A write that replaces the
 * value, an eviction, or an explicit clear releases it, because the next
 * mismatch on that key is new information rather than a repeat.
 */

const reportedShapeMismatches = new Set<string>();

function claimKey(scope: string, entityKey: string): string {
  return `${scope}\u0000${entityKey}`;
}

/** Reports one shape-mismatched draft, at most once per process per key. */
export function reportShapeMismatch(scope: string, entityKey: string): void {
  const key = claimKey(scope, entityKey);
  if (reportedShapeMismatches.has(key)) {
    return;
  }
  reportedShapeMismatches.add(key);
  Sentry.captureException(new Error('stored draft does not match its expected shape'), {
    level: 'warning',
    tags: { 'error.subsystem': 'drafts', 'error.operation': 'read' },
    fingerprint: ['draft-read-shape-mismatch'],
  });
}

/** Releases a key's claim after its stored value was replaced or removed. */
export function forgetShapeMismatch(scope: string, entityKey: string): void {
  reportedShapeMismatches.delete(claimKey(scope, entityKey));
}

// Test-only: forgets every claim so each case starts unclaimed (the same
// pattern as `forgetUnreadableStoreReports`).
export function forgetShapeMismatchesForTests(): void {
  reportedShapeMismatches.clear();
}
