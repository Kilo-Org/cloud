/* eslint-disable max-lines -- modal zoom keeps its gesture and table layout coupled in one component */
import { Table2, X } from 'lucide-react-native';
import {
  type ComponentRef,
  type ComponentType,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type LayoutChangeEvent,
  Modal,
  Pressable,
  type Text as RNText,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
  ScrollView,
} from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { moveA11yFocus } from '@/lib/a11y/announce';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { extractNodeText, linearRowLabel } from './markdown-a11y';
import { type MarkdownPalette } from './markdown-palette';

const MODAL_COLUMN_MIN_WIDTH = 148;
const MODAL_HORIZONTAL_PADDING = 16;

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const ZOOM_DEFAULT = 1;

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

function pluralizeCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTableSummary(columnCount: number, rowCount: number): string {
  return `${pluralizeCount(columnCount, 'column', 'columns')} · ${pluralizeCount(
    rowCount,
    'row',
    'rows'
  )}`;
}

function formatChipAccessibilityLabel(columnCount: number, rowCount: number): string {
  return `Table, ${pluralizeCount(columnCount, 'column', 'columns')}, ${pluralizeCount(
    rowCount,
    'row',
    'rows'
  )}, opens full screen`;
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

  // Column titles, flattened to spoken text once so every body row reuses them.
  const headerTexts = header.map(node => extractNodeText(node));

  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [natural, setNatural] = useState<{ width: number; height: number } | undefined>(undefined);
  const scale = useSharedValue(ZOOM_DEFAULT);
  const savedScale = useSharedValue(ZOOM_DEFAULT);
  const session = useSharedValue(0);
  const gestureSession = useSharedValue(0);
  const verticalRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const horizontalRef = useRef<ComponentRef<typeof ScrollView>>(null);
  // The modal header announces as a header and receives focus after the native
  // modal finishes presenting (onShow) so screen-reader users land on the table
  // title instead of the first cell.
  const titleRef = useRef<RNText | null>(null);

  // RNGH types an external gesture ref as RefObject<ComponentType> (see
  // node_modules/react-native-gesture-handler/lib/typescript/handlers/gestures/gesture.d.ts:5),
  // which a host-instance ref does not satisfy, while at runtime it only reads
  // `handlerTag` off the ref object. One cast, here, is the whole workaround.
  const scrollGestureRefs = [verticalRef, horizontalRef] as unknown as RefObject<ComponentType>[];

  const applyZoom = useCallback(
    (next: number, gestureGeneration: number) => {
      if (gestureGeneration === session.value) {
        setZoom(next);
      }
    },
    [session]
  );

  useEffect(() => {
    if (!open) {
      setZoom(ZOOM_DEFAULT);
      scale.value = ZOOM_DEFAULT;
      savedScale.value = ZOOM_DEFAULT;
    }
  }, [open, savedScale, scale, session]);

  // Natural (unscaled) table size — a transform does not change layout, so this
  // measurement stays valid at every zoom level. Epsilon guard stops a re-render loop.
  const handleTableLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setNatural(prev =>
      prev !== undefined &&
      Math.abs(prev.width - width) < 0.5 &&
      Math.abs(prev.height - height) < 0.5
        ? prev
        : { width, height }
    );
  }, []);

  const sizerStyle =
    natural === undefined || natural.width <= 0 || natural.height <= 0
      ? undefined
      : { width: natural.width * zoom, height: natural.height * zoom };

  // eslint-disable-next-line new-cap -- RNGH's gesture builder API is Gesture.Pinch().
  const pinch = Gesture.Pinch()
    .simultaneousWithExternalGesture(...scrollGestureRefs)
    .onBegin(() => {
      gestureSession.value = session.value;
    })
    .onUpdate(e => {
      if (gestureSession.value === session.value) {
        const next = savedScale.value * e.scale;
        scale.value = Number.isFinite(next)
          ? Math.min(Math.max(next, ZOOM_MIN), ZOOM_MAX)
          : ZOOM_DEFAULT;
      }
    })
    .onEnd(() => {
      if (gestureSession.value !== session.value) {
        return;
      }
      const next = Number.isFinite(scale.value)
        ? Math.min(Math.max(scale.value, ZOOM_MIN), ZOOM_MAX)
        : ZOOM_DEFAULT;
      scale.value = next;
      savedScale.value = next;
      scheduleOnRN(applyZoom, next, gestureSession.value);
    });

  // eslint-disable-next-line new-cap -- RNGH's gesture builder API is Gesture.Tap().
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .simultaneousWithExternalGesture(...scrollGestureRefs)
    .onBegin(() => {
      gestureSession.value = session.value;
    })
    .onEnd(() => {
      if (gestureSession.value !== session.value) {
        return;
      }
      scale.value = ZOOM_DEFAULT;
      savedScale.value = ZOOM_DEFAULT;
      scheduleOnRN(applyZoom, ZOOM_DEFAULT, gestureSession.value);
    });

  // eslint-disable-next-line new-cap -- RNGH's gesture builder API is Gesture.Race().
  const zoomGesture = Gesture.Race(doubleTap, pinch);

  const tableStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <>
      <Pressable
        onPress={() => {
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={formatChipAccessibilityLabel(columnCount, rows.length)}
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
        // Best-effort focus after native presentation; moveA11yFocus is a no-op
        // when the title handle is not mounted yet, so no retry loop is needed.
        onShow={() => {
          moveA11yFocus(titleRef);
        }}
        onRequestClose={() => {
          session.value += 1;
          setOpen(false);
        }}
      >
        <View className="flex-1 bg-background">
          <View
            className="flex-row items-center justify-between border-b border-border bg-background px-4"
            style={{ paddingTop: insets.top, height: insets.top + 56 }}
          >
            <Text
              ref={titleRef}
              accessibilityRole="header"
              className="text-lg font-semibold text-foreground"
            >
              Table
            </Text>
            <Pressable
              onPress={() => {
                session.value += 1;
                setOpen(false);
              }}
              className="h-10 w-10 items-center justify-center rounded-md bg-secondary active:opacity-70"
              accessibilityLabel="Close table"
              accessibilityRole="button"
              hitSlop={8}
            >
              <X size={20} color={colors.foreground} />
            </Pressable>
          </View>
          {/* RNGH gestures need their own root inside an RN Modal — see image-viewer-modal.tsx. */}
          <GestureHandlerRootView className="flex-1">
            <ScrollView
              ref={verticalRef}
              className="flex-1"
              // eslint-disable-next-line react-native/no-inline-styles -- padding must be combined after contentContainerClassName removal
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }}
            >
              <ScrollView ref={horizontalRef} horizontal showsHorizontalScrollIndicator>
                <GestureDetector gesture={zoomGesture}>
                  {/* Sizer: gives both scrollers the zoomed extent. The table keeps its
                      natural layout size (self-start) and is scaled from its top-left. */}
                  {/* eslint-disable-next-line react-native/no-inline-styles -- dynamic measured sizer dimensions */}
                  <View style={sizerStyle}>
                    <Animated.View
                      className="self-start"
                      onLayout={handleTableLayout}
                      // eslint-disable-next-line react-native/no-inline-styles -- animated transform + transformOrigin
                      style={[tableStyle, { transformOrigin: 'top left' }]}
                    >
                      <View
                        className="self-start overflow-hidden rounded-md border"
                        // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant colors
                        style={{
                          borderColor: palette.borderColor,
                          backgroundColor: palette.surfaceColor,
                        }}
                      >
                        <TableRow
                          palette={palette}
                          cells={header}
                          columnCount={columnCount}
                          columnWidth={columnWidth}
                          isHeader
                          isLastRow={rows.length === 0}
                          headerTexts={headerTexts}
                        />
                        {rows.map((row, rowIdx) => (
                          <TableRow
                            key={rowIdx}
                            palette={palette}
                            cells={row}
                            columnCount={columnCount}
                            columnWidth={columnWidth}
                            isLastRow={rows.length - 1 === rowIdx}
                            headerTexts={headerTexts}
                          />
                        ))}
                      </View>
                    </Animated.View>
                  </View>
                </GestureDetector>
              </ScrollView>
            </ScrollView>
          </GestureHandlerRootView>
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
  headerTexts: string[];
};

// The export keeps the direct row semantics testable without mounting the modal tree.
export function TableRow({
  palette,
  cells,
  columnCount,
  columnWidth,
  isLastRow,
  isHeader = false,
  headerTexts,
}: TableRowProps) {
  // The label is the linear reading fallback for the row: the header row
  // announces the column titles, and every body row announces "header: cell"
  // pairs in reading order. The row container is deliberately NOT an
  // accessibility element, so nested Markdown links and image buttons stay
  // independently reachable; the label lives on a 1px invisible accessible
  // sibling that both screen readers can focus (an accessible container
  // would shadow the nested controls on iOS).
  const cellTexts = cells.map(node => extractNodeText(node));
  const rowLabel = linearRowLabel(isHeader ? [] : headerTexts, cellTexts);
  return (
    <View
      className="flex-row"
      // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant header background
      style={isHeader ? { backgroundColor: palette.codeBackground } : undefined}
    >
      <View
        accessible
        accessibilityLabel={rowLabel}
        className="absolute h-px w-px overflow-hidden"
        pointerEvents="none"
      />
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
