import {
  GLANCEABLE_SNAPSHOT_EXPIRY_MS,
  GLANCEABLE_SNAPSHOT_SCHEMA_VERSION,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { getLastGlanceableSnapshot } from './persist';
import { withStatus } from './publisher';
import { getGlanceableSinks } from './sink-registry';

// Monotonic epoch bumped on every terminal blank (signed-out or privacy). The
// publisher captures it at construction and refuses to emit once it advances,
// so a live cache success after a blank can never republish or restart.
let terminalBlankEpoch = 0;

/** Current terminal-blank epoch; the publisher compares it to its start value. */
export function getTerminalBlankEpoch(): number {
  return terminalBlankEpoch;
}

// The epoch alone only gates publishers that already existed at the blank. A
// confirmed lost org outlives them: a token refresh or a remount builds a new
// publisher that would republish the revoked org's cached counts. This latch
// blocks every publisher until a successful org list confirms membership.
let orgMembershipLost = false;

/** True while a confirmed lost org blocks publication. */
export function isGlanceableOrgLost(): boolean {
  return orgMembershipLost;
}

/**
 * Terminal blanking: signed-out and privacy states are written to every sink
 * (publish) and then every sink ends immediately. The 8 s terminal window is
 * skipped — logout, account switch, org switch, and confirmed lost org must
 * blank at once.
 */

export type GlanceableOrgFenceState = {
  organizationId: string | null;
  orgs: readonly { organizationId: string }[] | undefined;
  isLoading: boolean;
  isError: boolean;
};

export type GlanceableOrgFenceAction = 'privacy' | 'stale' | 'confirmed' | 'none';

/**
 * Pure org-fence decision: lost org only after a successful list misses the
 * selection, `confirmed` only after a successful list holds it. A loading,
 * errored, or absent list is `none` or `stale`, never a confirmation.
 */
export function planOrgFenceAction(state: GlanceableOrgFenceState): GlanceableOrgFenceAction {
  if (state.isLoading) {
    return 'none';
  }
  if (state.isError) {
    return 'stale';
  }
  if (state.orgs === undefined) {
    return 'none';
  }
  if (
    state.organizationId !== null &&
    !state.orgs.some(entry => entry.organizationId === state.organizationId)
  ) {
    return 'privacy';
  }
  return 'confirmed';
}

function buildTerminalSnapshot(status: 'signed_out' | 'privacy'): GlanceableAgentsSnapshot {
  const previous = getLastGlanceableSnapshot();
  const now = Date.now();
  const updatedAt = new Date(now).toISOString();
  return {
    schemaVersion: GLANCEABLE_SNAPSHOT_SCHEMA_VERSION,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt,
    expiresAt: new Date(now + GLANCEABLE_SNAPSHOT_EXPIRY_MS).toISOString(),
    // A terminal scope never matches a real push scope, so a late push for the
    // old account cannot resurrect the old surface.
    scopeKey: `terminal:${status}`,
    organizationBound: false,
    status,
    running: 0,
    needsInput: 0,
    reconnecting: 0,
    eligibleStartedAt: null,
  };
}

function writeTerminalAndEnd(status: 'signed_out' | 'privacy'): void {
  // Arm the publisher gate before any sink writes, so a cache success that
  // lands during this window can never emit for the torn-down session.
  terminalBlankEpoch += 1;
  const snapshot = buildTerminalSnapshot(status);
  const sinks = getGlanceableSinks();
  // Write the snapshot first, then end: the surface shows the terminal copy
  // before the native activity ends.
  for (const sink of sinks) {
    sink.publish(snapshot);
  }
  for (const sink of sinks) {
    sink.endImmediate();
  }
}

/** Blank on logout or direct account switch. */
export function writeSignedOutSnapshotAndEnd(): void {
  writeTerminalAndEnd('signed_out');
}

/** Blank on an intentional org switch. The next org may publish at once. */
export function writePrivacySnapshotAndEnd(): void {
  writeTerminalAndEnd('privacy');
}

/** Blank on a confirmed lost org, and latch publication off until it returns. */
export function writeLostOrgSnapshotAndEnd(): void {
  orgMembershipLost = true;
  writeTerminalAndEnd('privacy');
}

/** A successful org list holds the selection: release the lost-org latch. */
export function confirmGlanceableOrgMembership(): void {
  orgMembershipLost = false;
}

/**
 * Republish the last snapshot as stale until its deadline, then expired. Used
 * by the org fence when the org list errors: stale, not lost-org.
 */
export function republishLastSnapshotStale(): void {
  const previous = getLastGlanceableSnapshot();
  if (previous === null) {
    return;
  }
  // A terminal blank must keep its status: a stale republish would replace the
  // signed-out or privacy copy with "Can't update now".
  if (previous.status === 'signed_out' || previous.status === 'privacy') {
    return;
  }
  const snapshot = withStatus(previous, 'stale', Date.now());
  for (const sink of getGlanceableSinks()) {
    sink.publish(snapshot);
  }
}
