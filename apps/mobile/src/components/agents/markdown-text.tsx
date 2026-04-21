import { Fragment, type ReactNode, useMemo } from 'react';
import {
  ScrollView,
  Text,
  type TextStyle,
  useColorScheme,
  View,
  type ViewStyle,
} from 'react-native';
import { type MarkedStyles, Renderer, useMarkdown } from 'react-native-marked';

import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';

type MarkdownVariant = 'assistant' | 'user';

type MarkdownTextProps = {
  value: string;
  variant?: MarkdownVariant;
};

// Convert an `hsl(h, s%, l%)` theme token into `hsla(..., alpha)`.
// Theme tokens in `use-theme-colors.ts` are authored as `hsl(...)` strings
// so React Navigation accepts them directly; this helper lets us derive
// translucent variants for in-bubble dividers without duplicating tokens.
function withAlpha(hslColor: string, alpha: number): string {
  const match = /^hsl\(\s*([^)]+)\)$/i.exec(hslColor);
  if (!match) {
    return hslColor;
  }
  return `hsla(${match[1]}, ${alpha})`;
}

type MarkdownPalette = {
  textColor: string;
  mutedTextColor: string;
  codeBackground: string;
  borderColor: string;
};

function getPalette(variant: MarkdownVariant, colors: ThemeColors): MarkdownPalette {
  const isUser = variant === 'user';
  return {
    textColor: isUser ? colors.primaryForeground : colors.foreground,
    mutedTextColor: isUser ? withAlpha(colors.primaryForeground, 0.7) : colors.mutedForeground,
    codeBackground: isUser ? withAlpha(colors.primaryForeground, 0.15) : colors.muted,
    borderColor: isUser ? withAlpha(colors.primaryForeground, 0.3) : colors.border,
  };
}

// `react-native-marked`'s `useMarkdown` takes an inline styles map rather than
// `className`, so we cannot use NativeWind here. Centralizing style creation
// keeps both variants in sync and makes the color choices reviewable.
function getMarkdownStyles(palette: MarkdownPalette): MarkedStyles {
  const { textColor, mutedTextColor, codeBackground, borderColor } = palette;

  return {
    text: { color: textColor, fontSize: 16, lineHeight: 24 },
    paragraph: { marginVertical: 2, paddingVertical: 0 },
    strong: { color: textColor, fontWeight: '700' },
    em: { color: textColor, fontStyle: 'italic' },
    link: { color: textColor, fontStyle: 'normal', textDecorationLine: 'underline' },
    h1: { color: textColor, fontSize: 22, fontWeight: '700', marginTop: 8, marginBottom: 4 },
    h2: { color: textColor, fontSize: 20, fontWeight: '700', marginTop: 8, marginBottom: 4 },
    h3: { color: textColor, fontSize: 18, fontWeight: '700', marginTop: 6, marginBottom: 4 },
    h4: { color: textColor, fontSize: 16, fontWeight: '700', marginTop: 6, marginBottom: 4 },
    h5: { color: textColor, fontSize: 15, fontWeight: '700', marginTop: 4, marginBottom: 2 },
    h6: { color: textColor, fontSize: 14, fontWeight: '700', marginTop: 4, marginBottom: 2 },
    // Override the library defaults that set italic + light weight on codespan.
    codespan: {
      color: textColor,
      backgroundColor: codeBackground,
      fontFamily: 'Menlo',
      fontSize: 14,
      fontStyle: 'normal',
      fontWeight: '400',
    },
    code: {
      backgroundColor: codeBackground,
      borderRadius: 8,
      padding: 12,
      marginVertical: 4,
    },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: borderColor,
      paddingLeft: 12,
      marginVertical: 4,
    },
    list: { marginVertical: 2 },
    li: { color: textColor, fontSize: 16, lineHeight: 24 },
    hr: {
      borderBottomWidth: 1,
      borderBottomColor: borderColor,
      marginVertical: 8,
    },
    table: { borderColor, borderWidth: 1, borderRadius: 6, marginVertical: 4 },
    tableRow: { borderColor },
    tableCell: { borderColor },
    strikethrough: { color: mutedTextColor, textDecorationLine: 'line-through' },
  };
}

// The library's default `Renderer` renders code blocks with the `em` text
// style (italic) and renders tables with fixed column widths that frequently
// overflow the screen with no way to scroll within a chat bubble. We subclass
// it to render code blocks in a monospace font and to render tables with our
// own layout that scales to the container.
class MarkdownRenderer extends Renderer {
  private readonly palette: MarkdownPalette;

  constructor(palette: MarkdownPalette) {
    super();
    this.palette = palette;
  }

  // eslint-disable-next-line eslint/max-params -- signature fixed by react-native-marked's RendererInterface
  override code(
    text: string,
    _language: string | undefined,
    containerStyle: ViewStyle | undefined,
    _textStyle: TextStyle | undefined
  ): ReactNode {
    return (
      <ScrollView
        key={this.getKey()}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={containerStyle}
      >
        <Text
          selectable
          className="font-mono text-sm leading-5"
          // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant text color
          style={{ color: this.palette.textColor }}
        >
          {text}
        </Text>
      </ScrollView>
    );
  }

  // eslint-disable-next-line eslint/max-params -- signature fixed by react-native-marked's RendererInterface
  override table(
    header: ReactNode[][],
    rows: ReactNode[][][],
    tableStyle: ViewStyle | undefined,
    _rowStyle: ViewStyle | undefined,
    _cellStyle: ViewStyle | undefined
  ): ReactNode {
    let columnCount = header.length;
    for (const row of rows) {
      if (row.length > columnCount) {
        columnCount = row.length;
      }
    }

    return (
      <ScrollView key={this.getKey()} horizontal showsHorizontalScrollIndicator={false}>
        <View style={tableStyle}>
          <TableRow
            palette={this.palette}
            cells={header}
            columnCount={columnCount}
            isHeader
            isLastRow={rows.length === 0}
          />
          {rows.map((row, rowIdx) => (
            <TableRow
              key={rowIdx}
              palette={this.palette}
              cells={row}
              columnCount={columnCount}
              isLastRow={rowIdx === rows.length - 1}
            />
          ))}
        </View>
      </ScrollView>
    );
  }
}

const TABLE_COLUMN_MIN_WIDTH = 120;
const TABLE_COLUMN_TARGET_TOTAL_WIDTH = 320;

function getColumnWidth(columnCount: number): number {
  return Math.max(
    TABLE_COLUMN_MIN_WIDTH,
    Math.floor(TABLE_COLUMN_TARGET_TOTAL_WIDTH / Math.max(columnCount, 1))
  );
}

type TableRowProps = {
  palette: MarkdownPalette;
  cells: ReactNode[][];
  columnCount: number;
  isLastRow: boolean;
  isHeader?: boolean;
};

function TableRow({ palette, cells, columnCount, isLastRow, isHeader = false }: TableRowProps) {
  const columnWidth = getColumnWidth(columnCount);
  return (
    <View
      className="flex-row"
      // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant header background
      style={isHeader ? { backgroundColor: palette.codeBackground } : undefined}
    >
      {Array.from({ length: columnCount }, (_, colIdx) => (
        <TableCell
          key={colIdx}
          palette={palette}
          width={columnWidth}
          hasRightBorder={colIdx < columnCount - 1}
          hasBottomBorder={isHeader || !isLastRow}
        >
          {cells[colIdx] ?? []}
        </TableCell>
      ))}
    </View>
  );
}

type TableCellProps = {
  palette: MarkdownPalette;
  width: number;
  hasRightBorder: boolean;
  hasBottomBorder: boolean;
  children: ReactNode;
};

function TableCell({ palette, width, hasRightBorder, hasBottomBorder, children }: TableCellProps) {
  return (
    <View
      className="p-2"
      // eslint-disable-next-line react-native/no-inline-styles -- dynamic column width and per-variant border color
      style={{
        width,
        borderColor: palette.borderColor,
        borderRightWidth: hasRightBorder ? 1 : 0,
        borderBottomWidth: hasBottomBorder ? 1 : 0,
      }}
    >
      {children}
    </View>
  );
}

export function MarkdownText({ value, variant = 'assistant' }: Readonly<MarkdownTextProps>) {
  const colorScheme = useColorScheme();
  const colors = useThemeColors();

  const { styles, renderer, themeColors } = useMemo(() => {
    const palette = getPalette(variant, colors);
    return {
      styles: getMarkdownStyles(palette),
      renderer: new MarkdownRenderer(palette),
      themeColors: {
        text: palette.textColor,
        code: palette.textColor,
        link: palette.textColor,
        border: palette.borderColor,
      },
    };
  }, [variant, colors]);

  const elements = useMarkdown(value, {
    colorScheme,
    theme: { colors: themeColors },
    styles,
    renderer,
  });

  return (
    <View>
      {elements.map((node, index) => (
        <Fragment key={getNodeKey(node, index)}>{node}</Fragment>
      ))}
    </View>
  );
}

// Prefer the element's own key when `react-native-marked` provides one so that
// streamed updates (token-by-token appends) keep stable identities for nodes
// that haven't changed.
function getNodeKey(node: ReactNode, index: number): string | number {
  if (node && typeof node === 'object' && 'key' in node && node.key != null) {
    return node.key;
  }
  return index;
}
