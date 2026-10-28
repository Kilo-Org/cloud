import { type GlanceableSessionRow } from '@kilocode/app-shared/glanceable-agents-snapshot';

/**
 * What the aggregate surfaces need to know about the sessions this device
 * follows with a session card. `glanceable-ios/session-follow.ts` owns the cards
 * and registers itself here at import. This module imports only types, so the
 * publisher's and the aggregate sink's test graphs stay free of ActivityKit and
 * the token graph, and Android (which follows nothing) reads the empty default.
 */

/** Live followed cards by status kind; `needsApproval` counts permission waits. */
export type FollowedSessionCounts = {
  running: number;
  needsInput: number;
  needsApproval: number;
  idle: number;
  scheduled: number;
};

export type FollowedSessionsSource = {
  ids(): Iterable<string>;
  counts(): FollowedSessionCounts;
};

const EMPTY_SOURCE: FollowedSessionsSource = {
  ids: () => [],
  counts: () => ({ running: 0, needsInput: 0, needsApproval: 0, idle: 0, scheduled: 0 }),
};

let source: FollowedSessionsSource = EMPTY_SOURCE;

export function setFollowedSessionsSource(next: FollowedSessionsSource | null): void {
  source = next ?? EMPTY_SOURCE;
}

export function getFollowedSessionIds(): ReadonlySet<string> {
  return new Set(source.ids());
}

export function getFollowedSessionCounts(): FollowedSessionCounts {
  return source.counts();
}

/** One tray row the aggregate card can leave out by session id. */
export type FollowableSessionRow = GlanceableSessionRow & { id?: string };

let snapshotRows: { scopeKey: string; rows: readonly FollowableSessionRow[] } | null = null;

/**
 * Keep the tray rows the publisher built its last snapshot from, so the
 * aggregate card can rebuild its times from the sessions it still counts.
 */
export function rememberSnapshotRows(
  scopeKey: string,
  rows: readonly FollowableSessionRow[]
): void {
  snapshotRows = { scopeKey, rows };
}

/** The remembered rows of a scope, or null when none were kept for it. */
export function getSnapshotRows(scopeKey: string): readonly FollowableSessionRow[] | null {
  return snapshotRows?.scopeKey === scopeKey ? snapshotRows.rows : null;
}
