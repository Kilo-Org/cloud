// Side-by-side row component for the tablet PR diff view. Renders a
// single `SideBySideRow` as two equal columns: the left column shows
// the old/deleted/context line with its old line number; the right
// column shows the new/added/context line with its new line number.
// Either column may be empty (left blank with a placeholder) when the
// pair is a pure add or pure del.
//
// Side-by-side is read-only — commenting is unified-view only — so the
// row does not accept tap/selection handlers.
//
// Renders fixed-height rows so FlashList can virtualize without
// remeasuring. The row height matches the unified `DiffLine` row so
// mixed view-mode content (if the toggle changes mid-scroll) would
// still fit a stable grid.

import { memo, useMemo } from 'react';
import { Text as RNText, type TextStyle, View, type ViewStyle } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { highlightLine, type HighlightToken } from '@/lib/pr-review/diff/highlight';
import { type ParsedDiffLine, type ParsedHunk } from '@/lib/pr-review/diff/parse-patch';
import { type SideBySideRow as SideBySideRowData } from '@/lib/pr-review/diff/side-by-side';
import { MUTED_COLOR, tokenColorFor } from '@/lib/pr-review/diff/syntax-colors';
import { cn } from '@/lib/utils';

const LINE_HEIGHT = 18;
const VERTICAL_PADDING = 2;
const COLUMN_GUTTER_WIDTH = 56;
const COLUMN_INNER_PADDING = 2;
const NO_NEWLINE_INDICATOR = '\u26A0\uFE0F no newline at end of file';

const ROW_MIN_HEIGHT = LINE_HEIGHT + VERTICAL_PADDING * 2;
const ROW_STYLE: ViewStyle = { minHeight: ROW_MIN_HEIGHT };
const GUTTER_STYLE: ViewStyle = {
  width: COLUMN_GUTTER_WIDTH,
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

type SideBySideRowProps = {
  row: SideBySideRowData;
  language: string | null;
  rowKeyId: string;
};

function sideGutterText(line: ParsedDiffLine, side: 'left' | 'right'): string {
  if (side === 'left') {
    if (line.type === 'add') {
      return '';
    }
    return `${line.oldLine ?? line.newLine ?? ''}`;
  }
  if (line.type === 'del') {
    return '';
  }
  return `${line.newLine ?? line.oldLine ?? ''}`;
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

type SideColumnProps = {
  line: ParsedDiffLine;
  side: 'left' | 'right';
  language: string | null;
  isDark: boolean;
  foreground: string;
};

function SideColumnImpl({ line, side, language, isDark, foreground }: SideColumnProps) {
  const tokens = useMemo<HighlightToken[]>(
    () => highlightLine(line.text, language),
    [language, line.text]
  );
  const gutterColor = isDark ? MUTED_COLOR.dark : MUTED_COLOR.light;
  const noNewlineColor = isDark ? MUTED_COLOR.dark : MUTED_COLOR.light;
  const gutterText = sideGutterText(line, side);
  const noNewlineLabel = line.noNewlineAtEndOfFile ? ` ${NO_NEWLINE_INDICATOR}` : '';

  return (
    <View
      className={cn('flex-1 flex-row items-stretch', rowBackgroundFor(line.type))}
      style={ROW_STYLE}
    >
      <View
        className="items-end justify-center"
        style={{ ...GUTTER_STYLE, paddingRight: COLUMN_INNER_PADDING }}
      >
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme muted color */}
        <RNText allowFontScaling={false} style={{ ...GUTTER_TEXT_BASE, color: gutterColor }}>
          {gutterText}
        </RNText>
      </View>
      <View className="flex-1" style={CODE_CONTAINER_STYLE} accessibilityLabel={line.text}>
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme foreground color */}
        <RNText
          allowFontScaling={false}
          selectable
          style={{ ...CODE_BASE_STYLE, color: foreground }}
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
          {noNewlineLabel ? (
            // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic muted color for no-newline marker
            <RNText style={{ ...NO_NEWLINE_BASE, color: noNewlineColor }}>{noNewlineLabel}</RNText>
          ) : null}
        </RNText>
      </View>
    </View>
  );
}

const SideColumn = memo(
  SideColumnImpl,
  (prev, next) =>
    prev.line === next.line &&
    prev.language === next.language &&
    prev.side === next.side &&
    // Include theme inputs so a light/dark switch re-renders the colors.
    prev.isDark === next.isDark &&
    prev.foreground === next.foreground
);

function EmptySideColumn() {
  return (
    <View
      className="flex-1 flex-row items-stretch bg-transparent"
      style={ROW_STYLE}
      accessibilityLabel="empty diff column"
    >
      <View
        className="items-end justify-center"
        style={{ ...GUTTER_STYLE, paddingRight: COLUMN_INNER_PADDING }}
      />
      <View className="flex-1" style={CODE_CONTAINER_STYLE} />
    </View>
  );
}

function describeRow(row: SideBySideRowData): string {
  if (row.left && row.right) {
    return `Old: ${row.left.line.text} | New: ${row.right.line.text}`;
  }
  if (row.left) {
    return `Old only: ${row.left.line.text}`;
  }
  if (row.right) {
    return `New only: ${row.right.line.text}`;
  }
  return 'Empty diff row';
}

function SideBySideRowImpl({ row, language, rowKeyId }: Readonly<SideBySideRowProps>) {
  const colors = useThemeColors();
  const isDark = colors.background === '#0E0E10';
  const leftLine = row.left?.line ?? null;
  const rightLine = row.right?.line ?? null;

  return (
    <View
      className="flex-row items-stretch border-b border-hair-soft"
      style={ROW_STYLE}
      accessibilityLabel={describeRow(row)}
      testID={rowKeyId}
    >
      {leftLine ? (
        <SideColumn
          line={leftLine}
          side="left"
          language={language}
          isDark={isDark}
          foreground={colors.foreground}
        />
      ) : (
        <EmptySideColumn />
      )}
      <View className="w-px self-stretch bg-hair-soft" />
      {rightLine ? (
        <SideColumn
          line={rightLine}
          side="right"
          language={language}
          isDark={isDark}
          foreground={colors.foreground}
        />
      ) : (
        <EmptySideColumn />
      )}
    </View>
  );
}

export const SideBySideRow = memo(
  SideBySideRowImpl,
  (prev, next) =>
    prev.rowKeyId === next.rowKeyId && prev.language === next.language && prev.row === next.row
);

type HunkSideBySideHeaderProps = {
  hunk: ParsedHunk;
};

export function HunkSideBySideHeader({ hunk }: Readonly<HunkSideBySideHeaderProps>) {
  const colors = useThemeColors();
  return (
    <View
      className="border-b border-hair-soft bg-secondary px-4 py-1"
      accessibilityLabel={`Hunk header ${hunk.header}`}
    >
      <Text
        className="font-mono-medium text-[11px]"
        // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic muted color
        style={{ color: colors.mutedForeground }}
        numberOfLines={1}
      >
        {hunk.header}
      </Text>
    </View>
  );
}
