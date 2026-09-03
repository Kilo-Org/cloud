import { type GlanceableAgentsSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  type GlanceableCountKind,
  glanceableCountLines,
  glanceableSpokenLabel,
  glanceableStatusCopyKey,
  type GlanceableSurfaceFlags,
  primaryGlanceableCount,
  resolveGlanceableStatus,
} from '@/lib/glanceable/presentation';

/** One translated count line for an Android surface. `kind` picks dot and color. */
type AndroidWidgetCount = { label: string; kind: GlanceableCountKind; count: string };

/**
 * Format a count in the active language's own digits.
 *
 * The default writes them the way `String` does, which is what the 80 languages
 * with Latin default digits need; the app injects an `Intl` formatter so fa, ps,
 * ckb, my, ne, bn, and mr read in their own numerals. Injected rather than
 * imported so this module stays free of i18n and of React Native.
 */
export type GlanceableCountFormat = (value: number) => string;

/**
 * The props the Android widget renders. The builder below is the only producer,
 * so a title, organization name, account id, or raw session id can never reach
 * the widget host. Android has no elapsed timer, so there is no elapsed anchor.
 */
export type AndroidWidgetProps = {
  /** Translated locked copy; null while counts show (happy). Stale carries both. */
  statusLine: string | null;
  /** Non-zero count lines in rank order (needs-input, running, idle). */
  countLines: AndroidWidgetCount[];
  /** Top-ranked count label for compact widths; null when no eligible work. */
  primaryLabel: string | null;
  /** Top-ranked count state for compact widths; null when no eligible work. */
  primaryKind: GlanceableCountKind | null;
  /** Top-ranked count value for compact widths; formatted "0" when none. */
  primaryCount: string;
  /** Translated "Open agents" affordance. */
  openAgentsLabel: string;
  /** True for happy and stale — the only statuses that show counts. */
  showOpenAgents: boolean;
  /** Spoken label: status words, counts, then Open agents. Never a title or id. */
  accessibilityLabel: string;
};

/** Build the Android widget props from a snapshot, surface flags, and a translator. */
// eslint-disable-next-line max-params -- snapshot, flags, and the two injected formatters
export function buildAndroidWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat = String
): AndroidWidgetProps {
  const status = resolveGlanceableStatus(snapshot, flags);
  const statusKey = glanceableStatusCopyKey(snapshot, flags);
  const showCounts = status === 'happy' || status === 'stale';
  const primary = showCounts ? primaryGlanceableCount(snapshot) : null;

  return {
    statusLine: statusKey === null ? null : translate(statusKey),
    countLines: (showCounts ? glanceableCountLines(snapshot) : []).map(line => ({
      label: translate(line.key),
      kind: line.kind,
      count: formatCount(line.count),
    })),
    primaryLabel: primary === null ? null : translate(primary.key),
    primaryKind: primary === null ? null : primary.kind,
    primaryCount: formatCount(primary === null ? 0 : primary.count),
    openAgentsLabel: translate('glanceable.openAgents'),
    showOpenAgents: showCounts,
    accessibilityLabel: glanceableSpokenLabel(snapshot, flags, translate),
  };
}

/** Every redraw checks the data deadline, including a task queued by an older alarm. */
export function buildCurrentWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat = String
): AndroidWidgetProps {
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (
    (snapshot.status === 'happy' || snapshot.status === 'stale') &&
    (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
  ) {
    return buildExpiredWidgetProps(snapshot, translate, formatCount);
  }
  return buildAndroidWidgetProps(snapshot, {}, translate, formatCount);
}

/** Zero-count expired props: the single future redraw hides counts at expiresAt. */
function buildExpiredWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat
): AndroidWidgetProps {
  return buildAndroidWidgetProps(
    {
      ...snapshot,
      status: 'expired',
      running: 0,
      needsInput: 0,
      idle: 0,
      needsInputSince: null,
    },
    {},
    translate,
    formatCount
  );
}

/** Gallery placeholder: empty copy and no counts, with no snapshot behind it. */
export function buildGenericWidgetProps(
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat = String
): AndroidWidgetProps {
  const empty = translate('glanceable.empty');
  return {
    statusLine: empty,
    countLines: [],
    primaryLabel: null,
    primaryKind: null,
    primaryCount: formatCount(0),
    openAgentsLabel: translate('glanceable.openAgents'),
    showOpenAgents: false,
    accessibilityLabel: empty,
  };
}

/**
 * Ongoing notification: every ranked count, with a warning when stale, otherwise
 * the locked status copy. Never a title, organization name, or id.
 */
// eslint-disable-next-line max-params -- snapshot, flags, and the two injected formatters
export function buildOngoingNotificationText(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat = String
): string {
  const status = resolveGlanceableStatus(snapshot, flags);
  if (status === 'happy' || status === 'stale') {
    // A sentence, not a layout: a zero row holds a widget's rows still, but
    // "0 Working" in a notification line is only noise.
    const lines = glanceableCountLines(snapshot).filter(line => line.count > 0);
    if (lines.length > 0) {
      const counts = lines
        .map(line => `${formatCount(line.count)} ${translate(line.key)}`)
        .join(', ');
      return status === 'stale' ? `${translate('glanceable.stale')}, ${counts}` : counts;
    }
  }
  return translate(glanceableStatusCopyKey(snapshot, flags) ?? 'glanceable.empty');
}

/** The promoted chip shows only the primary number; the full text keeps all labels. */
export function buildCompactNotificationText(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  formatCount: GlanceableCountFormat = String
): string | null {
  const status = resolveGlanceableStatus(snapshot, flags);
  if (status !== 'happy' && status !== 'stale') {
    return null;
  }
  const primary = primaryGlanceableCount(snapshot);
  return primary === null ? null : formatCount(primary.count);
}
