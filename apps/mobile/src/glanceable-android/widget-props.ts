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
type AndroidWidgetCount = {
  label: string;
  kind: GlanceableCountKind;
  count: string;
};

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
 * Format a timestamp as the active language's relative time.
 *
 * Injected the same way as `formatCount` and for the same reason: this module
 * stays free of i18n and of `Intl`, so its tests need no language bootstrap and
 * the app passes `formatGlanceableAgo`.
 */
export type GlanceableAgoFormat = (at: string) => string;

/**
 * The props the Android widget renders. The builder below is the only producer,
 * so a title, organization name, account id, or raw session id can never reach
 * the widget host. The newest-result label is a translated state word, not a
 * session title. Android has no elapsed timer, so there is no elapsed anchor.
 */
export type AndroidWidgetProps = {
  /**
   * Translated locked copy, drawn only when no counts are. Stale carries both,
   * and the widget then draws the counts; the ongoing notification is the one
   * surface that says the counts are delayed.
   */
  statusLine: string | null;
  /** Every count line in rank order (needs-input, running, idle), zeros included. */
  countLines: AndroidWidgetCount[];
  /** Top-ranked count label; the only row that keeps the foreground color. */
  primaryLabel: string | null;
  /** Kind of the most recent state change; null when no row carried a timestamp. */
  newestResultKind: GlanceableCountKind | null;
  /**
   * Caption of the newest-result footer. Null while no counts show: a locked
   * frame carries one fact, and the caption is the third fact's.
   */
  newestResultTitle: string | null;
  /** The kind label read from `countLines`, never a second spelling of the word. */
  newestResultLabel: string | null;
  /** Preformatted relative time of that change, from the injected formatter. */
  newestResultAgo: string | null;
  /** Spoken label: status words, counts, then Open agents. Never a title or id. */
  accessibilityLabel: string;
};

/** Build the Android widget props from a snapshot, surface flags, and a translator. */
// eslint-disable-next-line max-params -- snapshot, flags, the translator, and the two injected formatters
export function buildAndroidWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  flags: GlanceableSurfaceFlags,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat,
  formatAgo: GlanceableAgoFormat
): AndroidWidgetProps {
  const status = resolveGlanceableStatus(snapshot, flags);
  const statusKey = glanceableStatusCopyKey(snapshot, flags);
  const showCounts = status === 'happy' || status === 'stale';
  const primary = showCounts ? primaryGlanceableCount(snapshot) : null;
  const countLines = (showCounts ? glanceableCountLines(snapshot) : []).map(line => ({
    label: translate(line.key),
    kind: line.kind,
    count: formatCount(line.count),
  }));
  // The three facts locked frames must not carry: with no counts there is no
  // newest result either, so a waiting or privacy-blanked widget keeps one fact.
  const newestKind = showCounts ? snapshot.newestResultKind : null;
  const newestAt = showCounts ? snapshot.newestResultAt : null;

  return {
    statusLine: statusKey === null ? null : translate(statusKey),
    countLines,
    primaryLabel: primary === null ? null : translate(primary.key),
    newestResultKind: newestKind,
    newestResultTitle: showCounts ? translate('glanceable.newestResult') : null,
    newestResultLabel:
      newestKind === null
        ? null
        : (countLines.find(line => line.kind === newestKind)?.label ?? null),
    newestResultAgo: newestKind === null || newestAt === null ? null : formatAgo(newestAt),
    accessibilityLabel: glanceableSpokenLabel(snapshot, flags, translate),
  };
}

/** Every redraw checks the data deadline, including a task queued by an older alarm. */
// eslint-disable-next-line max-params -- snapshot, the translator, and the two injected formatters
export function buildCurrentWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat,
  formatAgo: GlanceableAgoFormat
): AndroidWidgetProps {
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (
    (snapshot.status === 'happy' || snapshot.status === 'stale') &&
    (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
  ) {
    return buildExpiredWidgetProps(snapshot, translate, formatCount, formatAgo);
  }
  return buildAndroidWidgetProps(snapshot, {}, translate, formatCount, formatAgo);
}

/** Zero-count expired props: the single future redraw hides counts at expiresAt. */
// eslint-disable-next-line max-params -- snapshot, the translator, and the two injected formatters
function buildExpiredWidgetProps(
  snapshot: GlanceableAgentsSnapshot,
  translate: (key: string) => string,
  formatCount: GlanceableCountFormat,
  formatAgo: GlanceableAgoFormat
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
    formatCount,
    formatAgo
  );
}

/** Gallery placeholder: empty copy and no counts, with no snapshot behind it. */
export function buildGenericWidgetProps(translate: (key: string) => string): AndroidWidgetProps {
  const empty = translate('glanceable.empty');
  return {
    statusLine: empty,
    countLines: [],
    primaryLabel: null,
    newestResultKind: null,
    newestResultTitle: null,
    newestResultLabel: null,
    newestResultAgo: null,
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
