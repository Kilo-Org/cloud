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
  /**
   * The percentage reading, or `null` when the session has none to paint. The
   * slot keeps its width either way: nothing paints in it for a value that has
   * not arrived, so a settled empty pill never shows a placeholder glyph.
   */
  primary: string | null;
  /** The session's cost, or `null` when it has none to paint. */
  secondary: string | null;
  /**
   * What the cost part of the reading paints:
   *
   * - `label`: the session's cost, as text.
   * - `loading`: the session is still resolving, so the pill paints one bar
   *   across its value row instead of a value.
   * - `unreported`: the session settled without a cost. Nothing paints, and the
   *   slot keeps its width so a cost that arrives later fills it in place.
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

type PillCostSlot = 'label' | 'loading' | 'unreported';

/**
 * The widest reading each value slot reserves, read through the formatters the
 * painted values use so the slot holds at every font scale and in every locale.
 *
 * The pill lays each slot out at this width and paints the reading over it.
 * A slot therefore never collapses for a value that has not arrived, and a
 * reading that arrives fills the slot it already showed instead of resizing the
 * pill — and the title and trailing control beside it — after the screen
 * settled.
 *
 * The percentage reserves the widest reading the formatter paints. It keeps at
 * most one decimal, so a fractional reading carries a glyph more than a whole
 * window does (`16.7%` against `100%`), and both are read through the formatter
 * so the reserve follows this language's own digits and percent sign.
 * The cost reserves a badge in both of its shapes, since one carries two
 * decimals at or above half a cent and the other four decimals below it, so the
 * reserve is the wider of the two.
 *
 * The reserve stops there on purpose. A total wide enough to need a grouping
 * separator paints past it and truncates inside its one line, the way a long
 * total already truncates under the header's cap. Reserving the grouped form
 * was measured against the compact window: it leaves the header's title row
 * 5 dp narrower than the title's own badge needs, which clips that badge — a
 * defect the design gate reports as an error, on every screen, not only on a
 * session that happens to spend four figures.
 */
const COST_SLOT_SIZER_TWO_DECIMALS_MICRODOLLARS = 12_340_000;
const COST_SLOT_SIZER_FOUR_DECIMALS_MICRODOLLARS = 4_999;

/**
 * The percentages the slot has to hold: a fractional reading just below the
 * whole window and the whole window itself. One of them is the widest shape the
 * formatter produces here, whichever is longer in this language.
 */
const PERCENTAGE_SLOT_SIZER_VALUES = [99.9, 100];

export function getPillSlotSizers() {
  const twoDecimals = formatSessionCostBadge(COST_SLOT_SIZER_TWO_DECIMALS_MICRODOLLARS) ?? '$0.00';
  const fourDecimals =
    formatSessionCostBadge(COST_SLOT_SIZER_FOUR_DECIMALS_MICRODOLLARS) ?? '$0.0000';
  let percentage = '';
  for (const value of PERCENTAGE_SLOT_SIZER_VALUES) {
    const reading = formatPercent(value, i18n.language);
    if (reading.length > percentage.length) {
      percentage = reading;
    }
  }
  return {
    percentage,
    cost: fourDecimals.length >= twoDecimals.length ? fourDecimals : twoDecimals,
  };
}

/**
 * The pill's fixed chrome, in dp: its 28dp ring, its border, its `px-2.5`
 * padding, the `gap-1.5` between the ring and the value row, and the row's own
 * `gap-1`. None of it is text, so none of it follows the font scale.
 */
const PILL_CHROME_WIDTH = 60;

/**
 * The two value slots' reserved readings at font scale 1, in dp: the sizers the
 * slots lay out, plus the slack the painted pill leaves beside them. Both
 * readings are `Text`, so both follow the system font scale.
 */
const PILL_READINGS_WIDTH = 68;

/**
 * Width the pill lays out at, in dp, at a font scale: its fixed chrome plus its
 * reserved readings scaled. A header that reserves its trailing cluster uses
 * this, so the width it reserves is the width the pill paints at that scale —
 * and a reading that arrives still fills the slot it already showed.
 */
export function getHeaderPillWidth(fontScale: number): number {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return PILL_CHROME_WIDTH + PILL_READINGS_WIDTH * scale;
}

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
    // context window is unresolved there is no honest denominator, so the pill
    // paints nothing for it: the ring's indeterminate arc carries the unknown,
    // the sheet still shows the tokens, and a marker here would sit right
    // before the cost and read as a negative amount.
    const primary =
      info.percentage === undefined ? null : formatPercent(info.percentage, i18n.language);
    const secondary = formatSessionCostBadge(totalCostMicrodollars);
    return {
      primary,
      secondary,
      costSlot: secondary !== null ? 'label' : 'unreported',
      tone,
      arcFraction: getArcFraction(info.percentage),
      interactive: true,
      usageUnavailable: false,
    };
  }

  const costText = hasMessages ? formatSessionCostBadge(totalCostMicrodollars) : null;
  // Nothing has reported usage yet. The pill paints nothing beside its ring: a
  // value that has not arrived is not a value, and a dash standing in for it
  // would read as a reading that is still pending. Both slots keep their widths
  // instead, so the pill is already the size of the reading it will show and a
  // finished empty chat looks settled rather than mid-load. While the open still
  // resolves, one bar paints across the row those slots lay out.
  if (!hasMessages) {
    return {
      primary: null,
      secondary: null,
      costSlot: loading ? 'loading' : 'unreported',
      tone: 'neutral',
      arcFraction: 0,
      interactive: false,
      usageUnavailable: !loading,
    };
  }
  // A transcript without usage. The pill keeps the track-only ring and, when
  // this screen already knows it, the session's cost; no branch of this selector
  // paints a dash standing in for a value.
  return {
    primary: null,
    secondary: costText,
    costSlot: costText === null ? 'unreported' : 'label',
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
