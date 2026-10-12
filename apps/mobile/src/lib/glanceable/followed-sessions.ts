/**
 * What the aggregate surfaces need to know about the sessions this device
 * follows with a session card. `glanceable-ios/session-follow.ts` owns the cards
 * and registers itself here at import. This module imports nothing, so the
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
