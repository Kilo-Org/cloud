import { i18n } from '@/i18n';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { formatSessionTotalCost } from './session-list-helpers';
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
  primary: string | null;
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

/**
 * Value-slot placeholder of a session that has not reported usage yet. It marks
 * the slot as unfilled instead of standing in for a number: the pill keeps its
 * two slots while the session resolves, so a settled pill fills the slots it
 * already showed rather than growing a value out of a bare ring.
 */
const UNKNOWN_WINDOW_LABEL = '—';

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
    // keeps the dash instead of a token count; the sheet still shows the tokens.
    const primary =
      info.percentage === undefined
        ? UNKNOWN_WINDOW_LABEL
        : formatPercent(info.percentage, i18n.language);
    const secondary = formatSessionTotalCost(totalCostMicrodollars);
    return {
      primary,
      secondary,
      costSlot: secondary !== null ? 'label' : 'none',
      tone,
      arcFraction: getArcFraction(info.percentage),
      interactive: true,
      usageUnavailable: false,
    };
  }

  const costText = hasMessages ? formatSessionTotalCost(totalCostMicrodollars) : null;
  // Nothing has reported usage yet. A settled pill keeps both value slots, each
  // marked with the dash, instead of collapsing to a bare ring: the header then
  // reads as the same pill before and after the transcript resolves, and the
  // slots it showed fill in place. Neither dash stands in for a value that has
  // arrived; while the open resolves they lay out the row the values will take
  // and the pill paints one bar across it.
  if (!hasMessages) {
    return {
      primary: UNKNOWN_WINDOW_LABEL,
      secondary: UNKNOWN_WINDOW_LABEL,
      costSlot: loading ? 'loading' : 'unreported',
      tone: 'neutral',
      arcFraction: 0,
      interactive: false,
      usageUnavailable: !loading,
    };
  }
  // A transcript without usage. The pill keeps the track-only ring and, when
  // this screen already knows it, the session's cost, and never a dash standing
  // in for a value that has not arrived; only the dash above, for usage without
  // a context window, is a real value.
  return {
    primary: costText,
    secondary: null,
    costSlot: 'none',
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
    return spoken ? i18n.t('agents.sessionRow.costSpoken', { cost: spoken }) : '';
  }
  const unavailable = i18n.t('agentChat.contextUsage.usageUnavailable');
  const costPart = spoken ? i18n.t('agentChat.contextUsage.costSuffix', { cost: spoken }) : '';
  return `${unavailable}${costPart}.`;
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
  const tapPart = interactive ? ` ${i18n.t('agentChat.contextUsage.tapToViewDetails')}` : '';

  if (!info) {
    return `${getUnknownUsageBody(spoken, usageUnavailable)}${tapPart}`.trim();
  }

  const costPart = spoken ? i18n.t('agentChat.contextUsage.costSuffix', { cost: spoken }) : '';
  const body =
    info.contextWindow === undefined
      ? `${i18n.t('agentChat.contextUsage.tokensWindowUnavailable', {
          used: formatExactTokens(info.contextTokens),
        })}${costPart}.`
      : `${i18n.t('agentChat.contextUsage.tokensUsage', {
          used: formatExactTokens(info.contextTokens),
          window: formatExactTokens(info.contextWindow),
          percentage: formatPercent(info.percentage ?? 0, i18n.language),
        })}${costPart}.`;
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
