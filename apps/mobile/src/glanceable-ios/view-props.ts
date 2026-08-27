import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  glanceableCountLines,
  glanceableSpokenLabelKeys,
  glanceableStatusCopyKey,
  type GlanceableSurfaceFlags,
  primaryGlanceableCount,
  resolveGlanceableStatus,
} from '@/lib/glanceable/presentation';

/** One translated count line. */
export type GlanceableCount = { label: string; count: number };

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
  /** ISO anchor for the elapsed timer; only happy with eligible work. */
  elapsedAnchor: string | null;
  /** Translated "Open agents" affordance. */
  openAgentsLabel: string;
  /** True for happy and stale — the only statuses that show counts. */
  showOpenAgents: boolean;
  /** Spoken label: status words, counts, then Open agents. Never a title or id. */
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
    elapsedAnchor: status === 'happy' ? snapshot.eligibleStartedAt : null,
    openAgentsLabel: translate('glanceable.openAgents'),
    showOpenAgents: status === 'happy' || status === 'stale',
    accessibilityLabel: glanceableSpokenLabelKeys(snapshot, flags)
      .map(key => translate(key))
      .join(', '),
  };
}
