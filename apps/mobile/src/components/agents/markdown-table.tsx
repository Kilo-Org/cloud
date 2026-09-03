/* eslint-disable max-lines -- modal zoom keeps its gesture and table layout coupled in one component */
import { Table2, X } from '@/components/ui/icons';
import {
  type ComponentRef,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Modal,
  Pressable,
  type Text as RNText,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
  ScrollView,
} from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMarkdown } from 'react-native-marked';
import { scheduleOnRN } from 'react-native-worklets';

import { withRtlWritingDirection } from '@/lib/rtl-text';
import { moveA11yFocus } from '@/lib/a11y/announce';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { subscribePrivacyCover } from '@/lib/privacy-cover-events';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { CenteredState } from '@/components/centered-state';
import { StateSurface } from '@/components/centered-state-surface';

import { containsPressable, extractNodeText, linearRowLabel } from './markdown-a11y';
import { getMarkdownStyles, type MarkdownPalette } from './markdown-palette';
import {
  type MarkdownLinkLongPressHandler,
  type MarkdownLinkPressHandler,
  MarkdownRenderer,
} from './markdown-renderer';

const MODAL_COLUMN_MIN_WIDTH = 148;
const MODAL_HORIZONTAL_PADDING = 16;

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const ZOOM_DEFAULT = 1;

type MarkdownTableProps = {
  palette: MarkdownPalette;
  /** The table token's raw markdown source, parsed only while the modal is open. */
  raw?: string;
  tableKey: string;
  columnCount: number;
  rowCount: number;
  selectable: boolean;
  /** Parser-built cell trees for a nested table (the renderer fallback path). */
  header?: ReactNode[][];
  /** Parser-built row trees for a nested table (the renderer fallback path). */
  rows?: ReactNode[][][];
  onLongPressLink?: MarkdownLinkLongPressHandler;
  onPressLink?: MarkdownLinkPressHandler;
};

function formatCount(count: number, key: 'columnCount' | 'rowCount'): string {
  const unit =
    key === 'columnCount'
      ? i18n.t('agentChat.markdownTable.columnCount', { count })
      : i18n.t('agentChat.markdownTable.rowCount', { count });
  return `${formatNumber(count, i18n.language)} ${unit}`;
}

function formatTableSummary(columnCount: number, rowCount: number): string {
  return `${formatCount(columnCount, 'columnCount')} · ${formatCount(rowCount, 'rowCount')}`;
}

function formatChipAccessibilityLabel(columnCount: number, rowCount: number): string {
  return `${i18n.t('agentChat.markdownTable.title')}, ${formatCount(columnCount, 'columnCount')}, ${formatCount(rowCount, 'rowCount')}, ${i18n.t('agentChat.markdownTable.opensFullScreen')}`;
}

// Markdown tables never fit inside a chat bubble: a horizontal ScrollView in a
// width-constrained bubble both mis-measures its height on Fabric (overlapping
// messages) and fights the swipe-to-reply pan gesture. Instead we render a
// compact "View table" chip inline and show the full table in a modal, where
// it can scroll both ways with the whole screen available. The cell tree is
// parsed only when the modal opens (MarkdownTableBody), so a streamed table
// stays cheap behind the chip.

export function MarkdownTable({
  palette,
  raw,
  tableKey,
  columnCount,
  rowCount,
  selectable,
  header,
  rows,
  onLongPressLink,
  onPressLink,
}: Readonly<MarkdownTableProps>) {
  const [open, setOpen] = useState(false);
  const colors = useThemeColors();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

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
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- RNGH's external ref type is a real mismatch with a host-instance ref; only `handlerTag` is read at runtime, so a local type fix is not possible.
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

  // Close when the privacy cover fires (app backgrounds on a covered route):
  // a native Modal renders above the overlay, so it must close itself.
  useEffect(
    () =>
      subscribePrivacyCover(() => {
        setOpen(false);
      }),
    []
  );

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
    transformOrigin: 'top left',
  }));
  const scrollContentStyle = { padding: 16, paddingBottom: insets.bottom + 16 };

  function renderTableContent(cells: ReactNode) {
    return (
      <ScrollView ref={verticalRef} className="flex-1" contentContainerStyle={scrollContentStyle}>
        <ScrollView ref={horizontalRef} horizontal showsHorizontalScrollIndicator>
          <GestureDetector gesture={zoomGesture}>
            <View style={sizerStyle}>
              <Animated.View className="self-start" onLayout={handleTableLayout} style={tableStyle}>
                {cells}
              </Animated.View>
            </View>
          </GestureDetector>
        </ScrollView>
      </ScrollView>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => {
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={formatChipAccessibilityLabel(columnCount, rowCount)}
        testID={tableKey}
        className="my-1 flex-row items-center gap-2.5 self-start rounded-lg border px-3 py-2 active:opacity-70"
        // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant colors
        style={{ backgroundColor: palette.codeBackground, borderColor: palette.borderColor }}
      >
        <Table2 size={18} color={palette.textColor} />
        <View>
          {/* eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant text color */}
          <Text
            className="text-sm font-medium"
            style={withRtlWritingDirection({ color: palette.textColor })}
          >
            {t('agentChat.markdownTable.viewTable')}
          </Text>
          {/* eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant text color */}
          <Text
            className="text-xs"
            style={withRtlWritingDirection({ color: palette.mutedTextColor })}
          >
            {formatTableSummary(columnCount, rowCount)}
          </Text>
        </View>
      </Pressable>

      {open ? (
        <Modal
          visible
          backdropColor={colors.background}
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
          <StateSurface className="flex-1 bg-background">
            <View
              className="flex-row items-center justify-between border-b border-border bg-background px-4"
              style={{ paddingTop: insets.top, height: insets.top + 56 }}
            >
              <Text
                ref={titleRef}
                accessibilityRole="header"
                className="text-lg font-semibold text-foreground"
                style={withRtlWritingDirection(undefined)}
              >
                {t('agentChat.markdownTable.title')}
              </Text>
              <Pressable
                onPress={() => {
                  session.value += 1;
                  setOpen(false);
                }}
                className="h-10 w-10 items-center justify-center rounded-md bg-secondary active:opacity-70"
                accessibilityLabel={t('agentChat.markdownTable.close')}
                accessibilityRole="button"
                hitSlop={8}
              >
                <X size={20} color={colors.foreground} />
              </Pressable>
            </View>
            {/* RNGH gestures need their own root inside an RN Modal — see image-viewer-modal.tsx. */}
            <GestureHandlerRootView className="flex-1">
              {raw !== undefined ? (
                <MarkdownTableBody
                  palette={palette}
                  raw={raw}
                  columnCount={columnCount}
                  rowCount={rowCount}
                  selectable={selectable}
                  onLongPressLink={onLongPressLink}
                  onPressLink={onPressLink}
                >
                  {renderTableContent}
                </MarkdownTableBody>
              ) : (
                renderTableContent(
                  <MarkdownTableCells
                    palette={palette}
                    header={header ?? []}
                    rows={rows ?? []}
                    columnCount={columnCount}
                  />
                )
              )}
            </GestureHandlerRootView>
          </StateSurface>
        </Modal>
      ) : null}
    </>
  );
}

type MarkdownTableCellsProps = {
  palette: MarkdownPalette;
  header: ReactNode[][];
  rows: ReactNode[][][];
  columnCount: number;
};

// A nested table (inside a blockquote or list item) is not extracted by
// splitMarkdownTables, so the base MarkdownRenderer.table() fallback already
// built these cell trees. Render them directly here with TableRow instead of
// re-parsing raw, reusing MarkdownTableBody's column-width formula.
function MarkdownTableCells({
  palette,
  header,
  rows,
  columnCount,
}: Readonly<MarkdownTableCellsProps>) {
  const { width: windowWidth } = useWindowDimensions();
  const columnWidth = Math.max(
    MODAL_COLUMN_MIN_WIDTH,
    Math.floor((windowWidth - MODAL_HORIZONTAL_PADDING * 2) / Math.max(columnCount, 1))
  );
  const headerTexts = header.map(node => extractNodeText(node));
  return (
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
  );
}

type MarkdownTableBodyProps = {
  children: (cells: ReactNode) => ReactElement;
  palette: MarkdownPalette;
  raw: string;
  columnCount: number;
  rowCount: number;
  selectable: boolean;
  onLongPressLink?: MarkdownLinkLongPressHandler;
  onPressLink?: MarkdownLinkPressHandler;
};

// The body runs only while the modal is open, so useMarkdown (and the cell
// parse it drives) never runs while the table is just a chip. It keeps the
// last good cells while `raw` changes so a streaming update re-parses without
// flashing the wait or empty states, and leaves the parent's chrome and zoom
// untouched.
function MarkdownTableBody({
  children,
  palette,
  raw,
  columnCount,
  rowCount,
  selectable,
  onLongPressLink,
  onPressLink,
}: Readonly<MarkdownTableBodyProps>) {
  const { t } = useTranslation();
  const colorScheme = useColorScheme();
  const { width: windowWidth } = useWindowDimensions();

  const columnWidth = Math.max(
    MODAL_COLUMN_MIN_WIDTH,
    Math.floor((windowWidth - MODAL_HORIZONTAL_PADDING * 2) / Math.max(columnCount, 1))
  );

  const styles = useMemo(() => getMarkdownStyles(palette), [palette]);

  const theme = useMemo(
    () => ({
      colors: {
        text: palette.textColor,
        code: palette.textColor,
        link: palette.textColor,
        border: palette.borderColor,
      },
    }),
    [palette]
  );

  const renderer = useMemo(
    () =>
      new MarkdownTableBodyRenderer(palette, columnWidth, columnCount, selectable, {
        onLongPressLink,
        onPressLink,
      }),
    [palette, columnWidth, columnCount, selectable, onLongPressLink, onPressLink]
  );

  const elements = useMarkdown(raw, { colorScheme, theme, styles, renderer });

  // Keep the last good cells while `raw` changes with the modal open. A fresh
  // parse replaces them; a transient empty parse keeps the previous cells.
  const lastCellsRef = useRef<ReactNode[] | null>(null);
  if (elements.length > 0) {
    lastCellsRef.current = elements;
  }
  const cells = elements.length > 0 ? elements : lastCellsRef.current;

  if (cells !== null) {
    return children(cells);
  }

  if (rowCount === 0) {
    return (
      <CenteredState>
        <AccessibleStatus
          className="px-4 py-4 text-center"
          message={t('agentChat.markdownTable.empty')}
          tone="status"
        />
      </CenteredState>
    );
  }

  return children(
    <View className="flex-row items-center gap-3 px-4 py-4">
      <ActivityIndicator />
      <AccessibleStatus message={t('agentChat.markdownTable.loading')} tone="status" />
    </View>
  );
}

// Body-only renderer: the one place the cell tree is parsed, and only while
// the modal is open. `table()` returns the modal TableRow tree (not a chip),
// and returns null for a header with no rows so MarkdownTableBody can show the
// empty status. `headerTexts` is computed here from the nodes the library
// passes in, so the constructor never needs to know them.
// The export keeps the body table semantics testable without mounting the modal.
export class MarkdownTableBodyRenderer extends MarkdownRenderer {
  private readonly tablePalette: MarkdownPalette;
  private readonly columnWidth: number;
  private readonly columnCount: number;

  // eslint-disable-next-line eslint/max-params -- the slice contract fixes this five-arg grouping; the first three shape the table and the last two mirror MarkdownRenderer's constructor tail
  constructor(
    palette: MarkdownPalette,
    columnWidth: number,
    columnCount: number,
    selectable: boolean,
    handlers: {
      onLongPressLink?: MarkdownLinkLongPressHandler;
      onPressLink?: MarkdownLinkPressHandler;
    }
  ) {
    super(palette, selectable, handlers);
    this.tablePalette = palette;
    this.columnWidth = columnWidth;
    this.columnCount = columnCount;
  }

  // eslint-disable-next-line eslint/max-params -- signature fixed by react-native-marked's RendererInterface
  override table(
    header: ReactNode[][],
    rows: ReactNode[][][],
    _tableStyle?: ViewStyle,
    _rowStyle?: ViewStyle,
    _cellStyle?: ViewStyle
  ): ReactNode {
    if (rows.length === 0) {
      return null;
    }
    const headerTexts = header.map(node => extractNodeText(node));
    return (
      <View
        className="self-start overflow-hidden rounded-md border"
        // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant colors
        style={{
          borderColor: this.tablePalette.borderColor,
          backgroundColor: this.tablePalette.surfaceColor,
        }}
      >
        <TableRow
          palette={this.tablePalette}
          cells={header}
          columnCount={this.columnCount}
          columnWidth={this.columnWidth}
          isHeader
          isLastRow={rows.length === 0}
          headerTexts={headerTexts}
        />
        {rows.map((row, rowIdx) => (
          <TableRow
            key={rowIdx}
            palette={this.tablePalette}
            cells={row}
            columnCount={this.columnCount}
            columnWidth={this.columnWidth}
            isLastRow={rows.length - 1 === rowIdx}
            headerTexts={headerTexts}
          />
        ))}
      </View>
    );
  }
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
  // A row announces exactly one way, never both:
  //
  // - Plain row (no nested control): the linear label carries the whole row
  //   ("Header: cell, Header: cell") on a 1px invisible accessible sibling,
  //   and the cells leave the accessibility tree. Without hiding them the
  //   screen reader reads the row label AND every cell again.
  // - Row with a Markdown link or image: the cells stay reachable so those
  //   controls keep their own focus and tap target, and the linear label is
  //   dropped — an accessible container would shadow them on iOS.
  const cellTexts = cells.map(node => extractNodeText(node));
  const rowLabel = linearRowLabel(isHeader ? [] : headerTexts, cellTexts);
  const hasControls = containsPressable(cells);
  return (
    <View
      className="flex-row"
      // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant header background
      style={isHeader ? { backgroundColor: palette.codeBackground } : undefined}
    >
      {hasControls ? null : (
        <View
          accessible
          accessibilityLabel={rowLabel}
          className="absolute h-px w-px overflow-hidden"
          pointerEvents="none"
        />
      )}
      {Array.from({ length: columnCount }, (_, colIdx) => (
        <TableCell
          key={colIdx}
          palette={palette}
          width={columnWidth}
          hasRightBorder={colIdx < columnCount - 1}
          hasBottomBorder={isHeader || !isLastRow}
          hiddenFromA11y={!hasControls}
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
  /** True when the row's linear label already speaks this cell's content. */
  hiddenFromA11y: boolean;
  children: ReactNode;
};

function TableCell({
  palette,
  width,
  hasRightBorder,
  hasBottomBorder,
  hiddenFromA11y,
  children,
}: TableCellProps) {
  return (
    <View
      className="p-2"
      accessibilityElementsHidden={hiddenFromA11y}
      importantForAccessibility={hiddenFromA11y ? 'no-hide-descendants' : 'auto'}
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
