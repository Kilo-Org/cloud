import { type ReactNode, useMemo } from 'react';
import {
  ScrollView,
  Text,
  type TextStyle,
  useColorScheme,
  View,
  type ViewStyle,
} from 'react-native';
import { Renderer, useMarkdown } from 'react-native-marked';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import {
  getMarkdownStyles,
  getPalette,
  type MarkdownPalette,
  type MarkdownVariant,
} from './markdown-palette';

type MarkdownTextProps = {
  value: string;
  variant?: MarkdownVariant;
};

// The library's default `Renderer` renders code blocks with the `em` text
// style (italic) and renders tables with fixed column widths that frequently
// overflow the screen with no way to scroll within a chat bubble. We subclass
// it to render code blocks in a monospace font and to render tables with our
// own layout that scales to the container.
//
// Notes on horizontal scrolling for code blocks: the default library renders
// code inside a horizontal ScrollView, but on RN 0.83 Fabric a horizontal
// ScrollView inside a width-constrained bubble produces spurious vertical
// height (measured up to ~10x the actual content height, growing as sibling
// messages re-rendered the list). We render code as a plain wrapping Text
// instead — readable in chat, and it avoids the Fabric measurement bug.
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
      <View key={this.getKey()} style={containerStyle}>
        <Text
          selectable
          className="font-mono text-sm leading-5"
          // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant text color
          style={{ color: this.palette.textColor }}
        >
          {text}
        </Text>
      </View>
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
              isLastRow={rows.length - 1 === rowIdx}
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

  const { styles, renderer, theme } = useMemo(() => {
    const palette = getPalette(variant, colors);
    return {
      styles: getMarkdownStyles(palette),
      renderer: new MarkdownRenderer(palette),
      theme: {
        colors: {
          text: palette.textColor,
          code: palette.textColor,
          link: palette.textColor,
          border: palette.borderColor,
        },
      },
    };
  }, [variant, colors]);

  const elements = useMarkdown(value, {
    colorScheme,
    theme,
    styles,
    renderer,
  });

  return <View>{elements}</View>;
}
