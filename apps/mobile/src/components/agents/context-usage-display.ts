import { i18n } from '@/i18n';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { formatSessionCostBadge, formatSessionTotalCost } from './session-list-helpers';
import { formatSpokenCost } from './session-row-accessibility-label';

export type ContextTone = 'primary' | 'warning' | 'destructive' | 'neutral';

const WARNING_TONE_THRESHOLD = 75;
const DESTRUCTIVE_TONE_THRESHOLD = 90;

const INDETERMINATE_ARC_FRACTION = 0.25;

export function formatExactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return '0';
  }
  return formatNumber(Math.trunc(tokens), i18n.language);
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) {
    return formatCurrency(0, i18n.language, 4);
  }
  return formatCurrency(cost, i18n.language, 4);
}

export function getContextTone(percentage: number | undefined): ContextTone {
  if (percentage === undefined || !Number.isFinite(percentage)) {
    return 'neutral';
  }
  if (percentage >= DESTRUCTIVE_TONE_THRESHOLD) {
    return 'destructive';
  }
  if (percentage >= WARNING_TONE_THRESHOLD) {
    return 'warning';
  }
  return 'primary';
}

export function getArcFraction(percentage: number | undefined): number | undefined {
  if (percentage === undefined || !Number.isFinite(percentage)) {
    return undefined;
  }
  if (percentage <= 0) {
    return 0;
  }
  if (percentage >= 100) {
    return 1;
  }
  return percentage / 100;
}

/**
 * Stable partial neutral arc used by the ring when capacity is unknown. Kept
 * pure and exported so the visual is testable without an RN render harness.
 */
export function getIndeterminateArcFraction(): number {
  return INDETERMINATE_ARC_FRACTION;
}

export function getRemainingTokens(info: SessionContextInfo): number | undefined {
  if (info.contextWindow === undefined) {
    return undefined;
  }
  return Math.max(0, info.contextWindow - info.contextTokens);
}

export function formatRemainingTokens(remaining: number): string {
  return formatExactTokens(remaining);
}

export type HeaderPillContent = {
  /** The percentage reading; `null` when the model reports no context window. */
  primary: string | null;
  /**
   * What the percentage slot paints:
   *
   * - `value`: the reading itself.
   * - `reserved`: the slot keeps the reading's layout width and paints nothing.
   *   A session that reported tokens without a context window has no percentage
   *   to show; the ring, the accessibility label and the context sheet carry
   *   that, and the pill keeps the shape it had while the session resolved.
   * - `none`: no percentage slot.
   */
  primarySlot: PillPrimarySlot;
  secondary: string | null;
  /**
   * What the cost slot paints:
   *
   * - `label`: the session's cost, as text.
   * - `loading`: the same dashes, laid out but painted invisible, with one bar
   *   across the row they take. A bar of fixed width matched the settled row
   *   only at the default font scale, and a dash beside a bar read as
   *   half-painted content.
   * - `unreported`: the dash, in the label's width. The session settled without
   *   a cost, so nothing will fill the slot; it keeps the width so the pill does
   *   not shrink when it settles.
   * - `none`: no cost slot at all.
   */
  costSlot: PillCostSlot;
  tone: ContextTone;
  /** `undefined` = indeterminate arc; `0` = track only (no usage asserted). */
  arcFraction: number | undefined;
  interactive: boolean;
  /**
   * Settled without usage: the accessibility label names usage as unavailable.
   * Stays false while the session is still loading.
   */
  usageUnavailable: boolean;
};

type PillCostSlot = 'label' | 'loading' | 'unreported' | 'none';

type PillPrimarySlot = 'value' | 'reserved' | 'none';

/**
 * Width the percentage slot keeps. A session that has not reported usage lays
 * the marker out as a placeholder and paints it; a session that reported tokens
 * without a context window lays it out and paints nothing, because the reading
 * it stands for does not exist yet — and a marker painted there would sit right
 * before the cost and read as a negative amount.
 */
export const UNKNOWN_WINDOW_LABEL = '—';

/**
 * Single selector for the session-detail header pill. Always returns content
 * so the pill can reserve a fixed height before context usage resolves.
 */
export function getHeaderPillContent({
  info,
  totalCostMicrodollars,
  hasMessages,
  loading = false,
}: {
  info: SessionContextInfo | undefined;
  totalCostMicrodollars: number | null;
  hasMessages: boolean;
  loading?: boolean;
}): HeaderPillContent {
  if (info) {
    const tone = getContextTone(info.percentage);
    // The pill reports context usage as a percentage only. While the model's
    // context window is unresolved there is no honest denominator, so the slot
    // is reserved and paints nothing: a marker there would sit right before the
    // cost and read as a negative amount. The sheet still shows the tokens, and
    // the ring paints an indeterminate arc.
    const primary =
      info.percentage === undefined ? null : formatPercent(info.percentage, i18n.language);
    const secondary = formatSessionCostBadge(totalCostMicrodollars);
    return {
      primary,
      primarySlot: primary === null ? 'reserved' : 'value',
      secondary,
      costSlot: secondary !== null ? 'label' : 'none',
      tone,
      arcFraction: getArcFraction(info.percentage),
      interactive: true,
      usageUnavailable: false,
    };
  }

  const costText = hasMessages ? formatSessionCostBadge(totalCostMicrodollars) : null;
  // Nothing has reported usage yet. A settled pill keeps both value slots, each
  // marked with the dash, instead of collapsing to a bare ring: the header then
  // reads as the same pill before and after the transcript resolves, and the
  // slots it showed fill in place. Neither dash stands in for a value that has
  // arrived; while the open resolves they lay out the row the values will take
  // and the pill paints one bar across it.
  if (!hasMessages) {
    return {
      primary: UNKNOWN_WINDOW_LABEL,
      primarySlot: 'value',
      secondary: UNKNOWN_WINDOW_LABEL,
      costSlot: loading ? 'loading' : 'unreported',
      tone: 'neutral',
      arcFraction: 0,
      interactive: false,
      usageUnavailable: !loading,
    };
  }
  // A transcript without usage. The pill keeps the track-only ring, the cost
  // slot and the reserved percentage slot the placeholder showed, so the cost
  // arriving fills the row in place instead of shrinking the pill and moving
  // the title beside it. A value that has not arrived paints nothing.
  return {
    primary: null,
    primarySlot: 'reserved',
    secondary: costText,
    costSlot: costText === null ? 'none' : 'label',
    tone: 'neutral',
    arcFraction: 0,
    interactive: false,
    usageUnavailable: !loading,
  };
}

type ContextSheetContent = {
  usedTokens: string;
  windowTokens: string | null;
  windowUnavailable: boolean;
  windowUnavailableLabel: string;
  capacityKnown: boolean;
  percentage: string | null;
  remainingTokens: string | null;
  remainingPercentage: string | null;
  cost: string | null;
  tone: ContextTone;
};

export function getContextSheetContent(
  info: SessionContextInfo | undefined,
  totalCostMicrodollars: number | null
): ContextSheetContent {
  const tone = getContextTone(info?.percentage);
  const usedTokens = info ? formatExactTokens(info.contextTokens) : '-';
  const cost = formatSessionTotalCost(totalCostMicrodollars);
  if (info?.contextWindow === undefined) {
    return {
      usedTokens,
      windowTokens: null,
      windowUnavailable: true,
      windowUnavailableLabel: i18n.t('agentChat.contextUsage.windowUnavailable'),
      capacityKnown: false,
      percentage: null,
      remainingTokens: null,
      remainingPercentage: null,
      cost,
      tone,
    };
  }
  const realPercentage = info.percentage ?? 0;
  const remaining = getRemainingTokens(info) ?? 0;
  // Remaining share is only meaningful when usage is below the window. At or
  // above 100% the remaining tokens and remaining percentage both clamp to 0;
  // the visible used percentage above stays the real value.
  const remainingPercentage = realPercentage >= 100 ? 0 : Math.max(0, 100 - realPercentage);
  return {
    usedTokens,
    windowTokens: formatExactTokens(info.contextWindow),
    windowUnavailable: false,
    windowUnavailableLabel: i18n.t('agentChat.contextUsage.windowUnavailable'),
    capacityKnown: true,
    percentage: formatPercent(realPercentage, i18n.language),
    remainingTokens: formatExactTokens(remaining),
    remainingPercentage: formatPercent(remainingPercentage, i18n.language),
    cost,
    tone,
  };
}

/**
 * Spoken body for a pill whose usage is unknown. While the session is
 * unresolved the loading placeholder keeps its former spoken shape; once
 * loading has stopped, unknown usage is named as unavailable instead of
 * reading as an empty, unlabeled control.
 */
function getUnknownUsageBody(spoken: string | null, usageUnavailable: boolean): string {
  if (!usageUnavailable) {
    // The loading placeholder speaks only the cost. Its sentence ends the way
    // the catalog closes one, so the tap hint after it stays a separate
    // sentence in a locale that writes no space there.
    return spoken ? i18n.t('agentChat.contextUsage.loadingCostSpoken', { cost: spoken }) : '';
  }
  return i18n.t('agentChat.contextUsage.usageUnavailable', {
    costClause: spokenCostClause(spoken),
  });
}

/**
 * The spoken cost as a connecting clause for the context pill's sentences.
 * Interpolated as `{{costClause}}`, so the catalog places it — and the
 * sentence terminator — where its grammar puts them; the code adds no
 * punctuation of its own. An absent cost contributes nothing.
 */
function spokenCostClause(spoken: string | null): string {
  return spoken === null ? '' : i18n.t('agentChat.contextUsage.costClause', { cost: spoken });
}

export function getMetricsAccessibilityLabel({
  info,
  totalCostMicrodollars,
  interactive,
  usageUnavailable = false,
}: {
  info: SessionContextInfo | undefined;
  totalCostMicrodollars: number | null;
  interactive: boolean;
  usageUnavailable?: boolean;
}): string {
  const spoken = formatSpokenCost(totalCostMicrodollars);
  const tapPart = interactive ? i18n.t('agentChat.contextUsage.tapToViewDetails') : '';

  if (!info) {
    return `${getUnknownUsageBody(spoken, usageUnavailable)}${tapPart}`.trim();
  }

  const costClause = spokenCostClause(spoken);
  const body =
    info.contextWindow === undefined
      ? i18n.t('agentChat.contextUsage.tokensWindowUnavailable', {
          used: formatExactTokens(info.contextTokens),
          costClause,
        })
      : i18n.t('agentChat.contextUsage.tokensUsage', {
          used: formatExactTokens(info.contextTokens),
          window: formatExactTokens(info.contextWindow),
          percentage: formatPercent(info.percentage ?? 0, i18n.language),
          costClause,
        });
  return `${body}${tapPart}`;
}

type SheetMountState =
  | { mounted: false }
  | { mounted: true; visible: boolean; info: SessionContextInfo | undefined };

export type ContextSheetIdentity = {
  sessionId: string;
  providerID?: string;
  modelID?: string;
};

/**
 * Whether an open request still matches the model usage currently reports.
 *
 * An open request recorded before the first usage report carries no model, and
 * must keep matching whatever model usage later names — otherwise the sheet
 * dismisses itself on arrival of the very report it was opened to read. An
 * open request that did record a model stops matching once usage names another.
 */
function isOpenIdentityForModel(
  info: SessionContextInfo | undefined,
  openIdentity: ContextSheetIdentity | null
): boolean {
  const providerID = openIdentity?.providerID;
  const modelID = openIdentity?.modelID;
  if (providerID === undefined || modelID === undefined) {
    return true;
  }
  return providerID === info?.providerID && modelID === info.modelID;
}

/**
 * Controls when the native Modal is mounted and when it is visible. Keeping
 * the sheet mounted after it has been opened lets `visible` transition from
 * true → false for native dismissal. The sheet is the session's own
 * context/permission surface — it always has the session identity and the
 * auto-approve row to show — so an open request mounts it even before usage is
 * reported or permission controls are known to be available. Permission
 * controls belong to the session, not the model reporting the latest usage.
 */
export function getContextSheetMountState(
  info: SessionContextInfo | undefined,
  openIdentity: ContextSheetIdentity | null,
  { sessionId, autoApproveAvailable = false }: { sessionId: string; autoApproveAvailable?: boolean }
): SheetMountState {
  const openedForSession = openIdentity?.sessionId === sessionId;
  if (!info && !autoApproveAvailable && !openedForSession) {
    return { mounted: false };
  }
  const visible =
    openedForSession && (autoApproveAvailable || isOpenIdentityForModel(info, openIdentity));
  return { mounted: true, visible, info };
}
