// A single line of a diff, rendered in JetBrains Mono with syntax
// highlighting, a gutter for old/new line numbers, and a tinted
// background that signals add / del / context.
//
// Row height scales with the system font scale (bounded — see
// `diff-font-metrics.ts`). The cap preserves diff density and the
// 56-point gutter; honouring the raw a11y scale (1.8x at AX5) would
// overflow the gutter and break the side-by-side grid.
//
// S7a adds two opt-in behaviours, both passed from the diff list:
//   - `onTap` makes the line tappable; the diff list runs the
//     selection reducer and updates the bridge / floating action.
//   - `isSelected` paints a focus ring around the line when it
//     falls inside the current selection range.
//
// P1-C-26a layers three non-color accessibility refinements on top
// of the bounded font metrics from P1-C-22:
//   - a small GUTTER GLYPH (`+` / `-` / `·`) that mirrors the unified
//     diff prefix, so add/del/context are distinguishable in
//     monochrome (color reinforces but never replaces the signal);
//   - a PRESSABLE `accessibilityLabel` that includes the status word
//     AND the line text (the prior label only named the gutter line
//     number), and the same status word + text on the inner code
//     view for screen-reader browsing;
//   - a `hitSlop` that adds only horizontal padding to the touchable
//     row. Rows are rendered contiguously with zero gaps, so vertical
//     expansion would overlap adjacent rows and mis-route taps. The
//     bounded visible row height itself is the effective vertical
//     target; per-row selection accuracy takes precedence over a
//     nominal 44pt vertical target on contiguous rows.

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text as RNText, type TextStyle, View, type ViewStyle } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { highlightLine, type HighlightToken } from '@/lib/pr-review/diff/highlight';
import { hitSlopForRow } from '@/lib/pr-review/diff/diff-target';
import {
  buildDiffLineAccessibilityLabel,
  diffLineMarker,
  type ParsedDiffLine,
} from '@/lib/pr-review/diff/parse-patch';
import { MUTED_COLOR, tokenColorFor } from '@/lib/pr-review/diff/syntax-colors';
import { cn } from '@/lib/utils';
import {
  DIFF_MAX_FONT_SCALE,
  useDiffFontMetrics,
} from '@/components/pr-review/diff/diff-font-metrics';

const GUTTER_WIDTH = 56;
const VERTICAL_PADDING = 2;

type DiffLineProps = {
  line: ParsedDiffLine;
  language: string | null;
  keyId: string;
  /** When set, the whole row is pressable; pressing invokes the handler. */
  onTap?: () => void;
  /** When true, the row is painted with the selection focus ring. */
  isSelected?: boolean;
};

function gutterTextFor(line: ParsedDiffLine): string {
  if (line.type === 'add') {
    return `${line.newLine ?? ''}`;
  }
  if (line.type === 'del') {
    return `${line.oldLine ?? ''}`;
  }
  return `${line.oldLine ?? line.newLine ?? ''}`;
}

function rowBackgroundFor(type: ParsedDiffLine['type']): string {
  if (type === 'add') {
    return 'bg-good-tile-bg';
  }
  if (type === 'del') {
    return 'bg-danger-tile-bg';
  }
  return 'bg-transparent';
}

function markerColorFor(
  type: ParsedDiffLine['type'],
  colors: ReturnType<typeof useThemeColors>
): string {
  if (type === 'add') {
    return colors.good;
  }
  if (type === 'del') {
    return colors.destructive;
  }
  return colors.mutedForeground;
}

function DiffLineImpl({ line, language, onTap, isSelected }: Readonly<DiffLineProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const isDark = colors.background === '#0E0E10';
  const metrics = useDiffFontMetrics();

  const tokens = useMemo<HighlightToken[]>(
    () => highlightLine(line.text, language),
    [language, line.text]
  );

  const gutterText = gutterTextFor(line);
  const rowBackground = rowBackgroundFor(line.type);
  const gutterColor = isDark ? MUTED_COLOR.dark : MUTED_COLOR.light;
  const noNewlineColor = isDark ? MUTED_COLOR.dark : MUTED_COLOR.light;
  const noNewlineLabel = ` ${t('prReview.sideBySide.noNewlineAtEndOfFile')}`;
  const marker = diffLineMarker(line.type);
  const markerColor = markerColorFor(line.type, colors);
  const accessibilityLabel = buildDiffLineAccessibilityLabel(line);
  const hitSlop = hitSlopForRow();

  // Row + gutter use the bounded rowMinHeight so the line is never
  // clipped when the user has a larger a11y font scale.
  const rowStyle: ViewStyle = { minHeight: metrics.rowMinHeight };
  const gutterStyle: ViewStyle = {
    width: GUTTER_WIDTH,
    minHeight: metrics.rowMinHeight,
  };
  const codeContainerStyle: ViewStyle = { paddingVertical: VERTICAL_PADDING };
  const codeBaseStyle: TextStyle = {
    fontFamily: 'JetBrainsMono_500Medium',
    fontSize: metrics.codeFontSize,
    lineHeight: metrics.lineHeight,
  };
  const gutterTextBase: TextStyle = {
    fontFamily: 'JetBrainsMono_500Medium',
    fontSize: metrics.labelFontSize,
    lineHeight: metrics.lineHeight,
  };
  const noNewlineBase: TextStyle = {
    fontFamily: 'JetBrainsMono_500Medium',
    fontSize: metrics.labelFontSize,
    lineHeight: metrics.lineHeight,
  };

  // Selection ring: painted as a thick left border in the primary color
  // (works on both add/del/context backgrounds). Concrete Tailwind color
  // is required — CSS-var opacity modifiers don't work on theme tokens.
  const selectionClass = isSelected ? 'border-l-2 border-primary' : 'border-l-2 border-transparent';

  const content = (
    <View className={cn('flex-row items-stretch', rowBackground, selectionClass)} style={rowStyle}>
      <View className="items-end justify-center pr-2" style={gutterStyle}>
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme color + mono font for gutter */}
        <RNText
          adjustsFontSizeToFit
          maxFontSizeMultiplier={DIFF_MAX_FONT_SCALE}
          numberOfLines={1}
          style={{ ...gutterTextBase, color: gutterColor }}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          {/* Non-color gutter glyph: '+' / '-' / '·' — the CHARACTER is the
              signal (readable in monochrome); markerColor only reinforces it.
              numberOfLines + adjustsFontSizeToFit keeps marker + number on one
              line at every honoured font scale, preserving bounded row height. */}
          {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme color for non-color add/del glyph */}
          <RNText style={{ color: markerColor }}>{marker}</RNText>
          {gutterText ? ` ${gutterText}` : ''}
        </RNText>
      </View>
      {/* `accessible` exposes the label on iOS: without it the container is
          not an accessibility element and VoiceOver announces only the
          selectable code text. In the pressable path the wrapping Pressable
          groups this subtree, so the flag only surfaces on read-only rows. */}
      <View
        className="flex-1"
        style={codeContainerStyle}
        accessible
        accessibilityLabel={accessibilityLabel}
      >
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme color + mono font for code */}
        <RNText
          maxFontSizeMultiplier={DIFF_MAX_FONT_SCALE}
          selectable
          style={{ ...codeBaseStyle, color: colors.foreground }}
        >
          {tokens.map((token, index) => {
            const tokenColor = tokenColorFor(token.className, isDark);
            return (
              // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- per-token syntax color
              <RNText key={`tok-${index}`} style={{ color: tokenColor }}>
                {token.text}
              </RNText>
            );
          })}
          {line.noNewlineAtEndOfFile ? (
            // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic muted color for no-newline marker
            <RNText style={{ ...noNewlineBase, color: noNewlineColor }}>{noNewlineLabel}</RNText>
          ) : null}
        </RNText>
      </View>
    </View>
  );

  if (!onTap) {
    return content;
  }
  return (
    <Pressable
      onPress={onTap}
      accessibilityRole="button"
      accessibilityLabel={
        isSelected
          ? t('prReview.diff.selectedTapToChange', { label: accessibilityLabel })
          : t('prReview.diff.tapToComment', { label: accessibilityLabel })
      }
      accessibilityState={{ selected: Boolean(isSelected) }}
      hitSlop={hitSlop}
    >
      {content}
    </Pressable>
  );
}

export const DiffLine = memo(
  DiffLineImpl,
  (prev, next) =>
    prev.keyId === next.keyId &&
    prev.language === next.language &&
    prev.line === next.line &&
    prev.onTap === next.onTap &&
    prev.isSelected === next.isSelected
);
