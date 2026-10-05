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
import { LAUNCHER_NEW_AGENT_URL } from '@/lib/launcher-surfaces';

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
/**
 * At or above this width (dp) every state in the row can carry its label.
 *
 * The row draws four states. With their labels they need about 410 dp beside
 * the mark, so a four-cell phone row (about 360 dp) clipped the last state,
 * which hid the only count when every agent was idle.
 */
export const ROW_LABEL_MIN_WIDTH_DP = 440;
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
export const LARGE_MIN_HEIGHT_DP = 220;

/**
 * Every label is pinned to its own dp size (`allowFontScaling={false}`), so the
 * system font scale cannot grow a count, a wake time, or the action chip's
 * caption past the box the layout reserved for it. A widget cell is a fixed
 * frame the host draws with no scrolling and no reflow, so scaled text pushed
 * the logo, the reserved newest-session line, and the 48 dp chip outside the
 * cell at Large system text. The user gets a larger surface by resizing the
 * widget, not by scaling the type inside a fixed one.
 */

type Palette = {
  background: HexColor;
  foreground: HexColor;
  muted: HexColor;
  /** Four states, four colors — the same vocabulary the iOS surfaces draw. */
  needsInput: HexColor;
  running: HexColor;
  scheduled: HexColor;
};

// The app's own palette, not a widget-local one: a Home Screen card that does
// not match the app it opens reads as a different product.
const LIGHT: Palette = {
  background: lightColors.background,
  foreground: lightColors.foreground,
  muted: lightColors.mutedForeground,
  needsInput: lightColors.warn,
  running: lightColors.good,
  // The muted-soft tone the session list's scheduled clock glyph uses, so the
  // widget's scheduled marker matches the row the user taps to get here.
  scheduled: lightColors.mutedSoft,
};

const DARK: Palette = {
  background: darkColors.background,
  foreground: darkColors.foreground,
  muted: darkColors.mutedForeground,
  needsInput: darkColors.warn,
  running: darkColors.good,
  scheduled: darkColors.mutedSoft,
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
type Shape = { size: Size; rowLabels: boolean; rtl: boolean; height: number };

function shapeOf(info: WidgetInfo, rtl: boolean): Shape {
  // Height first: a cell tall enough for the nightstand card takes it whatever
  // its width, and the three counts then own a column of their own.
  if (info.height >= LARGE_MIN_HEIGHT_DP) {
    return { size: 'large', rowLabels: true, rtl, height: info.height };
  }
  // A narrow cell that is tall enough still stacks, because the rows then own
  // the full width. Beside the mark they truncated their labels.
  if (info.height >= ROW_MAX_HEIGHT_DP) {
    return { size: 'stack', rowLabels: true, rtl, height: info.height };
  }
  if (info.width < COMPACT_MAX_WIDTH_DP) {
    return { size: 'compact', rowLabels: true, rtl, height: info.height };
  }
  // A phone-wide row fits the four counts but not four labels, so the ranked
  // state keeps its word and the other three show as a marker and a number.
  return {
    size: 'row',
    rowLabels: info.width >= ROW_LABEL_MIN_WIDTH_DP,
    rtl,
    height: info.height,
  };
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
  if (kind === 'scheduled') {
    return palette.scheduled;
  }
  return palette.foreground;
}

/**
 * The state marker. Needs-input, working, and scheduled are filled, idle is an
 * outline — the shapes differ as well as the colors, so the four states stay
 * apart for a user who cannot tell orange from green or from grey.
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
 * because a second font size in a three-row list reads as a mistake. A
 * scheduled row also carries the wake time in a slot reserved in every state.
 */
type RowStyle = {
  palette: Palette;
  size: Size;
  fontSize: number;
  showLabel: boolean;
  rtl: boolean;
  /** Preformatted wake from the props; only the scheduled row draws it. */
  scheduledAgo: string | null;
};

/**
 * The wake time's slot beside a scheduled count row.
 *
 * The box draws on the scheduled row whenever the rows draw — a zero row too —
 * so a wake the CLI reports for a session that had none earlier fills the slot
 * without moving the rows above or below it. The text is the preformatted wake
 * from `props.scheduledAgo`, and it is absent until a wake is known.
 */
function wakeSlot(scheduledAgo: string | null, palette: Palette, size: Size) {
  return (
    <FlexWidget
      key="wake"
      style={{
        height: WAKE_SLOT_DP[size],
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      {scheduledAgo === null ? null : (
        <TextWidget
          key="wake-text"
          text={scheduledAgo}
          maxLines={1}
          truncate="END"
          allowFontScaling={false}
          style={{ color: palette.muted, fontSize: WAKE_FONT_DP[size] }}
        />
      )}
    </FlexWidget>
  );
}

function countRow(
  line: AndroidWidgetProps['countLines'][number],
  isPrimary: boolean,
  { palette, size, fontSize, showLabel, rtl, scheduledAgo }: RowStyle
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
            allowFontScaling={false}
            style={{ color: palette.foreground, fontSize, fontWeight: 'bold' }}
          />,
          showLabel ? (
            <TextWidget
              key="label"
              text={line.label}
              maxLines={1}
              truncate="END"
              allowFontScaling={false}
              style={{
                color: isPrimary ? palette.foreground : palette.muted,
                fontSize,
              }}
            />
          ) : null,
          line.kind === 'scheduled' ? wakeSlot(scheduledAgo, palette, size) : null,
        ],
        rtl
      )}
    </FlexWidget>
  );
}

/** The locked copy, drawn in place of the counts. */
function statusText(props: AndroidWidgetProps, palette: Palette, maxLines: number) {
  return (
    <TextWidget
      text={props.statusLine ?? ''}
      maxLines={maxLines}
      truncate="END"
      allowFontScaling={false}
      style={{ color: palette.muted, fontSize: STATUS_FONT_DP }}
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
            allowFontScaling={false}
            style={{ color: palette.foreground, fontSize: 13 }}
          />,
          <TextWidget
            key="newest-ago"
            text={props.newestResultAgo}
            maxLines={1}
            truncate="END"
            allowFontScaling={false}
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
        allowFontScaling={false}
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
          allowFontScaling={false}
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
/**
 * The wake time beside a scheduled count row: a step down from the count it
 * annotates, and the height its slot reserves in every state so a wake the CLI
 * reports later cannot move the rows above or below it.
 */
const WAKE_FONT_DP = { compact: 11, row: 11, stack: 12, large: 12 } satisfies Record<Size, number>;
const WAKE_SLOT_DP = { compact: 14, row: 14, stack: 16, large: 16 } satisfies Record<Size, number>;
/** One action-row size in every bucket, so the rows themselves never reflow. */
const ACTION_FONT_DP = 12;
/**
 * The action chip's tap target, in dp. The chip is the widget's only in-place
 * action, so it holds Android's 48 dp minimum target; a 12 dp label with 4 dp
 * of vertical padding drew a ~25 dp chip and a hurried tap missed it. The
 * label is centered in the taller chip.
 */
const ACTION_TARGET_DP = 48;
/**
 * The surface padding, in dp. A short one-cell cell is as little as 40 dp tall
 * on a dense launcher grid, so the short buckets pad tighter than the nightstand
 * card: the padding is part of the height budget the optional chrome below is
 * measured against.
 */
const PAD_DP = { compact: 10, row: 10, stack: 10, large: 14 } satisfies Record<Size, number>;
/** The gap between the body's counts, the reserved newest line, and the chip. */
const BODY_GAP_DP = 6;
/** The gap between the mark and the body when the mark sits above it. */
const STACK_MARK_GAP_DP = 12;
/** The locked copy's font size; it draws one or two lines depending on the cell. */
const STATUS_FONT_DP = 13;
/**
 * The height one pinned dp text line occupies. The widget host reports no
 * measured height, so the layout budgets its optional chrome — the reserved
 * newest line and the 48 dp action chip — against this estimate: a text line is
 * about 1.3 times its font size. A cell too short for a piece of chrome drops
 * it rather than clipping it at the cell edge, because a widget cell is a fixed
 * frame with no scrolling and no reflow.
 */
const LINE_HEIGHT_FACTOR = 1.3;

function textLineHeight(fontSize: number): number {
  return Math.ceil(fontSize * LINE_HEIGHT_FACTOR);
}

/** The chrome the height budget is measured against. */
type Chrome = { layRows: boolean; statusLines: number };

/** The bucket shape plus the chrome decision the body is drawn with. */
type RenderShape = Shape & Chrome;

/**
 * The height the counts (or the locked copy) need, in dp, for the chrome
 * decision. `layRows` is the fallback a narrow-but-too-short cell takes: the
 * four states run in a single row instead of a column when the column cannot
 * fit, so the widget shows every count without clipping.
 */
function countsHeight(props: AndroidWidgetProps, shape: Shape, chrome: Chrome): number {
  const { size } = shape;
  if (props.countLines.length === 0) {
    return chrome.statusLines * textLineHeight(STATUS_FONT_DP);
  }
  const fontSize = size === 'compact' || size === 'row' ? 13 : 15;
  const line = textLineHeight(fontSize);
  if (chrome.layRows) {
    return line;
  }
  return (
    props.countLines.length * line + Math.max(0, props.countLines.length - 1) * COUNT_GAP_DP[size]
  );
}

function renderCounts(props: AndroidWidgetProps, palette: Palette, shape: RenderShape) {
  if (props.countLines.length === 0) {
    return statusText(props, palette, shape.statusLines);
  }
  const { size, rowLabels, rtl, layRows } = shape;
  const primaryLabel = props.primaryLabel;
  // Every state draws its own row, zeros included, so the rows hold still as
  // work moves between them and a narrow cell says as much as a wide one.
  const rows = props.countLines.map(line => {
    const isPrimary = line.label === primaryLabel;
    return countRow(line, isPrimary, {
      palette,
      size,
      fontSize: size === 'compact' || size === 'row' ? 13 : 15,
      // A row that is stacked (there is vertical room) labels every state. A
      // row laid out horizontally labels all of them only when the cell is wide
      // enough; otherwise the ranked state keeps its word and the rest show
      // their number, so a narrow row truncates no label to nothing.
      showLabel: layRows ? (size === 'row' && rowLabels) || isPrimary : true,
      rtl,
      scheduledAgo: props.scheduledAgo,
    });
  });
  return (
    <FlexWidget
      style={{
        flexDirection: layRows ? 'row' : 'column',
        alignItems: layRows ? 'center' : startEdge(rtl),
        flexGap: layRows && size === 'row' ? COUNT_GAP_DP.row : COUNT_GAP_DP[size],
      }}
    >
      {layRows ? inReadingOrder(rows, rtl) : rows}
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
          allowFontScaling={false}
          style={{ color: palette.muted, fontSize: NEWEST_FONT_DP[size] }}
        />
      )}
    </FlexWidget>
  );
}

/**
 * One action chip. Approve is a custom `clickAction`, which makes the library
 * launch a headless task (`register.ts`) that answers in place. New agent is an
 * `OPEN_URI` deep link: starting an agent needs the composer, so the tap opens
 * the app on the new-session screen. The body keeps its own `OPEN_URI` deep
 * link, so a tap beside the chips still opens Kilo.
 *
 * The chip is `ACTION_TARGET_DP` tall with the label centered: the target is
 * the whole chip, so the old padded-to-the-text height made taps miss.
 */
function actionRow(label: string, action: 'approve' | 'new-agent', palette: Palette) {
  const click =
    action === 'approve'
      ? { clickAction: 'approve' }
      : { clickAction: 'OPEN_URI', clickActionData: { uri: LAUNCHER_NEW_AGENT_URL } };
  return (
    <FlexWidget
      key={action}
      {...click}
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
        allowFontScaling={false}
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
  const { size, rtl, height } = shape;
  // The nightstand cell: the mark on top, the counts in the middle of the
  // column, and the third fact on the bottom edge. With no footer the mark and
  // the status text centre the way the stack bucket composes, so the extra
  // height never draws a hole. The large cell mirrors the iOS `systemLarge`
  // card: it carries the counts and the footer, not the reserved newest-session
  // slot or the action row the shorter buckets draw.
  if (size === 'large') {
    const body = renderCounts(props, palette, { ...shape, layRows: false, statusLines: 2 });
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
          padding: PAD_DP.large,
        }}
      >
        {logo(MARK_SIZE_DP[size])}
        {body}
        {footer}
      </FlexWidget>
    );
  }

  // The height budget. A cell is a fixed frame the host draws with no scrolling,
  // so the optional chrome — the reserved newest line and the 48 dp action chip
  // — is included only while the estimated content still fits. Below three grid
  // rows the mark, the four count rows, the reserved line, and the chip do not
  // all fit, and drawing them anyway clipped the chip at the cell edge in the
  // empty and idle-only states. The counts are never dropped: when a stacked
  // column cannot fit, a short narrow cell runs them in one row instead.
  const available = height - 2 * PAD_DP[size];
  const wantsActions = props.actions.approve || props.actions.newAgent;
  // The locked copy takes a second line only when the wanted chip still fits
  // under it. A one-row cell (about 104 dp) fits one line and the 48 dp chip
  // but not two lines and the chip, and the chip is the copy's only action.
  const statusLine = textLineHeight(STATUS_FONT_DP);
  const chipFitsUnderOneLine =
    wantsActions && statusLine + BODY_GAP_DP + ACTION_TARGET_DP <= available;
  const chipReserve = chipFitsUnderOneLine ? BODY_GAP_DP + ACTION_TARGET_DP : 0;
  const statusLines = available >= 2 * statusLine + chipReserve ? 2 : 1;
  const stacked = countsHeight(props, shape, { layRows: false, statusLines });
  const layRows = size === 'row' || (size === 'compact' && stacked > available);
  const chrome: Chrome = { layRows, statusLines };
  const base = countsHeight(props, shape, chrome);
  const showActions = wantsActions && base + BODY_GAP_DP + ACTION_TARGET_DP <= available;
  const slotFits = base + BODY_GAP_DP + NEWEST_LINE_DP[size] <= available;
  const slotWithActionsFits =
    base + BODY_GAP_DP + NEWEST_LINE_DP[size] + BODY_GAP_DP + ACTION_TARGET_DP <= available;
  const showSlot = showActions ? slotWithActionsFits : slotFits;
  const bodyHeight =
    base +
    (showSlot ? BODY_GAP_DP + NEWEST_LINE_DP[size] : 0) +
    (showActions ? BODY_GAP_DP + ACTION_TARGET_DP : 0);
  // The mark sits above the body in the stack bucket, where it costs height; a
  // short cell puts it beside the body, where only its own size must fit. Never
  // clip the mark: drop it when the cell cannot hold it beside the content.
  const showMark =
    size === 'stack'
      ? MARK_SIZE_DP[size] + STACK_MARK_GAP_DP + bodyHeight <= available
      : MARK_SIZE_DP[size] <= available;
  const mark = showMark ? logo(MARK_SIZE_DP[size]) : null;
  const body = (
    <FlexWidget
      key="body"
      style={{
        flexDirection: 'column',
        alignItems: startEdge(rtl),
        flexGap: BODY_GAP_DP,
        ...(size === 'stack' ? { width: 'match_parent' as const } : {}),
      }}
    >
      {renderCounts(props, palette, { ...shape, ...chrome })}
      {showSlot ? newestSlot(props, palette, shape) : null}
      {showActions ? actionRows(props, palette, rtl) : null}
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
          flexGap: STACK_MARK_GAP_DP,
          height: 'match_parent',
          width: 'match_parent',
          padding: PAD_DP[size],
        }}
      >
        {mark}
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
        padding: PAD_DP[size],
      }}
    >
      {/* No array here: a wrapper element per slot would add a layout node. */}
      {rtl ? body : mark}
      {rtl ? mark : body}
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
