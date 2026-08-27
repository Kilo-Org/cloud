import {
  type GlanceableAgentsSnapshot,
  isEligibleGlanceableWork,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import {
  glanceableCountLines,
  glanceableSpokenLabel,
  glanceableStatusCopyKey,
  type GlanceableSurfaceFlags,
  primaryGlanceableCount,
  resolveGlanceableStatus,
} from '@/lib/glanceable/presentation';

/** One translated count line. */
type GlanceableCount = { label: string; count: number };

/**
 * The props every iOS surface renders. The builder below is the only producer,
 * so a title, organization name, account id, or raw session id can never reach
 * the widget extension.
 */
export type GlanceableViewProps = {
  /** Translated locked copy; null while counts show (happy). Stale carries both. */
  statusLine: string | null;
  /** Non-zero count lines in rank order (needs-input, reconnecting, running). */
  countLines: GlanceableCount[];
  /** Top-ranked count label for compact surfaces; null when no eligible work. */
  primaryLabel: string | null;
  /** Top-ranked count value for compact surfaces; 0 when no eligible work. */
  primaryCount: number;
  /** ISO anchor for the elapsed timer; shows while eligible work runs, incl. stale. */
  elapsedAnchor: string | null;
  /** Translated "Open agents" affordance. */
  openAgentsLabel: string;
  /** True for happy and stale — the only statuses that show counts. */
  showOpenAgents: boolean;
  /** Spoken label: status word, numeric counts, then Open agents. Never a title or id. */
  accessibilityLabel: string;
};

/** Build the surface props from a snapshot, surface flags, and a translator. */
export function buildGlanceableViewProps(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string
): GlanceableViewProps {
  const status = resolveGlanceableStatus(snapshot, flags);
  const statusKey = glanceableStatusCopyKey(snapshot, flags);
  const primary = primaryGlanceableCount(snapshot);

  return {
    statusLine: statusKey === null ? null : translate(statusKey),
    countLines: glanceableCountLines(snapshot).map(line => ({
      label: translate(line.key),
      count: line.count,
    })),
    primaryLabel: primary === null ? null : translate(primary.key),
    primaryCount: primary === null ? 0 : primary.count,
    elapsedAnchor: isEligibleGlanceableWork(snapshot) ? snapshot.eligibleStartedAt : null,
    openAgentsLabel: translate('glanceable.openAgents'),
    showOpenAgents: status === 'happy' || status === 'stale',
    accessibilityLabel: glanceableSpokenLabel(snapshot, flags, translate),
  };
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
    reconnecting: snapshot.reconnecting,
    eligibleStartedAt: snapshot.eligibleStartedAt,
  };
}
