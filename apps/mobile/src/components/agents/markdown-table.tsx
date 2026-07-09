import { Table2, X } from 'lucide-react-native';
import { type ReactNode, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { type MarkdownPalette } from './markdown-palette';

const MODAL_COLUMN_MIN_WIDTH = 148;
const MODAL_HORIZONTAL_PADDING = 16;

type MarkdownTableProps = {
  palette: MarkdownPalette;
  header: ReactNode[][];
  rows: ReactNode[][][];
};

function getColumnCount(header: ReactNode[][], rows: ReactNode[][][]): number {
  let columnCount = header.length;
  for (const row of rows) {
    if (row.length > columnCount) {
      columnCount = row.length;
    }
  }
  return columnCount;
}

function formatTableSummary(columnCount: number, rowCount: number): string {
  const columns = columnCount === 1 ? 'column' : 'columns';
  const rows = rowCount === 1 ? 'row' : 'rows';
  return `${columnCount} ${columns} · ${rowCount} ${rows}`;
}

// Markdown tables never fit inside a chat bubble: a horizontal ScrollView in a
// width-constrained bubble both mis-measures its height on Fabric (overlapping
// messages) and fights the swipe-to-reply pan gesture. Instead we render a
// compact "View table" chip inline and show the full table in a modal, where
// it can scroll both ways with the whole screen available.
export function MarkdownTable({ palette, header, rows }: Readonly<MarkdownTableProps>) {
  const [open, setOpen] = useState(false);
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();

  const columnCount = getColumnCount(header, rows);
  const columnWidth = Math.max(
    MODAL_COLUMN_MIN_WIDTH,
    Math.floor((windowWidth - MODAL_HORIZONTAL_PADDING * 2) / Math.max(columnCount, 1))
  );

  return (
    <>
      <Pressable
        onPress={() => {
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel="View table"
        className="my-1 flex-row items-center gap-2.5 self-start rounded-lg border px-3 py-2 active:opacity-70"
        // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant colors
        style={{ backgroundColor: palette.codeBackground, borderColor: palette.borderColor }}
      >
        <Table2 size={18} color={palette.textColor} />
        <View>
          {/* eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant text color */}
          <Text className="text-sm font-medium" style={{ color: palette.textColor }}>
            View table
          </Text>
          {/* eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant text color */}
          <Text className="text-xs" style={{ color: palette.mutedTextColor }}>
            {formatTableSummary(columnCount, rows.length)}
          </Text>
        </View>
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        onRequestClose={() => {
          setOpen(false);
        }}
      >
        <View className="flex-1 bg-background">
          <View
            className="flex-row items-center justify-between border-b border-border bg-background px-4"
            style={{ paddingTop: insets.top, height: insets.top + 56 }}
          >
            <Text className="text-lg font-semibold text-foreground">Table</Text>
            <Pressable
              onPress={() => {
                setOpen(false);
              }}
              className="h-10 w-10 items-center justify-center rounded-md bg-secondary active:opacity-70"
              accessibilityRole="button"
              accessibilityLabel="Close table"
            >
              <X size={20} color={colors.foreground} />
            </Pressable>
          </View>
          <ScrollView
            className="flex-1"
            contentContainerClassName="p-4"
            contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View
                className="self-start overflow-hidden rounded-md border"
                // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant colors
                style={{ borderColor: palette.borderColor, backgroundColor: palette.surfaceColor }}
              >
                <TableRow
                  palette={palette}
                  cells={header}
                  columnCount={columnCount}
                  columnWidth={columnWidth}
                  isHeader
                  isLastRow={rows.length === 0}
                />
                {rows.map((row, rowIdx) => (
                  <TableRow
                    key={rowIdx}
                    palette={palette}
                    cells={row}
                    columnCount={columnCount}
                    columnWidth={columnWidth}
                    isLastRow={rows.length - 1 === rowIdx}
                  />
                ))}
              </View>
            </ScrollView>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

type TableRowProps = {
  palette: MarkdownPalette;
  cells: ReactNode[][];
  columnCount: number;
  columnWidth: number;
  isLastRow: boolean;
  isHeader?: boolean;
};

function TableRow({
  palette,
  cells,
  columnCount,
  columnWidth,
  isLastRow,
  isHeader = false,
}: TableRowProps) {
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
