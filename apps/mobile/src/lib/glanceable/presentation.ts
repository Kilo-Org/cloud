import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

/**
 * Maps the snapshot plus optional surface flags to the locked copy keys, the
 * compact primary count, and the spoken-label shape. Precedence:
 * signed-out, then privacy/lost-org, then the snapshot's own status.
 */

export type GlanceableStatus = GlanceableAgentsSnapshot['status'];

/** Locked copy key per non-happy status. Happy shows counts, not a status line. */
export const GLANCEABLE_STATUS_COPY_KEY = {
  waiting: 'glanceable.waiting',
  empty: 'glanceable.empty',
  stale: 'glanceable.stale',
  expired: 'glanceable.expired',
  signed_out: 'glanceable.signedOut',
  privacy: 'glanceable.privacy',
} as const satisfies Record<Exclude<GlanceableStatus, 'happy'>, string>;

export type GlanceableCountKey = 'glanceable.running' | 'glanceable.needsInput' | 'common.idle';

/** The state a count line stands for. Surfaces map it to a glyph and a color. */
export type GlanceableCountKind = 'needsInput' | 'running' | 'idle';

export type GlanceableCountLine = {
  key: GlanceableCountKey;
  kind: GlanceableCountKind;
  count: number;
};

/**
 * Rank order: what the user must act on, then what is making progress, then
 * what is only connected. Compact surfaces show the first line only, so this
 * ranking decides what a glance says.
 */
const COUNT_ORDER: readonly { key: GlanceableCountKey; kind: GlanceableCountKind }[] = [
  { key: 'glanceable.needsInput', kind: 'needsInput' },
  { key: 'glanceable.running', kind: 'running' },
  { key: 'common.idle', kind: 'idle' },
];

/**
 * All three counts in rank order, zeros included.
 *
 * A zero row still draws: dropping it would move every remaining row as work
 * changes state, and a surface the user only glances at must not reflow. The
 * surfaces show these rows only while some work exists — a snapshot with three
 * zeros carries the `empty` status and draws its status line instead.
 */
export function glanceableCountLines(snapshot: GlanceableAgentsSnapshot): GlanceableCountLine[] {
  return COUNT_ORDER.map(({ key, kind }) => ({ key, kind, count: snapshot[kind] }));
}

/**
 * The single ranked count for compact surfaces; null when nothing is eligible.
 * Zero rows are skipped here: one number on the Dynamic Island must be a
 * number worth showing.
 */
export function primaryGlanceableCount(
  snapshot: GlanceableAgentsSnapshot
): GlanceableCountLine | null {
  return glanceableCountLines(snapshot).find(line => line.count > 0) ?? null;
}

export type GlanceableSurfaceFlags = {
  /** Forced by the auth context when signed out. */
  signedOut?: boolean;
  /** Forced by the org fence when the selected org is no longer in the list. */
  orgInvalid?: boolean;
};

/** Resolve the display status under the surface precedence list. */
export function resolveGlanceableStatus(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags = {}
): GlanceableStatus {
  if (flags.signedOut) {
    return 'signed_out';
  }
  if (flags.orgInvalid) {
    return 'privacy';
  }
  return snapshot.status;
}

/** The top-line copy key for the snapshot, or null for happy (counts only). */
export function glanceableStatusCopyKey(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags = {}
): string | null {
  const status = resolveGlanceableStatus(snapshot, flags);
  return status === 'happy' ? null : GLANCEABLE_STATUS_COPY_KEY[status];
}

/**
 * Ordered spoken-label parts: status words, counts, then Open agents. Never a
 * title, organization name, or id. Each part is a copy key the surface
 * resolves to its translated string.
 */
export function glanceableSpokenLabelKeys(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags = {}
): string[] {
  const status = resolveGlanceableStatus(snapshot, flags);
  const parts: string[] = [];
  if (status === 'happy' || status === 'stale') {
    // Zeros draw on the surfaces to hold the layout still, but "0 Working" is
    // only noise to a screen reader, so the spoken label keeps the real counts.
    for (const { key } of glanceableCountLines(snapshot).filter(line => line.count > 0)) {
      parts.push(key);
    }
  } else {
    parts.push(GLANCEABLE_STATUS_COPY_KEY[status]);
  }
  parts.push('glanceable.openAgents');
  return parts;
}

/** Translated status, numeric counts in rank order, then the Open agents action. */
export function glanceableSpokenLabel(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string
): string {
  const status = resolveGlanceableStatus(snapshot, flags);
  const parts: string[] = [];
  if (status !== 'happy') {
    parts.push(translate(GLANCEABLE_STATUS_COPY_KEY[status]));
  }
  if (status === 'happy' || status === 'stale') {
    for (const { key, count } of glanceableCountLines(snapshot).filter(line => line.count > 0)) {
      parts.push(`${count} ${translate(key)}`);
    }
  }
  parts.push(translate('glanceable.openAgents'));
  return parts.join(', ');
}
