/**
 * Per-surface values the versioned glanceable snapshot must never carry.
 *
 * The snapshot contract is privacy-minimal — it forbids a session title
 * (`packages/app-shared/src/glanceable-agents-snapshot.ts`, asserted in its
 * test) — so the newest session's title and the in-flight action feedback live
 * beside the snapshot instead of inside it. A module-level value rather than a
 * new `GlanceableSink` argument, so the sink interface stays unchanged and
 * every platform surface reads the same value.
 *
 * The widget redraws (a placed-widget task) and the publisher both run in this
 * process, so the value set on the last tray update is the one the next
 * headless render reads. It is never persisted: a fresh process renders the
 * snapshot's counts without the title until the next tray update.
 */

/**
 * Copy key (not text) for what the widget says while one of the two in-place
 * actions (`approve`, `new-agent`) runs or after it failed. Resolved by the
 * widget props builder, which owns the translated copy.
 */
export type GlanceableActionFeedback =
  | 'approving'
  | 'starting'
  | 'couldNotApprove'
  | 'couldNotStart'
  | null;

export type GlanceableSurfaceExtras = {
  /** Newest active session's title, or null when the tray holds no session. */
  newestSessionTitle: string | null;
  /** Widget action progress/failure, or null when no action is in flight. */
  actionFeedback: GlanceableActionFeedback;
};

const EMPTY: GlanceableSurfaceExtras = {
  newestSessionTitle: null,
  actionFeedback: null,
};

let extras: GlanceableSurfaceExtras = EMPTY;

/** Replace the extras. Callers pass every field, so a stale one can never survive. */
export function setSurfaceExtras(next: GlanceableSurfaceExtras): void {
  extras = next;
}

export function getSurfaceExtras(): GlanceableSurfaceExtras {
  return extras;
}
