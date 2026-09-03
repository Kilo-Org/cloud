import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import {
  type GlanceableCountKind,
  glanceableCountLines,
  glanceableSpokenLabel,
  glanceableStatusCopyKey,
  type GlanceableSurfaceFlags,
  primaryGlanceableCount,
  resolveGlanceableStatus,
} from '@/lib/glanceable/presentation';

/** One translated count line. `kind` picks the glyph and the color. */
type GlanceableCount = { label: string; kind: GlanceableCountKind; count: number };

/**
 * The props every iOS surface renders. The builder below is the only producer,
 * so a title, organization name, account id, or raw session id can never reach
 * the widget extension.
 */
export type GlanceableViewProps = {
  /** Translated locked copy; null while counts show (happy). Stale carries both. */
  statusLine: string | null;
  /** Non-zero count lines in rank order (needs-input, running, idle). */
  countLines: GlanceableCount[];
  /** Top-ranked count label for compact surfaces; null when no eligible work. */
  primaryLabel: string | null;
  /** Top-ranked count state for compact surfaces; null when no eligible work. */
  primaryKind: GlanceableCountKind | null;
  /** Top-ranked count value for compact surfaces; 0 when no eligible work. */
  primaryCount: number;
  /**
   * ISO timestamp of the longest-running needs-input wait, or null when
   * nothing waits. Only the needs-input row carries a duration: a wait is the
   * one interval the user can act on. Only `systemMedium` is wide enough to
   * draw it.
   */
  needsInputSince: string | null;
  /** Spoken label: status word, numeric counts, then Open agents. Never a title or id. */
  accessibilityLabel: string;
};

/** Build the surface props from a snapshot, surface flags, and a translator. */
export function buildGlanceableViewProps(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string
): GlanceableViewProps {
  const statusKey = glanceableStatusCopyKey(snapshot, flags);
  const primary = primaryGlanceableCount(snapshot);
  // Only these two statuses draw rows; the rest draw their status line, so the
  // locked frames carry no count payload at all.
  const status = resolveGlanceableStatus(snapshot, flags);
  const showCounts = status === 'happy' || status === 'stale';

  return {
    statusLine: statusKey === null ? null : translate(statusKey),
    countLines: (showCounts ? glanceableCountLines(snapshot) : []).map(line => ({
      label: translate(line.key),
      kind: line.kind,
      count: line.count,
    })),
    primaryLabel: primary === null ? null : translate(primary.key),
    primaryKind: primary === null ? null : primary.kind,
    primaryCount: primary === null ? 0 : primary.count,
    needsInputSince: showCounts && snapshot.needsInput > 0 ? snapshot.needsInputSince : null,
    accessibilityLabel: glanceableSpokenLabel(snapshot, flags, translate),
  };
}

/**
 * Drop the null fields before a widget write.
 *
 * `updateTimeline` stores the props in the shared `UserDefaults`, which rejects
 * a null value and throws an Objective-C exception out through the host
 * function. An absent key reads back as `undefined`, which every layout already
 * defaults, so omitting the field is the lossless form.
 */
export function toWidgetProps(props: GlanceableViewProps): Partial<GlanceableViewProps> {
  const entries = Object.entries(props).filter(([, value]) => value !== null);
  return Object.fromEntries(entries) as Partial<GlanceableViewProps>;
}

/**
 * Build the Live Activity content-state from a snapshot. The server pushes the
 * same raw shape, so the widget extension's `active-agents-live-activity.tsx`
 * renders it directly with inlined English copy (the server cannot translate).
 */
export function buildGlanceableLiveActivityContentState(
  snapshot: GlanceableAgentsSnapshot
): GlanceableLiveActivityContentState {
  return {
    status: snapshot.status,
    running: snapshot.running,
    needsInput: snapshot.needsInput,
    idle: snapshot.idle,
    needsInputSince: snapshot.needsInputSince,
  };
}
