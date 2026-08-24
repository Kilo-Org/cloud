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
// Row height scales with the system font scale (bounded — see
// `diff-font-metrics.ts`). The cap keeps both columns aligned even at
// the largest a11y scale we honour; without the cap, the gutter would
// overflow at AX5 (1.8x).

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Text as RNText, type TextStyle, View, type ViewStyle } from 'react-native';

import { type TFunction } from 'i18next';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { highlightLine, type HighlightToken } from '@/lib/pr-review/diff/highlight';
import { type ParsedDiffLine, type ParsedHunk } from '@/lib/pr-review/diff/parse-patch';
import { type SideBySideRow as SideBySideRowData } from '@/lib/pr-review/diff/side-by-side';
import { MUTED_COLOR, tokenColorFor } from '@/lib/pr-review/diff/syntax-colors';
import { cn } from '@/lib/utils';
import {
  type BoundedFontMetrics,
  DIFF_MAX_FONT_SCALE,
  useDiffFontMetrics,
} from '@/components/pr-review/diff/diff-font-metrics';

const COLUMN_GUTTER_WIDTH = 56;
const COLUMN_INNER_PADDING = 2;
const VERTICAL_PADDING = 2;

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
  const metrics = useDiffFontMetrics();
  const { t } = useTranslation();
  const tokens = useMemo<HighlightToken[]>(
    () => highlightLine(line.text, language),
    [language, line.text]
  );
  const gutterColor = isDark ? MUTED_COLOR.dark : MUTED_COLOR.light;
  const noNewlineColor = isDark ? MUTED_COLOR.dark : MUTED_COLOR.light;
  const gutterText = sideGutterText(line, side);
  const noNewlineLabel = line.noNewlineAtEndOfFile
    ? ` ${t('prReview.sideBySide.noNewlineAtEndOfFile')}`
    : '';

  const rowStyle: ViewStyle = { minHeight: metrics.rowMinHeight };
  const gutterStyle: ViewStyle = {
    width: COLUMN_GUTTER_WIDTH,
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

  return (
    <View
      className={cn('flex-1 flex-row items-stretch', rowBackgroundFor(line.type))}
      style={rowStyle}
    >
      <View
        className="items-end justify-center"
        style={{ ...gutterStyle, paddingRight: COLUMN_INNER_PADDING }}
      >
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme muted color */}
        <RNText
          maxFontSizeMultiplier={DIFF_MAX_FONT_SCALE}
          style={{ ...gutterTextBase, color: gutterColor }}
        >
          {gutterText}
        </RNText>
      </View>
      <View className="flex-1" style={codeContainerStyle} accessibilityLabel={line.text}>
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme foreground color */}
        <RNText
          maxFontSizeMultiplier={DIFF_MAX_FONT_SCALE}
          selectable
          style={{ ...codeBaseStyle, color: foreground }}
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
            <RNText style={{ ...noNewlineBase, color: noNewlineColor }}>{noNewlineLabel}</RNText>
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

function EmptySideColumn({ metrics }: { metrics: BoundedFontMetrics }) {
  const { t } = useTranslation();
  const rowStyle: ViewStyle = { minHeight: metrics.rowMinHeight };
  const gutterStyle: ViewStyle = {
    width: COLUMN_GUTTER_WIDTH,
    minHeight: metrics.rowMinHeight,
  };
  const codeContainerStyle: ViewStyle = { paddingVertical: VERTICAL_PADDING };
  return (
    <View
      className="flex-1 flex-row items-stretch bg-transparent"
      style={rowStyle}
      accessibilityLabel={t('prReview.sideBySide.emptyDiffColumn')}
    >
      <View
        className="items-end justify-center"
        style={{ ...gutterStyle, paddingRight: COLUMN_INNER_PADDING }}
      />
      <View className="flex-1" style={codeContainerStyle} />
    </View>
  );
}

function describeRow(row: SideBySideRowData, t: TFunction): string {
  if (row.left && row.right) {
    return t('prReview.sideBySide.oldNew', {
      old: row.left.line.text,
      new: row.right.line.text,
    });
  }
  if (row.left) {
    return t('prReview.sideBySide.oldOnly', { text: row.left.line.text });
  }
  if (row.right) {
    return t('prReview.sideBySide.newOnly', { text: row.right.line.text });
  }
  return t('prReview.sideBySide.emptyDiffRow');
}

function SideBySideRowImpl({ row, language, rowKeyId }: Readonly<SideBySideRowProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const metrics = useDiffFontMetrics();
  const isDark = colors.background === '#0E0E10';
  const leftLine = row.left?.line ?? null;
  const rightLine = row.right?.line ?? null;
  const rowStyle: ViewStyle = { minHeight: metrics.rowMinHeight };

  return (
    <View
      className="flex-row items-stretch border-b border-hair-soft"
      style={rowStyle}
      accessibilityLabel={describeRow(row, t)}
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
        <EmptySideColumn metrics={metrics} />
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
        <EmptySideColumn metrics={metrics} />
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
  const { t } = useTranslation();
  return (
    <View
      className="border-b border-hair-soft bg-secondary px-4 py-1"
      accessibilityLabel={t('prReview.hunkRows.hunkHeader', { header: hunk.header })}
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
