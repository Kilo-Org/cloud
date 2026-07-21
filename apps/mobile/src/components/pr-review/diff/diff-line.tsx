// A single line of a diff, rendered in JetBrains Mono with syntax
// highlighting, a gutter for old/new line numbers, and a tinted
// background that signals add / del / context.
//
// We render fixed-height rows (height = lineHeight + vertical padding)
// so FlashList can virtualize without measuring each row. The diff
// surface renders thousands of lines and remeasuring on every scroll
// frame would destroy scroll perf on mid-tier Android devices.
//
// S7a adds two opt-in behaviours, both passed from the diff list:
//   - `onTap` makes the line tappable; the diff list runs the
//     selection reducer and updates the bridge / floating action.
//   - `isSelected` paints a focus ring around the line when it
//     falls inside the current selection range.

import { memo, useMemo } from 'react';
import { Pressable, Text as RNText, type TextStyle, View, type ViewStyle } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { highlightLine, type HighlightToken } from '@/lib/pr-review/diff/highlight';
import { type ParsedDiffLine } from '@/lib/pr-review/diff/parse-patch';
import { MUTED_COLOR, tokenColorFor } from '@/lib/pr-review/diff/syntax-colors';
import { cn } from '@/lib/utils';

const LINE_HEIGHT = 18;
const VERTICAL_PADDING = 2;
const GUTTER_WIDTH = 56;
const NO_NEWLINE_INDICATOR = '\u26A0\uFE0F no newline at end of file';

const ROW_MIN_HEIGHT = LINE_HEIGHT + VERTICAL_PADDING * 2;
const ROW_STYLE: ViewStyle = { minHeight: ROW_MIN_HEIGHT };
const GUTTER_STYLE: ViewStyle = {
  width: GUTTER_WIDTH,
  height: ROW_MIN_HEIGHT,
};
const CODE_CONTAINER_STYLE: ViewStyle = { paddingVertical: VERTICAL_PADDING };
const CODE_BASE_STYLE: TextStyle = {
  fontFamily: 'JetBrainsMono_500Medium',
  fontSize: 12,
  lineHeight: LINE_HEIGHT,
};
const GUTTER_TEXT_BASE: TextStyle = {
  fontFamily: 'JetBrainsMono_500Medium',
  fontSize: 11,
  lineHeight: LINE_HEIGHT,
};
const NO_NEWLINE_BASE: TextStyle = {
  fontFamily: 'JetBrainsMono_500Medium',
  fontSize: 11,
  lineHeight: LINE_HEIGHT,
};

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

function DiffLineImpl({ line, language, onTap, isSelected }: Readonly<DiffLineProps>) {
  const colors = useThemeColors();
  const isDark = colors.background === '#0E0E10';

  const tokens = useMemo<HighlightToken[]>(
    () => highlightLine(line.text, language),
    [language, line.text]
  );

  const gutterText = gutterTextFor(line);
  const rowBackground = rowBackgroundFor(line.type);
  const gutterColor = isDark ? MUTED_COLOR.dark : MUTED_COLOR.light;
  const noNewlineColor = isDark ? MUTED_COLOR.dark : MUTED_COLOR.light;
  const noNewlineLabel = ` ${NO_NEWLINE_INDICATOR}`;

  // Selection ring: painted as a thick left border in the primary color
  // (works on both add/del/context backgrounds). Concrete Tailwind color
  // is required — CSS-var opacity modifiers don't work on theme tokens.
  const selectionClass = isSelected ? 'border-l-2 border-primary' : 'border-l-2 border-transparent';

  const content = (
    <View className={cn('flex-row items-stretch', rowBackground, selectionClass)} style={ROW_STYLE}>
      <View className="items-end justify-center pr-2" style={GUTTER_STYLE}>
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme color + mono font for gutter */}
        <RNText allowFontScaling={false} style={{ ...GUTTER_TEXT_BASE, color: gutterColor }}>
          {gutterText}
        </RNText>
      </View>
      <View className="flex-1" style={CODE_CONTAINER_STYLE} accessibilityLabel={line.text}>
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme color + mono font for code */}
        <RNText
          allowFontScaling={false}
          selectable
          style={{ ...CODE_BASE_STYLE, color: colors.foreground }}
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
            <RNText style={{ ...NO_NEWLINE_BASE, color: noNewlineColor }}>{noNewlineLabel}</RNText>
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
          ? `Selected diff line ${gutterText || 'context'}, tap to change selection`
          : `Comment on diff line ${gutterText || 'context'}`
      }
      accessibilityState={{ selected: Boolean(isSelected) }}
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
