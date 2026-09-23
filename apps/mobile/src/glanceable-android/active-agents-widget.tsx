/* eslint-disable max-lines -- every size bucket and every surface composition shares this one widget layout module */
/* eslint-disable react-native/no-inline-styles -- react-native-android-widget primitives take style objects; NativeWind className is unavailable in the widget host */

'use no memo';

// Metro turns a static image import into the asset id the widget host resolves,
// the same value `require` would give. Imported rather than required so vitest
// can stand in for the binary.
import LOGO from '../../assets/images/logo-widget.png';
import {
  FlexWidget,
  type HexColor,
  ImageWidget,
  TextWidget,
  type WidgetInfo,
  type WidgetRepresentation,
} from 'react-native-android-widget';

import { type GlanceableCountKind } from '@/lib/glanceable/presentation';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import { type AndroidWidgetProps } from './widget-props';

export const WIDGET_NAME = 'ActiveAgentsWidget';

/**
 * Below this width (dp) a short cell stacks its rows instead of running them.
 *
 * Two cells wide reports about 150–190 dp and three cells about 230–280 dp, so
 * the split sits between them. A tighter bound let a two-cell cell take the
 * row of three states and clip the last one.
 */
const COMPACT_MAX_WIDTH_DP = 210;
/** At or above this width (dp) every state in the row can carry its label. */
const ROW_LABEL_MIN_WIDTH_DP = 300;
/**
 * At or above this height (dp) the mark sits above the rows and they own the
 * full width; below it the mark sits beside them.
 *
 * One cell tall lands anywhere from 40 dp to about 110 dp depending on the
 * device and the launcher's grid, and two cells tall starts around 150 dp, so
 * the split sits between them. A tighter bound let a one-cell cell take the
 * stacked layout and clip its last row.
 */
const ROW_MAX_HEIGHT_DP = 130;
/**
 * At or above this height (dp) the cell is the nightstand card: the mark, the
 * three counts, and the newest-result footer.
 *
 * A four-cell-tall widget reports roughly 240–300 dp, and the tallest three-cell
 * layout stays under 220 dp, so the split sits between them. The widget config's
 * preferred cell is four tall, and `maxResizeHeight` has to reach past this
 * bound or a four-cell height would clamp and the bucket would never render.
 */
const LARGE_MIN_HEIGHT_DP = 220;

type Palette = {
  background: HexColor;
  foreground: HexColor;
  muted: HexColor;
  /** Three states, three colors — the same vocabulary the iOS surfaces draw. */
  needsInput: HexColor;
  running: HexColor;
};

// The app's own palette, not a widget-local one: a Home Screen card that does
// not match the app it opens reads as a different product.
const LIGHT: Palette = {
  background: lightColors.background,
  foreground: lightColors.foreground,
  muted: lightColors.mutedForeground,
  needsInput: lightColors.warn,
  running: lightColors.good,
};

const DARK: Palette = {
  background: darkColors.background,
  foreground: darkColors.foreground,
  muted: darkColors.mutedForeground,
  needsInput: darkColors.warn,
  running: darkColors.good,
};

// This function is evaluated only through `renderActiveAgentsWidget` and the
// library's `buildWidgetTree`. Everything it references is explicit so the
// React Compiler is disabled ("use no memo") and the widget host can re-evaluate
// the source. Translated copy arrives through `props`; the English fallbacks
// below only render while the gallery placeholder has no snapshot props.

type Size = 'compact' | 'row' | 'stack' | 'large';

/**
 * The size bucket, whether a `row` cell is wide enough for its labels, and the
 * reading direction. The library's flex engine has no direction of its own, so
 * every row reverses its own children and every column flips its alignment.
 */
type Shape = { size: Size; rowLabels: boolean; rtl: boolean };

function shapeOf(info: WidgetInfo, rtl: boolean): Shape {
  // Height first: a cell tall enough for the nightstand card takes it whatever
  // its width, and the three counts then own a column of their own.
  if (info.height >= LARGE_MIN_HEIGHT_DP) {
    return { size: 'large', rowLabels: true, rtl };
  }
  // A narrow cell that is tall enough still stacks, because the rows then own
  // the full width. Beside the mark they truncated their labels.
  if (info.height >= ROW_MAX_HEIGHT_DP) {
    return { size: 'stack', rowLabels: true, rtl };
  }
  if (info.width < COMPACT_MAX_WIDTH_DP) {
    return { size: 'compact', rowLabels: true, rtl };
  }
  // Three cells wide fit three counts but not three labels, so the ranked
  // state keeps its word and the other two show as a marker and a number.
  return { size: 'row', rowLabels: info.width >= ROW_LABEL_MIN_WIDTH_DP, rtl };
}

/** The edge a column's content starts from. */
function startEdge(rtl: boolean): 'flex-start' | 'flex-end' {
  return rtl ? 'flex-end' : 'flex-start';
}

/** Lay a row's children out in reading order. */
function inReadingOrder(children: React.ReactNode[], rtl: boolean): React.ReactNode[] {
  return rtl ? children.toReversed() : children;
}

function dotColor(kind: GlanceableCountKind, palette: Palette): HexColor {
  if (kind === 'needsInput') {
    return palette.needsInput;
  }
  if (kind === 'running') {
    return palette.running;
  }
  return kind === 'scheduled' ? palette.muted : palette.foreground;
}

/**
 * The state marker. Needs-input and working are filled, idle is an outline —
 * the shapes differ as well as the colors, so the three states stay apart for a
 * user who cannot tell orange from green.
 */
function stateDot(kind: GlanceableCountKind, palette: Palette, size: number) {
  const color = dotColor(kind, palette);
  return (
    <FlexWidget
      key="dot"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        ...(kind === 'idle' ? { borderWidth: 2, borderColor: color } : { backgroundColor: color }),
      }}
    />
  );
}

function logo(size: number) {
  return <ImageWidget image={LOGO} imageWidth={size} imageHeight={size} radius={size * 0.24} />;
}

/**
 * One count line: marker, count, label. Only the label color ranks the rows,
 * because a second font size in a three-row list reads as a mistake.
 */
type RowStyle = {
  palette: Palette;
  fontSize: number;
  showLabel: boolean;
  rtl: boolean;
};

function countRow(
  line: AndroidWidgetProps['countLines'][number],
  isPrimary: boolean,
  { palette, fontSize, showLabel, rtl }: RowStyle
) {
  return (
    <FlexWidget key={line.label} style={{ flexDirection: 'row', alignItems: 'center', flexGap: 6 }}>
      {inReadingOrder(
        [
          stateDot(line.kind, palette, fontSize < 14 ? 9 : 10),
          <TextWidget
            key="count"
            // oxlint-disable-next-line no-literal-copy/no-literal-copy -- an already-formatted number
            text={line.count}
            maxLines={1}
            style={{ color: palette.foreground, fontSize, fontWeight: 'bold' }}
          />,
          showLabel ? (
            <TextWidget
              key="label"
              text={line.label}
              maxLines={1}
              truncate="END"
              style={{
                color: isPrimary ? palette.foreground : palette.muted,
                fontSize,
              }}
            />
          ) : null,
        ],
        rtl
      )}
    </FlexWidget>
  );
}

/** The locked copy, drawn in place of the counts. */
function statusText(props: AndroidWidgetProps, palette: Palette) {
  return (
    <TextWidget
      text={props.statusLine ?? ''}
      maxLines={2}
      truncate="END"
      style={{ color: palette.muted, fontSize: 13 }}
    />
  );
}

/** The newest result itself: the state marker, the kind label, and the age. */
function newestResultRow(props: AndroidWidgetProps, palette: Palette, rtl: boolean) {
  if (
    props.newestResultKind === null ||
    props.newestResultLabel === null ||
    props.newestResultAgo === null
  ) {
    return null;
  }
  return (
    <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', flexGap: 6 }}>
      {inReadingOrder(
        [
          stateDot(props.newestResultKind, palette, 9),
          <TextWidget
            key="newest-label"
            text={props.newestResultLabel}
            maxLines={1}
            truncate="END"
            style={{ color: palette.foreground, fontSize: 13 }}
          />,
          <TextWidget
            key="newest-ago"
            text={props.newestResultAgo}
            maxLines={1}
            truncate="END"
            style={{ color: palette.muted, fontSize: 13 }}
          />,
        ],
        rtl
      )}
    </FlexWidget>
  );
}

/**
 * The large cell's third fact, at the bottom of the column.
 *
 * The rows stay whatever happens, so the footer only ever moves itself. Happy
 * shows the caption and the newest result; stale keeps the caption and swaps
 * the result for its own copy, because the counts are the last known ones and
 * only the third fact is in doubt — the same composition the iOS large card
 * draws. A cell with nothing to put under the caption has no footer at all.
 */
function newestResultFooter(props: AndroidWidgetProps, palette: Palette, rtl: boolean) {
  if (props.countLines.length === 0) {
    return null;
  }
  const body =
    props.statusLine === null ? (
      newestResultRow(props, palette, rtl)
    ) : (
      <TextWidget
        text={props.statusLine}
        maxLines={2}
        truncate="END"
        style={{ color: palette.muted, fontSize: 12 }}
      />
    );
  if (body === null) {
    return null;
  }
  return (
    <FlexWidget style={{ flexDirection: 'column', alignItems: startEdge(rtl), flexGap: 4 }}>
      {props.newestResultTitle === null ? null : (
        <TextWidget
          text={props.newestResultTitle}
          maxLines={1}
          truncate="END"
          style={{ color: palette.muted, fontSize: 11 }}
        />
      )}
      {body}
    </FlexWidget>
  );
}

// The mark alone, never a status line beside it: stale is the one status that
// carries both, and the iOS card drops the warning while counts show too. A
// line under the mark cost the rows their width and read as a fourth state.
// The large bucket is the one exception: it has a footer to put the copy in.
const MARK_SIZE_DP = { compact: 22, row: 28, stack: 26, large: 30 } satisfies Record<Size, number>;
/** A short cell runs its counts in a row, so the gap separates states, not lines. */
const COUNT_GAP_DP = { compact: 3, row: 14, stack: 6, large: 8 } satisfies Record<Size, number>;
/**
 * The newest-session line's reserved height, in every size bucket. The slot is
 * laid out whether or not it carries text, so work arriving (or an action's
 * progress line replacing the session line) never moves the count rows. The
 * large bucket composes its own newest-result footer instead of the slot, so
 * its entry is unused but keeps the lookup total over every size.
 */
const NEWEST_LINE_DP = {
  compact: 15,
  row: 16,
  stack: 18,
  large: 18,
} satisfies Record<Size, number>;
/** Smaller than the count labels above it: it is context, not a fourth state. */
const NEWEST_FONT_DP = {
  compact: 11,
  row: 12,
  stack: 12,
  large: 12,
} satisfies Record<Size, number>;
/** One action-row size in every bucket, so the rows themselves never reflow. */
const ACTION_FONT_DP = 12;
/**
 * The action chip's tap target, in dp. The chip is the widget's only in-place
 * action, so it holds Android's 48 dp minimum target; a 12 dp label with 4 dp
 * of vertical padding drew a ~25 dp chip and a hurried tap missed it. The
 * label is centered in the taller chip.
 */
const ACTION_TARGET_DP = 48;

function renderCounts(props: AndroidWidgetProps, palette: Palette, shape: Shape) {
  if (props.countLines.length === 0) {
    return statusText(props, palette);
  }
  const { size, rowLabels, rtl } = shape;
  const primaryLabel = props.primaryLabel;
  // Every state draws its own row, zeros included, so the rows hold still as
  // work moves between them and a narrow cell says as much as a wide one.
  const rows = props.countLines.map(line => {
    const isPrimary = line.label === primaryLabel;
    return countRow(line, isPrimary, {
      palette,
      fontSize: size === 'compact' || size === 'row' ? 13 : 15,
      showLabel: size !== 'row' || rowLabels || isPrimary,
      rtl,
    });
  });
  return (
    <FlexWidget
      style={{
        flexDirection: size === 'row' ? 'row' : 'column',
        alignItems: size === 'row' ? 'center' : startEdge(rtl),
        flexGap: COUNT_GAP_DP[size],
      }}
    >
      {size === 'row' ? inReadingOrder(rows, rtl) : rows}
    </FlexWidget>
  );
}

/**
 * The newest-session slot: the reserved line under the counts. Drawn as an
 * empty box when there is nothing to say, so the slot's height is reserved in
 * every size bucket and a loading→content swap cannot move the count rows.
 */
function newestSlot(props: AndroidWidgetProps, palette: Palette, shape: Shape) {
  const { size, rtl } = shape;
  return (
    <FlexWidget
      key="newest"
      style={{
        height: NEWEST_LINE_DP[size],
        width: 'match_parent',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: startEdge(rtl),
      }}
    >
      {props.newestLine === null ? null : (
        <TextWidget
          key="newest-text"
          text={props.newestLine}
          maxLines={1}
          truncate="END"
          style={{ color: palette.muted, fontSize: NEWEST_FONT_DP[size] }}
        />
      )}
    </FlexWidget>
  );
}

/**
 * One in-place action. A custom `clickAction` string makes the library launch a
 * headless task (`register.ts`) instead of opening the app, so the body keeps
 * its own `OPEN_URI` deep link and a tap beside the rows still opens Kilo.
 *
 * The chip is `ACTION_TARGET_DP` tall with the label centered: the target is
 * the whole chip, so the old padded-to-the-text height made taps miss.
 */
function actionRow(label: string, clickAction: 'approve' | 'new-agent', palette: Palette) {
  return (
    <FlexWidget
      key={clickAction}
      clickAction={clickAction}
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        height: ACTION_TARGET_DP,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: palette.muted,
        borderRadius: 8,
      }}
    >
      <TextWidget
        key="label"
        text={label}
        maxLines={1}
        style={{ color: palette.foreground, fontSize: ACTION_FONT_DP, fontWeight: 'bold' }}
      />
    </FlexWidget>
  );
}

/** Only the actions the state offers draw; a state with neither draws no row. */
function actionRows(props: AndroidWidgetProps, palette: Palette, rtl: boolean) {
  const rows: React.ReactNode[] = [];
  if (props.actions.approve) {
    rows.push(actionRow(props.actions.approveLabel, 'approve', palette));
  }
  if (props.actions.newAgent) {
    rows.push(actionRow(props.actions.newAgentLabel, 'new-agent', palette));
  }
  if (rows.length === 0) {
    return null;
  }
  return (
    <FlexWidget key="actions" style={{ flexDirection: 'row', alignItems: 'center', flexGap: 8 }}>
      {inReadingOrder(rows, rtl)}
    </FlexWidget>
  );
}

function renderSurface(props: AndroidWidgetProps, palette: Palette, shape: Shape) {
  const { size, rtl } = shape;
  // The nightstand cell: the mark on top, the counts in the middle of the
  // column, and the third fact on the bottom edge. With no footer the mark and
  // the status text centre the way the stack bucket composes, so the extra
  // height never draws a hole. The large cell mirrors the iOS `systemLarge`
  // card: it carries the counts and the footer, not the reserved newest-session
  // slot or the action row the shorter buckets draw.
  if (size === 'large') {
    const body = renderCounts(props, palette, shape);
    const footer = newestResultFooter(props, palette, rtl);
    return (
      <FlexWidget
        clickAction="OPEN_URI"
        clickActionData={{ uri: 'kiloapp:///cloud/sessions' }}
        accessibilityLabel={props.accessibilityLabel}
        style={{
          backgroundColor: palette.background,
          flexDirection: 'column',
          alignItems: startEdge(rtl),
          justifyContent: footer === null ? 'center' : 'space-between',
          flexGap: 12,
          height: 'match_parent',
          width: 'match_parent',
          padding: 14,
        }}
      >
        {logo(MARK_SIZE_DP[size])}
        {body}
        {footer}
      </FlexWidget>
    );
  }
  const body = (
    <FlexWidget
      key="body"
      style={{
        flexDirection: 'column',
        alignItems: startEdge(rtl),
        flexGap: 6,
        ...(size === 'stack' ? { width: 'match_parent' as const } : {}),
      }}
    >
      {renderCounts(props, palette, shape)}
      {newestSlot(props, palette, shape)}
      {actionRows(props, palette, rtl)}
    </FlexWidget>
  );
  // Short cells put the mark beside the counts; a tall cell stacks the mark on
  // top and lets the counts sit at the bottom, the same composition as the iOS
  // small family.
  if (size === 'stack') {
    return (
      <FlexWidget
        clickAction="OPEN_URI"
        clickActionData={{ uri: 'kiloapp:///cloud/sessions' }}
        accessibilityLabel={props.accessibilityLabel}
        style={{
          backgroundColor: palette.background,
          flexDirection: 'column',
          alignItems: startEdge(rtl),
          // Centred, not spread: with no affordance under the counts the block
          // is the mark and the rows, and spreading those two to the edges
          // leaves a hole between them.
          justifyContent: 'center',
          flexGap: 12,
          height: 'match_parent',
          width: 'match_parent',
          padding: 14,
        }}
      >
        {logo(MARK_SIZE_DP[size])}
        {body}
      </FlexWidget>
    );
  }
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: 'kiloapp:///cloud/sessions' }}
      accessibilityLabel={props.accessibilityLabel}
      style={{
        backgroundColor: palette.background,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: startEdge(rtl),
        flexGap: size === 'compact' ? 10 : 14,
        height: 'match_parent',
        width: 'match_parent',
        padding: 12,
      }}
    >
      {/* No array here: a wrapper element per slot would add a layout node. */}
      {rtl ? body : logo(MARK_SIZE_DP[size])}
      {rtl ? logo(MARK_SIZE_DP[size]) : body}
    </FlexWidget>
  );
}

/**
 * Distinct light and dark layouts through the library's theme callback. A
 * nightstand-tall cell tops the mark, hangs the counts in the middle and pins
 * the newest result to the bottom; a tall short cell stacks the three states
 * under the mark; a short wide cell runs them beside it in a row; a short
 * narrow cell stacks them beside it.
 */
export function renderActiveAgentsWidget(
  props: AndroidWidgetProps,
  info: WidgetInfo,
  rtl = false
): WidgetRepresentation {
  const shape = shapeOf(info, rtl);
  return {
    light: renderSurface(props, LIGHT, shape),
    dark: renderSurface(props, DARK, shape),
  };
}
