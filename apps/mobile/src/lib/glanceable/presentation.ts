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

export type GlanceableCountKey =
  | 'glanceable.running'
  | 'glanceable.needsInput'
  | 'glanceable.reconnecting';

export type GlanceableCountLine = { key: GlanceableCountKey; count: number };

/** Rank order: needs-input, then reconnecting, then running. */
const COUNT_ORDER: readonly {
  key: GlanceableCountKey;
  field: 'running' | 'needsInput' | 'reconnecting';
}[] = [
  { key: 'glanceable.needsInput', field: 'needsInput' },
  { key: 'glanceable.reconnecting', field: 'reconnecting' },
  { key: 'glanceable.running', field: 'running' },
];

/** Every non-zero count in rank order (expanded, medium, large, spoken). */
export function glanceableCountLines(snapshot: GlanceableAgentsSnapshot): GlanceableCountLine[] {
  const lines: GlanceableCountLine[] = [];
  for (const { key, field } of COUNT_ORDER) {
    const count = snapshot[field];
    if (count > 0) {
      lines.push({ key, count });
    }
  }
  return lines;
}

/** The single ranked count for compact surfaces; null when nothing is eligible. */
export function primaryGlanceableCount(
  snapshot: GlanceableAgentsSnapshot
): GlanceableCountLine | null {
  return glanceableCountLines(snapshot)[0] ?? null;
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
    for (const { key } of glanceableCountLines(snapshot)) {
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
    for (const { key, count } of glanceableCountLines(snapshot)) {
      parts.push(`${count} ${translate(key)}`);
    }
  }
  parts.push(translate('glanceable.openAgents'));
  return parts.join(', ');
}
