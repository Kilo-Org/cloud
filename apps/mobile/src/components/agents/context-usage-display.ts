import { platformLabel } from '@/lib/platform-label';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { formatSessionTotalCost } from './session-list-helpers';
import { formatSpokenCost } from './session-row-accessibility-label';

export type ContextTone = 'primary' | 'warning' | 'destructive' | 'neutral';

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

const WARNING_TONE_THRESHOLD = 75;
const DESTRUCTIVE_TONE_THRESHOLD = 90;

const INDETERMINATE_ARC_FRACTION = 0.25;
const WINDOW_UNAVAILABLE_LABEL = 'Context-window size unavailable';

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return '0';
  }
  if (tokens < 1000) {
    return String(Math.trunc(tokens));
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatExactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) {
    return '0';
  }
  return NUMBER_FORMAT.format(Math.trunc(tokens));
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) {
    return '$0.0000';
  }
  return `$${cost.toFixed(4)}`;
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
  hasCost: boolean;
  tone: ContextTone;
  /** `undefined` = indeterminate arc; `0` = track only (no usage asserted). */
  arcFraction: number | undefined;
  interactive: boolean;
};

/**
 * Single selector for the session-detail header pill. Always returns content
 * so the pill can reserve a fixed height before context usage resolves.
 */
export function getHeaderPillContent({
  info,
  totalCostMicrodollars,
  hasMessages,
}: {
  info: SessionContextInfo | undefined;
  totalCostMicrodollars: number | null;
  hasMessages: boolean;
}): HeaderPillContent {
  if (info) {
    const tone = getContextTone(info.percentage);
    const primary =
      info.percentage !== undefined
        ? `${info.percentage}%`
        : formatCompactTokens(info.contextTokens);
    const secondary = formatSessionTotalCost(totalCostMicrodollars);
    return {
      primary,
      secondary,
      hasCost: secondary !== null,
      tone,
      arcFraction: getArcFraction(info.percentage),
      interactive: true,
    };
  }

  const costText = hasMessages ? formatSessionTotalCost(totalCostMicrodollars) : null;
  return {
    primary: costText,
    secondary: null,
    hasCost: costText !== null,
    tone: 'neutral',
    arcFraction: 0,
    interactive: false,
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
  info: SessionContextInfo,
  totalCostMicrodollars: number | null
): ContextSheetContent {
  const tone = getContextTone(info.percentage);
  const usedTokens = formatExactTokens(info.contextTokens);
  const cost = formatSessionTotalCost(totalCostMicrodollars);
  if (info.contextWindow === undefined) {
    return {
      usedTokens,
      windowTokens: null,
      windowUnavailable: true,
      windowUnavailableLabel: WINDOW_UNAVAILABLE_LABEL,
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
    windowUnavailableLabel: WINDOW_UNAVAILABLE_LABEL,
    capacityKnown: true,
    percentage: `${realPercentage}%`,
    remainingTokens: formatExactTokens(remaining),
    remainingPercentage: `${remainingPercentage}%`,
    cost,
    tone,
  };
}

export function getMetricsAccessibilityLabel({
  info,
  totalCostMicrodollars,
  platform,
  interactive,
}: {
  info: SessionContextInfo | undefined;
  totalCostMicrodollars: number | null;
  /** Spoken only when the caller has a mapped platform glyph. */
  platform?: string | null;
  interactive: boolean;
}): string {
  const platformPart = platform != null && platform !== '' ? platformLabel(platform) : null;
  const spoken = formatSpokenCost(totalCostMicrodollars);
  const tapPart = interactive ? ' Tap to view context details.' : '';

  if (!info) {
    const parts: string[] = [];
    if (platformPart) {
      parts.push(platformPart);
    }
    if (spoken) {
      parts.push(`cost ${spoken}`);
    }
    return parts.join(', ');
  }

  const costPart = spoken ? `, cost ${spoken}` : '';
  const body =
    info.contextWindow === undefined
      ? `Context ${formatExactTokens(info.contextTokens)} tokens, window unavailable${costPart}.`
      : `Context ${formatExactTokens(info.contextTokens)} of ${formatExactTokens(info.contextWindow)} tokens, ${info.percentage ?? 0}% used${costPart}.`;
  return platformPart ? `${platformPart}. ${body}${tapPart}` : `${body}${tapPart}`;
}

type SheetMountState =
  | { mounted: false }
  | { mounted: true; visible: boolean; info: SessionContextInfo };

export type ContextSheetIdentity = {
  sessionId: string;
  providerID: string;
  modelID: string;
};

/**
 * Controls when the native Modal is mounted and when it is visible. Keeping
 * the sheet mounted while contextInfo exists lets `visible` transition from
 * true → false so the native pageSheet dismissal animation runs.
 */
export function getContextSheetMountState(
  info: SessionContextInfo | undefined,
  openIdentity: ContextSheetIdentity | null,
  sessionId: string
): SheetMountState {
  if (!info) {
    return { mounted: false };
  }
  const visible =
    openIdentity?.sessionId === sessionId &&
    openIdentity.providerID === info.providerID &&
    openIdentity.modelID === info.modelID;
  return { mounted: true, visible, info };
}
