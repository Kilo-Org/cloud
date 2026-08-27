import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  glanceableCountLines,
  glanceableSpokenLabelKeys,
  glanceableStatusCopyKey,
  type GlanceableSurfaceFlags,
  primaryGlanceableCount,
  resolveGlanceableStatus,
} from '@/lib/glanceable/presentation';

/** One translated count line for an Android surface. */
export type AndroidWidgetCount = { label: string; count: number };

/**
 * The props the Android widget renders. The builder below is the only producer,
 * so a title, organization name, account id, or raw session id can never reach
 * the widget host. Android has no elapsed timer, so there is no elapsed anchor.
 */
export type AndroidWidgetProps = {
  /** Translated locked copy; null while counts show (happy). Stale carries both. */
  statusLine: string | null;
  /** Non-zero count lines in rank order (needs-input, reconnecting, running). */
  countLines: AndroidWidgetCount[];
  /** Top-ranked count label for compact widths; null when no eligible work. */
  primaryLabel: string | null;
  /** Top-ranked count value for compact widths; 0 when no eligible work. */
  primaryCount: number;
  /** Translated "Open agents" affordance. */
  openAgentsLabel: string;
  /** True for happy and stale — the only statuses that show counts. */
  showOpenAgents: boolean;
  /** Spoken label: status words, counts, then Open agents. Never a title or id. */
  accessibilityLabel: string;
};

/** Build the Android widget props from a snapshot, surface flags, and a translator. */
export function buildAndroidWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string
): AndroidWidgetProps {
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
    openAgentsLabel: translate('glanceable.openAgents'),
    showOpenAgents: status === 'happy' || status === 'stale',
    accessibilityLabel: glanceableSpokenLabelKeys(snapshot, flags)
      .map(key => translate(key))
      .join(', '),
  };
}

/** Zero-count expired props: the single future redraw hides counts at expiresAt. */
export function buildExpiredWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string
): AndroidWidgetProps {
  return buildAndroidWidgetProps(
    {
      ...snapshot,
      status: 'expired',
      running: 0,
      needsInput: 0,
      reconnecting: 0,
      eligibleStartedAt: null,
    },
    {},
    translate
  );
}

/** Gallery placeholder: empty copy and no counts, with no snapshot behind it. */
export function buildGenericWidgetProps(translate: (key: string) => string): AndroidWidgetProps {
  const empty = translate('glanceable.empty');
  return {
    statusLine: empty,
    countLines: [],
    primaryLabel: null,
    primaryCount: 0,
    openAgentsLabel: translate('glanceable.openAgents'),
    showOpenAgents: false,
    accessibilityLabel: empty,
  };
}

/**
 * Single-line summary for the ongoing notification: ranked counts for happy and
 * stale, otherwise the locked status copy. Built only from translated keys, so it
 * never leaks a title, organization name, or id.
 */
export function buildOngoingNotificationText(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string
): string {
  const status = resolveGlanceableStatus(snapshot, flags);
  if (status === 'happy' || status === 'stale') {
    const lines = glanceableCountLines(snapshot);
    if (lines.length > 0) {
      return lines.map(line => `${line.count} ${translate(line.key)}`).join(', ');
    }
  }
  return translate(glanceableStatusCopyKey(snapshot, flags) ?? 'glanceable.empty');
}
