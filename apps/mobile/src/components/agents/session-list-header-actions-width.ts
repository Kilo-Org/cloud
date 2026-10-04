import { containsJoinedScript, hasRtlScript } from '@/lib/rtl-text';

/** JetBrains Mono (the header labels' `font-mono-medium`) advances 0.6em per glyph. */
const HEADER_MONO_ADVANCE_EM = 0.6;
/**
 * Any non-ASCII glyph is counted one em wide. The header labels are mono, but a
 * CJK/Kana/Hangul ideograph is a full em where a Latin glyph is 0.6, so counting
 * every non-ASCII codepoint at 1em keeps the estimate an upper bound for the
 * scripts the catalogs cover (and merely over-counts accented Latin).
 */
const HEADER_WIDE_ADVANCE_EM = 1;
/** The history link overrides the `Eyebrow` variant to `text-[11px]`. */
const HEADER_HISTORY_LABEL_FONT_SIZE = 11;
/** The label's `tracking-[1.5px]`. `Text` draws it for Latin copy in either
 * direction and resets it for the scripts it cannot hold (see
 * {@link headerLabelTracking}), so it is applied per label. */
const HEADER_LABEL_TRACKING = 1.5;
/** `SessionFilterButton`'s `h-[36px] w-[36px] shrink-0`. */
const HEADER_FILTER_BUTTON_WIDTH = 36;
/** The controls row's `gap-4`: NativeWind's rem is 14pt, not 16. */
const HEADER_ACTIONS_GAP = 14;

/**
 * Letter spacing (dp per glyph) a label actually draws, matching
 * `@/components/ui/text`'s reset rule rather than the interface direction
 * alone: the reset lands on copy in a joined script in either direction
 * (`containsJoinedScript`) and on any RTL-script copy inside an RTL interface
 * (`isRTL && hasRtlScript`), while Latin copy keeps its tracking in either
 * direction. Keying off `isRTL` alone dropped the tracking for a Latin label in
 * an RTL interface, so the estimate fell short of the rendered cluster and the
 * row could still squeeze the title — the opposite of the upper bound this
 * module promises.
 */
function headerLabelTracking(label: string, isRTL: boolean): number {
  return containsJoinedScript(label) || (isRTL && hasRtlScript(label)) ? 0 : HEADER_LABEL_TRACKING;
}

function headerLabelWidth(params: {
  label: string;
  fontSize: number;
  fontScale: number;
  tracking: number;
}): number {
  const { label, fontSize, fontScale, tracking } = params;
  let width = 0;
  for (const character of label) {
    const advanceEm =
      (character.codePointAt(0) ?? 0) > 127 ? HEADER_WIDE_ADVANCE_EM : HEADER_MONO_ADVANCE_EM;
    width += advanceEm * fontSize * fontScale + tracking;
  }
  return width;
}

/**
 * Conservative width (dp) the Agents header's controls row lays out at.
 *
 * `ScreenHeader` reserves this through `inlineActionsWidth` (see
 * `shouldStackHeaderActions`): when the 30px title cannot keep its readable
 * minimum beside the row, the row drops beneath the title instead of squeezing
 * it into a mid-word break — the Croatian capture rendered "Agenti" as
 * "Age" / "nti" beside the history link and the filter button on a narrow
 * phone.
 *
 * The row holds the history link and (when the list can be filtered) the 36dp
 * filter button, `gap-4` apart. The label width is an upper bound, so the row
 * reflows a hair early rather than leaving the title squeezed; the estimate
 * scales with the system font because the label does.
 *
 * Kept apart from `session-list-helpers.ts`: this module reaches
 * `@/lib/rtl-text`, which imports `react-native`, while `session-list-helpers`
 * is in the headless `start-agent` action graph and must stay free of native
 * modules (see `start-agent-runtime.ts`).
 */
export function estimateSessionListHeaderActionsWidth(params: {
  historyLabel: string;
  showFilter: boolean;
  fontScale?: number;
  isRTL?: boolean;
}): number {
  const { historyLabel, showFilter, fontScale = 1, isRTL = false } = params;
  const segments = [
    headerLabelWidth({
      label: historyLabel,
      fontSize: HEADER_HISTORY_LABEL_FONT_SIZE,
      fontScale,
      tracking: headerLabelTracking(historyLabel, isRTL),
    }),
    ...(showFilter ? [HEADER_FILTER_BUTTON_WIDTH] : []),
  ];
  const gaps = Math.max(segments.length - 1, 0) * HEADER_ACTIONS_GAP;
  return Math.ceil(segments.reduce((total, segment) => total + segment, 0) + gaps);
}
