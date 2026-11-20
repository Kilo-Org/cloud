import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type TOptions } from 'i18next';

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

type GlanceableCountKey =
  | 'common.working'
  | 'glanceable.needsInput'
  | 'common.idle'
  | 'common.scheduled';

/** The state a count line stands for. Surfaces map it to a glyph and a color. */
export type GlanceableCountKind = 'needsInput' | 'running' | 'idle' | 'scheduled';

export type GlanceableCountLine = {
  key: GlanceableCountKey;
  kind: GlanceableCountKind;
  count: number;
};

/**
 * The translator a glanceable surface passes in. Type-only: this module stays
 * free of the i18n runtime, so the shared policy can run in a test, a headless
 * widget task, or the iOS extension without loading a catalog.
 */
export type GlanceableTranslate = (key: string, options?: TOptions) => string;

/** The language's formatting of a count, injected so no formatter is imported here. */
export type GlanceableCountFormat = (value: number) => string;

/**
 * The count's noun, in the form its own number selects. No placeholder: the
 * split layouts draw the number and its noun as two separately styled text
 * nodes — the hero's numeral beside its label — where a whole sentence cannot
 * be one string, and each node still has to agree with the other.
 *
 * The Android Home widget and its notification read these. The iOS widget
 * layouts still draw the uninflected noun: its native store rebuilds every
 * count label from a kind-to-copy map (`HomeWidgetRefreshStore.swift`), so a
 * plural-selected label chosen here would not survive the write. The
 * cross-platform props therefore keep `translate(key)` for the count labels
 * until that native map carries a form per number.
 */
export const GLANCEABLE_COUNT_NOUN_KEY = {
  needsInput: 'glanceable.countNoun.needsInput',
  running: 'glanceable.countNoun.running',
  scheduled: 'glanceable.countNoun.scheduled',
  idle: 'glanceable.countNoun.idle',
} as const satisfies Record<GlanceableCountKind, string>;

/**
 * The whole count line, number included. The surfaces that draw one string —
 * the ongoing notification, the spoken label — read this instead of pasting a
 * formatted number onto a verb, so the catalog owns the word order and the
 * agreement.
 */
export const GLANCEABLE_COUNT_MESSAGE_KEY = {
  needsInput: 'glanceable.count.needsInput',
  running: 'glanceable.count.running',
  scheduled: 'glanceable.count.scheduled',
  idle: 'glanceable.count.idle',
} as const satisfies Record<GlanceableCountKind, string>;

/** The count's noun for `kind`, translated in `count`'s plural form. */
export function glanceableCountNoun(
  kind: GlanceableCountKind,
  count: number,
  t: GlanceableTranslate
): string {
  return t(GLANCEABLE_COUNT_NOUN_KEY[kind], { count });
}

/**
 * The whole count line for `kind`: `formatCount`'s rendering of the number in
 * the message's `{{displayCount}}`, with the plural form selected from `count`.
 */
// eslint-disable-next-line max-params -- kind, count, the injected number formatter and the translator are the four facts a count line is made of
export function glanceableCountMessage(
  kind: GlanceableCountKind,
  count: number,
  formatCount: GlanceableCountFormat,
  t: GlanceableTranslate
): string {
  return t(GLANCEABLE_COUNT_MESSAGE_KEY[kind], {
    count,
    displayCount: formatCount(count),
  });
}

/**
 * Rank order: what the user must act on, then what is making progress, then
 * what will wake later, then what is only connected. Compact surfaces show the
 * first line only, so this ranking decides what a glance says.
 */
const COUNT_ORDER: readonly { key: GlanceableCountKey; kind: GlanceableCountKind }[] = [
  { key: 'glanceable.needsInput', kind: 'needsInput' },
  { key: 'common.working', kind: 'running' },
  { key: 'common.scheduled', kind: 'scheduled' },
  { key: 'common.idle', kind: 'idle' },
];

/**
 * All four counts in rank order, zeros included.
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

/**
 * The soonest wake a surface renders, or null when nothing is scheduled.
 * A scheduled count with no usable wake time is representable, so a surface
 * that draws a time reads this rather than `snapshot.scheduledAt` directly.
 */
export function glanceableScheduledAt(snapshot: GlanceableAgentsSnapshot): string | null {
  return snapshot.scheduled > 0 ? snapshot.scheduledAt : null;
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
