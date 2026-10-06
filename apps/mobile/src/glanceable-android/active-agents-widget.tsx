/* eslint-disable max-lines -- every composition and its height and width budget share this one widget layout module */
/* eslint-disable react-native/no-inline-styles -- react-native-android-widget primitives take style objects; NativeWind className is unavailable in the widget host */

'use no memo';

// Metro turns a static image import into the asset id the widget host resolves,
// the same value `require` would give. Imported rather than required so vitest
// can stand in for the binary.
import LOGO from '../../assets/images/logo-widget.png';
import {
  FlexWidget,
  type FlexWidgetStyle,
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

/*
 * How the layout works.
 *
 * The library draws the tree with native Android views into one bitmap the
 * size the host reports (`info.width` x `info.height`, in dp). Nothing scrolls
 * and nothing reflows, so a piece that does not fit is cut at the cell edge.
 * The layout therefore budgets every composition against the cell before it
 * draws, with an estimate of each text's width and height, and picks the
 * richest composition that fits:
 *
 * - card: a header row (the mark leading, the action trailing), the count rows
 *   scaled with the height, and the newest-result footer pinned to the bottom
 *   when its caption and its line both fit;
 * - side: the mark, the count rows as a column (set tight in a one-row cell),
 *   and the action trailing — or no action, the fallback that keeps the rows;
 * - line: the mark and the counts run as one row, the action beside them or
 *   under them.
 *
 * A state with no counts (signed out, waiting, empty, locked, expired) centers
 * the mark, its status line, and the New agent action when it offers one; a
 * one-row cell runs them beside the mark instead.
 *
 * An Approve in flight draws its progress line where the chip was; a failed one
 * draws its line over the chip, which stays as the retry.
 *
 * What each composition drops when the width runs out, in order: the wake
 * time, the labels of the secondary rows, the primary label, then the mark. A
 * count is never dropped, and the action wins over all of them.
 *
 * Every label is pinned to its dp size (`allowFontScaling={false}`): the cell is
 * a fixed frame, so scaled text would push the action out of it. A user gets a
 * larger surface by resizing the widget.
 */

/** Below this height (dp) a cell is one launcher row: its content runs beside the mark. */
const TALL_MIN_HEIGHT_DP = 130;
/** At or above this height (dp) the counts card has room for its footer and the larger type. */
const LARGE_MIN_HEIGHT_DP = 220;

type Palette = {
  background: HexColor;
  foreground: HexColor;
  muted: HexColor;
  primary: HexColor;
  primaryForeground: HexColor;
  /** Four states, four colors — the same vocabulary the iOS surfaces draw. */
  needsInput: HexColor;
  running: HexColor;
  scheduled: HexColor;
  /** The marker of a state no agent is in: the row stays, the ink steps back. */
  zero: HexColor;
};

// The app's own palette, not a widget-local one: a Home Screen card that does
// not match the app it opens reads as a different product.
const LIGHT: Palette = {
  background: lightColors.background,
  foreground: lightColors.foreground,
  muted: lightColors.mutedForeground,
  primary: lightColors.primary,
  primaryForeground: lightColors.primaryForeground,
  needsInput: lightColors.warn,
  running: lightColors.good,
  // The muted-soft tone the session list's scheduled clock glyph uses, so the
  // widget's scheduled marker matches the row the user taps to get here.
  scheduled: lightColors.mutedSoft,
  zero: lightColors.mutedSoft,
};

const DARK: Palette = {
  background: darkColors.background,
  foreground: darkColors.foreground,
  muted: darkColors.mutedForeground,
  primary: darkColors.primary,
  primaryForeground: darkColors.primaryForeground,
  needsInput: darkColors.warn,
  running: darkColors.good,
  scheduled: darkColors.mutedSoft,
  zero: darkColors.mutedSoft,
};

// This function is evaluated only through `renderActiveAgentsWidget` and the
// library's `buildWidgetTree`. Everything it references is explicit so the
// React Compiler is disabled ("use no memo") and the widget host can re-evaluate
// the source. Translated copy arrives through `props`.

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** The padding inside a one-row cell and inside a taller one. */
const SHORT_PAD_DP = 12;
const TALL_PAD_DP = 16;
/** The gap between the mark and what sits beside it. */
const MARK_GAP_DP = 12;
/** The gap between the content and a trailing action. */
const TRAILING_GAP_DP = 14;
/** The minimum gap between the blocks of a tall composition. */
const BLOCK_GAP_DP = 12;
/** The gap between a body line and the line or action under it. */
const BODY_GAP_DP = 8;

/**
 * The action's tap target and its drawn pill. The target holds Android's 48 dp
 * minimum; the pill inside it is smaller, so the target may reach into the
 * cell padding while the drawn part keeps its distance from the edge.
 */
const ACTION_TARGET_DP = 48;
const ACTION_PILL_DP = 36;
const ACTION_FONT_DP = 13;
const ACTION_PAD_X_DP = 16;

/** The type sizes. Count numbers and labels in one row share one size. */
const SHORT_COUNT_FONT_DP = 13;
const TALL_COUNT_FONT_DP = 15;
const MAX_COUNT_FONT_DP = 28;
/**
 * No count row is set below this size (dp). A column that would need less
 * gives way to the one-line row, which drops parts instead of shrinking them.
 */
const MIN_COUNT_FONT_DP = 12;
const STATUS_FONT_DP = { short: 13, tall: 14, large: 16, nightstand: 18 } as const;
/** At or above this height (dp) a count-less card sets its mark and copy a size up. */
const NIGHTSTAND_MIN_HEIGHT_DP = 400;
const SLOT_FONT_DP = 12;
const FOOTER_CAPTION_FONT_DP = 11;
const FOOTER_FONT_DP = 13;

/**
 * One pinned dp text line is about 1.32 times its font size in Roboto with
 * font padding. Arabic, the Indic scripts, Thai, and Myanmar fall back to fonts
 * with taller ascenders and descenders, and a column budgeted at Roboto's
 * height cut their last row at the cell edge.
 */
const ROBOTO_LINE_FACTOR = 1.32;
const TALL_SCRIPT_LINE_FACTOR = 1.62;
const TALL_SCRIPT =
  /[\u0600-\u08FF\u0900-\u0DFF\u0E00-\u0E7F\u1000-\u109F\uFB50-\uFDFF\uFE70-\uFEFF]/u;

/** The line height factor the copy in `props` draws at. */
function lineFactorOf(props: AndroidWidgetProps): number {
  const copy = [
    props.statusLine,
    props.newestLine,
    props.newestResultLabel,
    props.actions.approveLabel,
    props.actions.newAgentLabel,
    ...props.countLines.map(line => line.label),
  ];
  return copy.some(text => text !== null && TALL_SCRIPT.test(text))
    ? TALL_SCRIPT_LINE_FACTOR
    : ROBOTO_LINE_FACTOR;
}

function lineHeight(fontSize: number, factor: number): number {
  return Math.ceil(fontSize * factor);
}

/**
 * Roboto advance widths per em, by character class. The host reports no
 * measured text width, so the layout estimates it to decide what to drop
 * before it draws; the estimate errs wide (the factor below) so a near miss
 * drops a piece rather than cutting it.
 */
function charAdvance(char: string): number {
  if (char >= '0' && char <= '9') {
    return 0.562;
  }
  if (char === ' ' || char === '\u00A0' || char === '\u202F') {
    return 0.25;
  }
  if ("ijlI!|.,:;'’".includes(char)) {
    return 0.26;
  }
  if ('frt()[]-/'.includes(char)) {
    return 0.35;
  }
  if ('mwMW…%'.includes(char)) {
    return 0.88;
  }
  if (/[\u0600-\u06FF]/u.test(char)) {
    return 0.5;
  }
  // CJK, kana, hangul, and everything after them: a full em.
  if (/[\u2E80-\u{10FFFF}]/u.test(char)) {
    return 1;
  }
  const code = char.codePointAt(0) ?? 0;
  if (char !== char.toLowerCase()) {
    return 0.66;
  }
  return code < 0x02_50 ? 0.54 : 0.6;
}

/**
 * The estimated width of `text` in dp. The table is close to bold Roboto and a
 * little over regular, and the factor adds a margin on top, so an estimate errs
 * wide: a near miss drops a piece rather than cutting it.
 */
function textWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const char of text) {
    em += charAdvance(char);
  }
  return Math.ceil(em * fontSize * 1.04);
}

/** How many lines `text` takes at `width`, word-wrapped. */
function lineCount(text: string, fontSize: number, width: number): number {
  let lines = 1;
  let used = 0;
  const space = textWidth(' ', fontSize);
  for (const word of text.split(' ')) {
    const w = textWidth(word, fontSize);
    if (used > 0 && used + space + w > width) {
      lines += 1;
      used = w;
    } else {
      used += (used > 0 ? space : 0) + w;
    }
    if (w > width) {
      lines += Math.floor(w / width);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

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
function stateDot(kind: GlanceableCountKind, color: HexColor, size: number) {
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
  return (
    <ImageWidget
      key="mark"
      image={LOGO}
      imageWidth={size}
      imageHeight={size}
      radius={size * 0.24}
    />
  );
}

/** A flexible gap: at least `min` dp, plus an even share of the free space. */
function spacer(key: string, min = 0) {
  return <FlexWidget key={key} style={{ flex: 1, height: min, width: min }} />;
}

type CountLine = AndroidWidgetProps['countLines'][number];

/** Which parts of a count row draw: the label, and the wake text (scheduled row only). */
type RowParts = { label: boolean; time: string | null };

const dotSize = (fontSize: number): number =>
  fontSize < 14 ? 9 : Math.min(14, Math.round(fontSize * 0.62));
function innerGap(fontSize: number): number {
  if (fontSize >= 18) {
    return 8;
  }
  return fontSize >= 14 ? 6 : 5;
}
const timeFont = (fontSize: number): number => Math.max(11, Math.round(fontSize * 0.8));
const columnGap = (fontSize: number): number => Math.round(fontSize * 0.5);

function rowWidth(line: CountLine, fontSize: number, parts: RowParts) {
  const gap = innerGap(fontSize);
  let width = dotSize(fontSize) + gap + textWidth(line.count, fontSize);
  if (parts.label) {
    width += gap + textWidth(line.label, fontSize);
  }
  if (parts.time !== null && line.kind === 'scheduled') {
    width += gap + textWidth(parts.time, timeFont(fontSize));
  }
  return width;
}

type RowStyle = {
  palette: Palette;
  fontSize: number;
  rtl: boolean;
  parts: RowParts;
  isPrimary: boolean;
  /** No agent is in this state: the row keeps its place but draws muted. */
  zero: boolean;
  /** In a column the label may shrink (and end in an ellipsis) as a last resort. */
  shrinkLabel: boolean;
};

/**
 * One count line: marker, count, label, and the scheduled row's wake. Only the
 * label color ranks the rows; number and label share one size.
 */
function countRow(line: CountLine, style: RowStyle) {
  const { palette, fontSize, rtl, parts, isPrimary, shrinkLabel, zero } = style;
  let label: React.ReactNode = null;
  if (parts.label) {
    label = (
      <TextWidget
        key="label"
        text={line.label}
        maxLines={1}
        truncate="END"
        allowFontScaling={false}
        style={{
          color: isPrimary && !zero ? palette.foreground : palette.muted,
          fontSize,
        }}
      />
    );
    if (shrinkLabel) {
      label = (
        <FlexWidget key="label-box" style={{ flex: 1 }}>
          {label}
        </FlexWidget>
      );
    }
  }
  const time =
    parts.time !== null && line.kind === 'scheduled' ? (
      <TextWidget
        key="time"
        text={parts.time}
        maxLines={1}
        allowFontScaling={false}
        style={{ color: palette.muted, fontSize: timeFont(fontSize) }}
      />
    ) : null;
  return (
    <FlexWidget
      key={line.kind}
      style={{ flexDirection: 'row', alignItems: 'center', flexGap: innerGap(fontSize) }}
    >
      {inReadingOrder(
        [
          stateDot(
            line.kind,
            zero ? palette.zero : dotColor(line.kind, palette),
            dotSize(fontSize)
          ),
          <TextWidget
            key="count"
            // oxlint-disable-next-line no-literal-copy/no-literal-copy -- an already-formatted number
            text={line.count}
            maxLines={1}
            allowFontScaling={false}
            // A zero row keeps its place in the grid but reads as absent: muted, not bold.
            style={{
              color: zero ? palette.muted : palette.foreground,
              fontSize,
              fontWeight: zero ? 'normal' : 'bold',
            }}
          />,
          label,
          time,
        ],
        rtl
      )}
    </FlexWidget>
  );
}

/** A count column's height at `fontSize`. */
function columnHeight(
  lines: number,
  fontSize: number,
  { factor, gap = columnGap(fontSize) }: { factor: number; gap?: number }
): number {
  return lines * lineHeight(fontSize, factor) + Math.max(0, lines - 1) * gap;
}

/**
 * The count rows as a column. The rows keep their labels unless `labels` is
 * false; the wake drops from a row only when the row would not fit the width
 * with it.
 */
function countColumn(props: AndroidWidgetProps, palette: Palette, layout: ColumnLayout) {
  const { fontSize, gap, width, rtl, labels } = layout;
  return (
    <FlexWidget
      key="counts"
      style={{ flexDirection: 'column', alignItems: startEdge(rtl), flexGap: gap }}
    >
      {props.countLines.map(line => {
        const withTime = { label: labels, time: props.scheduledTime };
        return countRow(line, {
          palette,
          fontSize,
          rtl,
          parts:
            rowWidth(line, fontSize, withTime) <= width ? withTime : { label: labels, time: null },
          isPrimary: line.label === props.primaryLabel,
          zero: props.zeroKinds.includes(line.kind),
          shrinkLabel: true,
        });
      })}
    </FlexWidget>
  );
}

type ColumnLayout = {
  fontSize: number;
  gap: number;
  /** The width the wake must fit in beside its row. */
  width: number;
  rtl: boolean;
  labels: boolean;
};

/**
 * How much of a count row a one-line layout keeps, richest first. Each level
 * keeps what the next one drops: the wake goes first, then the secondary
 * labels, then the primary label.
 */
type LineLevel = { labels: 'all' | 'primary' | 'none'; time: boolean };
/** Counts only: what a line keeps when nothing else fits. */
const BARE_LINE: LineLevel = { labels: 'none', time: false };
const LINE_LEVELS: LineLevel[] = [
  { labels: 'all', time: true },
  { labels: 'all', time: false },
  { labels: 'primary', time: false },
  BARE_LINE,
];
const LINE_ITEM_GAP_DP = 10;

function lineParts(props: AndroidWidgetProps, line: CountLine, level: LineLevel): RowParts {
  return {
    label:
      level.labels === 'all' || (level.labels === 'primary' && line.label === props.primaryLabel),
    time: level.time ? props.scheduledTime : null,
  };
}

function lineWidth(props: AndroidWidgetProps, level: LineLevel): number {
  return (
    props.countLines.reduce(
      (sum, line) => sum + rowWidth(line, SHORT_COUNT_FONT_DP, lineParts(props, line, level)),
      0
    ) +
    Math.max(0, props.countLines.length - 1) * LINE_ITEM_GAP_DP
  );
}

/** The richest line level that fits `width`, or null. */
function fitLine(props: AndroidWidgetProps, width: number): LineLevel | null {
  return LINE_LEVELS.find(level => lineWidth(props, level) <= width) ?? null;
}

/** The palette and the reading direction a piece draws with. */
type Paint = { palette: Palette; rtl: boolean };

/** The counts run as one row, at the one-row cell's type size. */
function countLine(props: AndroidWidgetProps, level: LineLevel, { palette, rtl }: Paint) {
  const rows = props.countLines.map(line =>
    countRow(line, {
      palette,
      fontSize: SHORT_COUNT_FONT_DP,
      rtl,
      parts: lineParts(props, line, level),
      isPrimary: line.label === props.primaryLabel,
      zero: props.zeroKinds.includes(line.kind),
      shrinkLabel: false,
    })
  );
  return (
    <FlexWidget
      key="counts"
      style={{ flexDirection: 'row', alignItems: 'center', flexGap: LINE_ITEM_GAP_DP }}
    >
      {inReadingOrder(rows, rtl)}
    </FlexWidget>
  );
}

/** A single muted line: the newest session, or an action's progress or failure. */
function slotLine(text: string, palette: Palette, fontSize = SLOT_FONT_DP) {
  return (
    <TextWidget
      key="slot"
      text={text}
      maxLines={1}
      truncate="END"
      allowFontScaling={false}
      style={{ color: palette.muted, fontSize }}
    />
  );
}

/** The action the state offers, if any. Approve and New agent never coexist. */
type Action = { kind: 'approve' | 'new-agent'; label: string };

function actionOf(props: AndroidWidgetProps): Action | null {
  if (props.actions.approve) {
    return { kind: 'approve', label: props.actions.approveLabel };
  }
  if (props.actions.newAgent) {
    return { kind: 'new-agent', label: props.actions.newAgentLabel };
  }
  return null;
}

function actionWidth(action: Action): number {
  return Math.max(64, 2 * ACTION_PAD_X_DP + textWidth(action.label, ACTION_FONT_DP));
}

/**
 * The action chip. Approve is a custom `clickAction`, which makes the library
 * launch a headless task (`register.ts`) that answers in place. New agent is an
 * `OPEN_URI` deep link: starting an agent needs the composer, so the tap opens
 * the app on the new-session screen. The body keeps its own `OPEN_URI` deep
 * link, so a tap beside the chip still opens Kilo.
 *
 * The whole 48 dp box is the tap target; the filled pill inside it is what draws.
 */
function actionChip(action: Action, palette: Palette) {
  const click =
    action.kind === 'approve'
      ? { clickAction: 'approve' }
      : { clickAction: 'OPEN_URI', clickActionData: { uri: LAUNCHER_NEW_AGENT_URL } };
  return (
    <FlexWidget
      key={action.kind}
      {...click}
      accessibilityLabel={action.label}
      style={{
        flexDirection: 'column',
        justifyContent: 'center',
        height: ACTION_TARGET_DP,
        borderRadius: ACTION_PILL_DP / 2,
      }}
    >
      <FlexWidget
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          height: ACTION_PILL_DP,
          paddingHorizontal: ACTION_PAD_X_DP,
          borderRadius: ACTION_PILL_DP / 2,
          backgroundColor: palette.primary,
        }}
      >
        <TextWidget
          text={action.label}
          maxLines={1}
          allowFontScaling={false}
          style={{
            color: palette.primaryForeground,
            fontSize: ACTION_FONT_DP,
            fontWeight: 'bold',
          }}
        />
      </FlexWidget>
    </FlexWidget>
  );
}

/**
 * What sits where the action would: the chip, the chip under a failed
 * Approve's note (the chip is the retry), or — while an Approve is in flight —
 * its progress line, so the chip is not offered twice.
 */
type Trailing =
  | { kind: 'action'; action: Action; note: string | null }
  | { kind: 'progress'; text: string };

/** The trailing piece; `withNote` false leaves a failed Approve's note out. */
function trailingOf(props: AndroidWidgetProps, withNote = true): Trailing | null {
  if (props.actionFeedback === 'approving' && props.newestLine !== null) {
    return { kind: 'progress', text: props.newestLine };
  }
  const action = actionOf(props);
  if (action === null) {
    return null;
  }
  const note =
    withNote && props.actionFeedback === 'couldNotApprove' && action.kind === 'approve'
      ? props.newestLine
      : null;
  return { kind: 'action', action, note };
}

const NOTE_GAP_DP = 2;

function trailingSize(trailing: Trailing, factor: number) {
  if (trailing.kind === 'progress') {
    return {
      width: textWidth(trailing.text, SLOT_FONT_DP + 1),
      height: lineHeight(SLOT_FONT_DP + 1, factor),
    };
  }
  const chip = actionWidth(trailing.action);
  return trailing.note === null
    ? { width: chip, height: ACTION_TARGET_DP }
    : {
        width: Math.max(chip, textWidth(trailing.note, SLOT_FONT_DP)),
        height: lineHeight(SLOT_FONT_DP, factor) + NOTE_GAP_DP + ACTION_TARGET_DP,
      };
}

function renderTrailing(trailing: Trailing, palette: Palette, rtl: boolean) {
  if (trailing.kind === 'progress') {
    return slotLine(trailing.text, palette, SLOT_FONT_DP + 1);
  }
  if (trailing.note === null) {
    return actionChip(trailing.action, palette);
  }
  return (
    <FlexWidget
      key="trailing"
      style={{
        flexDirection: 'column',
        alignItems: rtl ? 'flex-start' : 'flex-end',
        flexGap: NOTE_GAP_DP,
      }}
    >
      {slotLine(trailing.note, palette)}
      {actionChip(trailing.action, palette)}
    </FlexWidget>
  );
}

/** The line under the counts: the newest session, never an action's line (that trails). */
function slotTextOf(props: AndroidWidgetProps): string | null {
  return props.actionFeedback === null ? props.newestLine : null;
}

/**
 * The tall card's footer: the newest result under its caption — the newest
 * session's own line when one is known, so the card names it without saying
 * "newest" twice — or the delayed copy under the caption when stale. Its type
 * follows the count rows, so a tall card's footer is not a footnote under
 * large rows: the line at about 0.7x the row size, the caption at about 0.6x,
 * never below the base sizes.
 */
type Footer = {
  caption: string | null;
  body: 'result' | 'text';
  text: string;
  lines: number;
  /** The result's age, dropped whole when the row would not fit with it. */
  showAgo: boolean;
  captionFont: number;
  lineFont: number;
};

function footerOf(props: AndroidWidgetProps, width: number, rowFont: number): Footer | null {
  if (props.countLines.length === 0) {
    return null;
  }
  const captionFont = Math.max(FOOTER_CAPTION_FONT_DP, Math.round(rowFont * 0.6));
  const lineFont = Math.max(FOOTER_FONT_DP, Math.round(rowFont * 0.7));
  if (props.statusLine !== null) {
    return {
      caption: props.newestResultTitle,
      body: 'text',
      text: props.statusLine,
      lines: Math.min(2, lineCount(props.statusLine, lineFont, width)),
      showAgo: false,
      captionFont,
      lineFont,
    };
  }
  if (
    props.newestResultKind === null ||
    props.newestResultLabel === null ||
    props.newestResultAgo === null
  ) {
    return null;
  }
  const labelPart = dotSize(lineFont) + 6 + textWidth(props.newestResultLabel, lineFont);
  return {
    caption:
      props.actionFeedback === null && props.newestLine !== null
        ? props.newestLine
        : props.newestResultTitle,
    body: 'result',
    text: props.newestResultLabel,
    lines: 1,
    showAgo: labelPart + 6 + textWidth(props.newestResultAgo, lineFont) <= width,
    captionFont,
    lineFont,
  };
}

function footerHeight(footer: Footer, factor: number): number {
  return (
    (footer.caption === null ? 0 : lineHeight(footer.captionFont, factor) + 4) +
    footer.lines * lineHeight(footer.lineFont, factor)
  );
}

function renderFooter(props: AndroidWidgetProps, footer: Footer, { palette, rtl }: Paint) {
  const body =
    footer.body === 'result' &&
    props.newestResultKind !== null &&
    props.newestResultLabel !== null &&
    props.newestResultAgo !== null ? (
      <FlexWidget key="result" style={{ flexDirection: 'row', alignItems: 'center', flexGap: 6 }}>
        {inReadingOrder(
          [
            stateDot(
              props.newestResultKind,
              dotColor(props.newestResultKind, palette),
              dotSize(footer.lineFont)
            ),
            <TextWidget
              key="newest-label"
              text={props.newestResultLabel}
              maxLines={1}
              truncate="END"
              allowFontScaling={false}
              style={{ color: palette.foreground, fontSize: footer.lineFont }}
            />,
            footer.showAgo ? (
              <TextWidget
                key="newest-ago"
                text={props.newestResultAgo}
                maxLines={1}
                allowFontScaling={false}
                style={{ color: palette.muted, fontSize: footer.lineFont }}
              />
            ) : null,
          ],
          rtl
        )}
      </FlexWidget>
    ) : (
      <TextWidget
        key="result"
        text={footer.text}
        maxLines={footer.lines}
        truncate="END"
        allowFontScaling={false}
        style={{ color: palette.muted, fontSize: footer.lineFont }}
      />
    );
  return (
    <FlexWidget
      key="footer"
      style={{ flexDirection: 'column', alignItems: startEdge(rtl), flexGap: 4 }}
    >
      {footer.caption === null ? null : (
        <TextWidget
          key="caption"
          text={footer.caption}
          maxLines={1}
          truncate="END"
          allowFontScaling={false}
          style={{ color: palette.muted, fontSize: footer.captionFont }}
        />
      )}
      {body}
    </FlexWidget>
  );
}

// ---------------------------------------------------------------------------
// Compositions
// ---------------------------------------------------------------------------

/** The cell's dp size, reading direction, and the line height factor of its copy. */
type Cell = { width: number; height: number; rtl: boolean; lineFactor: number };

/**
 * A composition the cell can hold, with what it keeps. `score` ranks the
 * candidates: the action first, then the richest content.
 */
type Plan = { score: number; draw: (palette: Palette) => React.ReactNode };

/** What each line level costs a plan: the labels it drops. */
const LABELS_PENALTY = { all: 0, primary: 8, none: 20 } satisfies Record<
  LineLevel['labels'],
  number
>;

/** What a plan loses, as a penalty; the action outweighs everything else. */
function penalty(dropped: {
  action: boolean;
  time: boolean;
  labels: LineLevel['labels'];
  mark: boolean;
}) {
  return (
    (dropped.action ? 1000 : 0) +
    (dropped.mark ? 40 : 0) +
    LABELS_PENALTY[dropped.labels] +
    (dropped.time ? 2 : 0)
  );
}

/** The whole cell: the background, and the deep link a tap anywhere opens. */
function root(
  props: AndroidWidgetProps,
  palette: Palette,
  { style, children }: { style: FlexWidgetStyle; children: React.ReactNode }
) {
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: 'kiloapp:///cloud/sessions' }}
      accessibilityLabel={props.accessibilityLabel}
      style={{
        backgroundColor: palette.background,
        height: 'match_parent',
        width: 'match_parent',
        ...style,
      }}
    >
      {children}
    </FlexWidget>
  );
}

/** A row whose start and end sit at its two edges, mirrored for RTL. */
function spreadRow(key: string, [start, end]: [React.ReactNode, React.ReactNode], rtl: boolean) {
  return (
    <FlexWidget
      key={key}
      style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}
    >
      {inReadingOrder([start, spacer(`${key}-gap`), end], rtl)}
    </FlexWidget>
  );
}

/** The type sizes a card's count column may take, largest first. */
function countSizes(large: boolean): number[] {
  const sizes: number[] = [];
  for (
    let size = large ? MAX_COUNT_FONT_DP : TALL_COUNT_FONT_DP;
    size >= MIN_COUNT_FONT_DP;
    size -= 1
  ) {
    sizes.push(size);
  }
  return sizes;
}

/**
 * The counts card: header, scaled count rows, and the footer when it fits.
 *
 * The header holds the mark and the action. When the two do not fit side by
 * side the mark keeps the header and the action takes its own row at the
 * bottom of the card, so neither sits alone at an edge. Only a card too short
 * for that row gives the header to the action alone (`chipOnly`), which ranks
 * below every composition that keeps the mark.
 */
function cardPlan(
  props: AndroidWidgetProps,
  cell: Cell,
  { note, chipOnly }: { note: boolean; chipOnly: boolean }
): Plan | null {
  const { rtl } = cell;
  const pad = TALL_PAD_DP;
  const aw = cell.width - 2 * pad;
  const ah = cell.height - 2 * pad;
  const large = cell.height >= LARGE_MIN_HEIGHT_DP;
  const markSize = large ? 30 : 26;
  const lines = props.countLines.length;
  const factor = cell.lineFactor;
  const trailing = trailingOf(props, note);
  const trailingBox = trailing === null ? null : trailingSize(trailing, factor);
  const showTrailing = trailingBox !== null && trailingBox.width <= aw;
  if (chipOnly && !showTrailing) {
    return null;
  }
  const actionBelow = !chipOnly && showTrailing && markSize + MARK_GAP_DP + trailingBox.width > aw;
  let headerHeight = markSize;
  if (chipOnly) {
    headerHeight = trailingBox?.height ?? 0;
  } else if (showTrailing && !actionBelow) {
    headerHeight = Math.max(markSize, trailingBox.height);
  }
  const bottomHeight = actionBelow ? BLOCK_GAP_DP + trailingBox.height : 0;

  const footerHeightAt = (fontSize: number): number | null => {
    const footer = footerOf(props, aw, fontSize);
    return footer === null ? null : BLOCK_GAP_DP + footerHeight(footer, factor);
  };
  const freeAt = (fontSize: number, withFooter: boolean): number =>
    ah - headerHeight - bottomHeight - (withFooter ? (footerHeightAt(fontSize) ?? 0) : 0);
  const fits = (fontSize: number, withFooter: boolean): boolean =>
    BLOCK_GAP_DP + columnHeight(lines, fontSize, { factor }) <= freeAt(fontSize, withFooter);
  // The rows share one size: the largest that fits the height, leaves the card
  // room to breathe, and fits the longest label; the minimum when no size fits
  // that label, which then ends in an ellipsis.
  const pickSize = (withFooter: boolean): number | null => {
    const fitting = countSizes(large).filter(size => fits(size, withFooter));
    if (fitting.length === 0) {
      return null;
    }
    const roomy = fitting.filter(
      size => columnHeight(lines, size, { factor }) <= freeAt(size, withFooter) * 0.75
    );
    const pool = roomy.length > 0 ? roomy : fitting.slice(-1);
    return (
      pool.find(size =>
        props.countLines.every(line => rowWidth(line, size, { label: true, time: null }) <= aw)
      ) ??
      pool.at(-1) ??
      null
    );
  };
  // The footer is the third fact: it may not shrink the rows below the tall
  // card's base size (or below what the longest label allows anyway).
  const bare = pickSize(false);
  if (bare === null) {
    return null;
  }
  const footed = footerHeightAt(TALL_COUNT_FONT_DP) === null ? null : pickSize(true);
  const withFooter = footed !== null && footed >= Math.min(bare, TALL_COUNT_FONT_DP);
  const fontSize = withFooter ? footed : bare;
  const footer = withFooter ? footerOf(props, aw, fontSize) : null;
  const keepsTime =
    props.scheduledTime === null ||
    props.countLines.every(
      line => rowWidth(line, fontSize, { label: true, time: props.scheduledTime }) <= aw
    );
  return {
    score:
      -penalty({
        action: trailing !== null && !showTrailing,
        time: !keepsTime,
        labels: 'all',
        mark: chipOnly,
      }) + (withFooter ? 1 : 0),
    draw: palette => {
      const action =
        showTrailing && trailing !== null ? renderTrailing(trailing, palette, rtl) : null;
      const header = chipOnly
        ? action
        : spreadRow('header', [logo(markSize), actionBelow ? null : action], rtl);
      const counts = countColumn(props, palette, {
        fontSize,
        gap: columnGap(fontSize),
        width: aw,
        rtl,
        labels: true,
      });
      return root(props, palette, {
        style: { flexDirection: 'column', alignItems: startEdge(rtl), padding: pad },
        children: [
          header,
          spacer('above-counts', BLOCK_GAP_DP),
          counts,
          spacer('below-counts', footer === null ? 0 : BLOCK_GAP_DP),
          footer === null ? null : renderFooter(props, footer, { palette, rtl }),
          actionBelow ? <FlexWidget key="action-gap" style={{ height: BLOCK_GAP_DP }} /> : null,
          actionBelow ? action : null,
        ],
      });
    },
  };
}

/**
 * The mark, the count rows as a column, and the action trailing. Without the
 * action (`withAction` false) it is the short narrow cell's fallback that keeps
 * every label when the counts cannot run as one line beside the action.
 */
function sidePlan(
  props: AndroidWidgetProps,
  cell: Cell,
  { short, withAction, note }: { short: boolean; withAction: boolean; note: boolean }
): Plan | null {
  const { rtl } = cell;
  const pad = short ? SHORT_PAD_DP : TALL_PAD_DP - 2;
  const aw = cell.width - 2 * pad;
  const ah = cell.height - 2 * pad;
  const trailing = withAction ? trailingOf(props, note) : null;
  const trailingBox = trailing === null ? null : trailingSize(trailing, cell.lineFactor);
  const baseFont = short ? SHORT_COUNT_FONT_DP : 14;
  const gapFor = (size: number) => (short ? 2 : columnGap(size));
  const lines = props.countLines.length;
  const heightAt = (size: number) =>
    columnHeight(lines, size, { factor: cell.lineFactor, gap: gapFor(size) });
  if (trailingBox !== null && trailingBox.height > cell.height - 2 * (pad - 6)) {
    return null;
  }
  const colWidth = (option: { labels: boolean; time: boolean; size: number }) =>
    Math.max(
      ...props.countLines.map(line =>
        rowWidth(line, option.size, {
          label: option.labels,
          time: option.time ? props.scheduledTime : null,
        })
      )
    );
  const trailingPart = trailingBox === null ? 0 : TRAILING_GAP_DP + trailingBox.width;
  const markSize = short ? 24 : 26;
  const room = (mark: boolean) => aw - trailingPart - (mark ? markSize + MARK_GAP_DP : 0);
  // Richest first, in the overflow order: the wake, then the labels (after the
  // whole column shrinks to the minimum size for them), then the mark.
  const chosen = [
    { labels: true, time: true, mark: true, size: baseFont },
    { labels: true, time: false, mark: true, size: baseFont },
    { labels: true, time: false, mark: true, size: MIN_COUNT_FONT_DP },
    { labels: false, time: false, mark: true, size: baseFont },
    { labels: false, time: false, mark: false, size: baseFont },
  ].find(option => heightAt(option.size) <= ah && colWidth(option) <= room(option.mark));
  if (chosen === undefined) {
    return null;
  }
  const { labels, time, mark: showMark, size: fontSize } = chosen;
  const gap = gapFor(fontSize);
  const colHeight = heightAt(fontSize);
  const slot = slotTextOf(props);
  const showSlot =
    slot !== null &&
    colHeight + BODY_GAP_DP + lineHeight(SLOT_FONT_DP, cell.lineFactor) <= ah &&
    !short;
  return {
    score:
      -penalty({
        action: !withAction && trailingOf(props) !== null,
        time: !time && props.scheduledTime !== null,
        labels: labels ? 'all' : 'none',
        mark: !showMark,
      }) - 3,
    draw: palette => {
      const body = (
        <FlexWidget
          key="body"
          style={{ flexDirection: 'column', alignItems: startEdge(rtl), flexGap: BODY_GAP_DP }}
        >
          {countColumn(props, palette, {
            fontSize,
            gap,
            width: time ? Number.POSITIVE_INFINITY : 0,
            rtl,
            labels,
          })}
          {showSlot ? slotLine(slot, palette) : null}
        </FlexWidget>
      );
      const start = (
        <FlexWidget
          key="start"
          style={{ flexDirection: 'row', alignItems: 'center', flexGap: MARK_GAP_DP }}
        >
          {inReadingOrder([showMark ? logo(markSize) : null, body], rtl)}
        </FlexWidget>
      );
      return root(props, palette, {
        style: { flexDirection: 'row', alignItems: 'center', padding: pad },
        children: inReadingOrder(
          [
            start,
            spacer('gap', TRAILING_GAP_DP),
            trailing === null ? null : renderTrailing(trailing, palette, rtl),
          ],
          rtl
        ),
      });
    },
  };
}

/**
 * The mark and the counts as one row, with the action beside them, under them,
 * or (`alone`) not at all.
 */
function linePlan(
  props: AndroidWidgetProps,
  cell: Cell,
  { layout, note }: { layout: 'beside' | 'below' | 'alone'; note: boolean }
): Plan | null {
  const { rtl } = cell;
  const pad = cell.height < TALL_MIN_HEIGHT_DP ? SHORT_PAD_DP : TALL_PAD_DP - 2;
  const aw = cell.width - 2 * pad;
  const ah = cell.height - 2 * pad;
  const countHeight = lineHeight(SHORT_COUNT_FONT_DP, cell.lineFactor);
  const wanted = trailingOf(props, note);
  const trailing = layout === 'alone' ? null : wanted;
  if (layout !== 'alone' && trailing === null) {
    return null;
  }
  const beside = layout === 'beside';
  const trailingBox = trailing === null ? null : trailingSize(trailing, cell.lineFactor);
  const markSize = ah >= 40 ? 28 : 24;
  const slot = slotTextOf(props);
  const slotHeight = BODY_GAP_DP + lineHeight(SLOT_FONT_DP, cell.lineFactor);
  let bodyHeight = countHeight;
  if (layout === 'below' && trailingBox !== null) {
    bodyHeight += BODY_GAP_DP + trailingBox.height;
  }
  if (bodyHeight > ah) {
    return null;
  }
  // The 48 dp target may reach into the padding; its drawn pill may not.
  if (beside && trailingBox !== null && trailingBox.height > cell.height - 2 * (pad - 6)) {
    return null;
  }
  const showSlot = slot !== null && bodyHeight + slotHeight <= ah;
  const trailingWidth = trailingBox?.width ?? 0;
  const room = (mark: boolean): number =>
    aw -
    (mark && markSize <= ah ? markSize + MARK_GAP_DP : 0) -
    (beside ? TRAILING_GAP_DP + trailingWidth : 0);
  let showMark = markSize <= ah;
  let level = fitLine(props, room(showMark));
  if (level === null && showMark) {
    showMark = false;
    level = fitLine(props, room(false));
  }
  if (level === null || (layout === 'below' && trailingWidth > room(showMark))) {
    return null;
  }
  const chosen = level;
  return {
    score:
      -penalty({
        action: layout === 'alone' && wanted !== null,
        time: !chosen.time && props.scheduledTime !== null,
        labels: chosen.labels,
        mark: !showMark,
      }) - (beside ? 6 : 5),
    draw: palette => {
      const body = (
        <FlexWidget
          key="body"
          style={{ flexDirection: 'column', alignItems: startEdge(rtl), flexGap: BODY_GAP_DP }}
        >
          {countLine(props, chosen, { palette, rtl })}
          {showSlot ? slotLine(slot, palette) : null}
          {layout === 'below' && trailing !== null ? renderTrailing(trailing, palette, rtl) : null}
        </FlexWidget>
      );
      return root(props, palette, {
        style: { flexDirection: 'row', alignItems: 'center', padding: pad },
        children: inReadingOrder(
          [
            showMark ? logo(markSize) : null,
            showMark ? <FlexWidget key="mark-gap" style={{ width: MARK_GAP_DP }} /> : null,
            body,
            beside && trailing !== null ? spacer('gap', TRAILING_GAP_DP) : null,
            beside && trailing !== null ? renderTrailing(trailing, palette, rtl) : null,
          ],
          rtl
        ),
      });
    },
  };
}

/**
 * Every counts composition the cell can hold. A failed Approve's note rides
 * above the retry chip when there is room; the variants without it rank lower.
 */
function countPlans(props: AndroidWidgetProps, cell: Cell): Plan[] {
  const tall = cell.height >= TALL_MIN_HEIGHT_DP;
  const short = !tall;
  const failed = props.actionFeedback === 'couldNotApprove';
  return (failed ? [true, false] : [true]).flatMap(note =>
    [
      tall ? cardPlan(props, cell, { note, chipOnly: false }) : null,
      tall ? cardPlan(props, cell, { note, chipOnly: true }) : null,
      sidePlan(props, cell, { short, withAction: true, note }),
      sidePlan(props, cell, { short, withAction: false, note }),
      linePlan(props, cell, { layout: 'below', note }),
      linePlan(props, cell, { layout: 'beside', note }),
      linePlan(props, cell, { layout: 'alone', note }),
    ]
      .filter((plan): plan is Plan => plan !== null)
      // Without the failure's note a plan ranks below the same plan with it.
      .map(plan => (failed && !note ? { score: plan.score - 3, draw: plan.draw } : plan))
  );
}

/** The centered composition's type and mark sizes, a step up for each taller bound. */
function centeredSizes(height: number) {
  if (height >= NIGHTSTAND_MIN_HEIGHT_DP) {
    return { fontSize: STATUS_FONT_DP.nightstand, markSize: 48 };
  }
  if (height >= LARGE_MIN_HEIGHT_DP) {
    return { fontSize: STATUS_FONT_DP.large, markSize: 40 };
  }
  return { fontSize: STATUS_FONT_DP.tall, markSize: 30 };
}

/** A tall cell's count-less composition: mark, copy, and action, centered on both axes. */
function centeredStatusPlan(props: AndroidWidgetProps, cell: Cell): Plan | null {
  const text = props.statusLine ?? '';
  const action = actionOf(props);
  const pad = TALL_PAD_DP;
  const aw = cell.width - 2 * pad;
  const ah = cell.height - 2 * pad;
  const { fontSize, markSize } = centeredSizes(cell.height);
  const lines = Math.min(3, lineCount(text, fontSize, Math.min(aw, 260)));
  const textHeight = lines * lineHeight(fontSize, cell.lineFactor);
  const showAction = action !== null && actionWidth(action) <= aw;
  const actionPart = showAction ? BLOCK_GAP_DP + ACTION_TARGET_DP : 0;
  const showMark = markSize + BLOCK_GAP_DP + textHeight + actionPart <= ah;
  if (!showMark && textHeight + actionPart > ah) {
    return null;
  }
  return {
    score: -penalty({
      action: action !== null && !showAction,
      time: false,
      labels: 'all',
      mark: !showMark,
    }),
    draw: palette =>
      root(props, palette, {
        style: {
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          flexGap: BLOCK_GAP_DP,
          padding: pad,
        },
        children: [
          showMark ? logo(markSize) : null,
          <TextWidget
            key="status"
            text={text}
            maxLines={lines}
            truncate="END"
            allowFontScaling={false}
            style={{ color: palette.muted, fontSize, textAlign: 'center' }}
          />,
          showAction ? actionChip(action, palette) : null,
        ],
      }),
  };
}

/**
 * A one-row count-less composition (or a tall cell's fallback): the mark, the
 * copy, and the action beside the copy, under it, or (`alone`) not at all.
 */
function rowStatusPlan(
  props: AndroidWidgetProps,
  cell: Cell,
  layout: 'beside' | 'below' | 'alone'
): Plan | null {
  const { rtl } = cell;
  const text = props.statusLine ?? '';
  const action = layout === 'alone' ? null : actionOf(props);
  if (layout !== 'alone' && action === null) {
    return null;
  }
  const pad = cell.height >= TALL_MIN_HEIGHT_DP ? TALL_PAD_DP - 2 : SHORT_PAD_DP;
  // The 48 dp target may reach into the padding; its drawn pill may not.
  if (layout === 'beside' && ACTION_TARGET_DP > cell.height - 2 * (pad - 6)) {
    return null;
  }
  const aw = cell.width - 2 * pad;
  const ah = cell.height - 2 * pad;
  const fontSize = STATUS_FONT_DP.short;
  const markSize = ah >= 40 ? 28 : 24;
  const actionWide = action === null ? 0 : actionWidth(action);
  const roomFor = (mark: boolean): number =>
    aw -
    (mark ? markSize + MARK_GAP_DP : 0) -
    (layout === 'beside' ? TRAILING_GAP_DP + actionWide : 0);
  const fitsWith = (mark: boolean): boolean =>
    roomFor(mark) >= 48 && (layout !== 'below' || actionWide <= roomFor(mark));
  const showMark = fitsWith(true);
  if (!showMark && !fitsWith(false)) {
    return null;
  }
  const room = roomFor(showMark);
  const reserve = layout === 'below' ? BODY_GAP_DP + ACTION_TARGET_DP : 0;
  const maxLines = Math.floor((ah - reserve) / lineHeight(fontSize, cell.lineFactor));
  if (maxLines < 1) {
    return null;
  }
  const wanted = lineCount(text, fontSize, room);
  const lines = Math.min(maxLines, 2, wanted);
  return {
    score:
      -penalty({
        action: layout === 'alone' && actionOf(props) !== null,
        time: false,
        labels: 'all',
        mark: !showMark,
      }) -
      (wanted > lines ? 4 : 0) -
      // One line beside the action reads better than two squeezed beside it.
      (layout === 'beside' ? 2 * (lines - 1) : 0) -
      (layout === 'below' ? 1 : 0) -
      10,
    draw: palette => {
      const copy = (
        <TextWidget
          key="status"
          text={text}
          maxLines={lines}
          truncate="END"
          allowFontScaling={false}
          style={{ color: palette.muted, fontSize, textAlign: rtl ? 'right' : 'left' }}
        />
      );
      let body: React.ReactNode = copy;
      if (layout === 'beside') {
        body = (
          <FlexWidget key="copy" style={{ flex: 1 }}>
            {copy}
          </FlexWidget>
        );
      } else if (layout === 'below' && action !== null) {
        body = (
          <FlexWidget
            key="body"
            style={{ flexDirection: 'column', alignItems: startEdge(rtl), flexGap: BODY_GAP_DP }}
          >
            {copy}
            {actionChip(action, palette)}
          </FlexWidget>
        );
      }
      return root(props, palette, {
        style: { flexDirection: 'row', alignItems: 'center', padding: pad },
        children: inReadingOrder(
          [
            showMark ? logo(markSize) : null,
            showMark ? <FlexWidget key="mark-gap" style={{ width: MARK_GAP_DP }} /> : null,
            body,
            layout === 'beside' ? (
              <FlexWidget key="gap" style={{ width: TRAILING_GAP_DP }} />
            ) : null,
            layout === 'beside' && action !== null ? actionChip(action, palette) : null,
          ],
          rtl
        ),
      });
    },
  };
}

/** Every count-less composition the cell can hold. */
function statusPlans(props: AndroidWidgetProps, cell: Cell): Plan[] {
  return [
    cell.height >= TALL_MIN_HEIGHT_DP ? centeredStatusPlan(props, cell) : null,
    rowStatusPlan(props, cell, 'beside'),
    rowStatusPlan(props, cell, 'below'),
    rowStatusPlan(props, cell, 'alone'),
  ].filter((plan): plan is Plan => plan !== null);
}

/** The fallback when no composition fits: the counts as a tight line, nothing else. */
function fallbackPlan(props: AndroidWidgetProps, cell: Cell): Plan {
  return {
    score: Number.NEGATIVE_INFINITY,
    draw: palette =>
      root(props, palette, {
        style: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          padding: SHORT_PAD_DP,
        },
        children:
          props.countLines.length === 0
            ? slotLine(props.statusLine ?? '', palette, STATUS_FONT_DP.short)
            : countLine(props, BARE_LINE, { palette, rtl: cell.rtl }),
      }),
  };
}

function bestPlan(props: AndroidWidgetProps, cell: Cell): Plan {
  const plans = props.countLines.length === 0 ? statusPlans(props, cell) : countPlans(props, cell);
  let best = fallbackPlan(props, cell);
  for (const plan of plans) {
    if (plan.score > best.score) {
      best = plan;
    }
  }
  return best;
}

/**
 * Distinct light and dark layouts through the library's theme callback, drawn
 * from one plan so both themes keep the same composition.
 */
export function renderActiveAgentsWidget(
  props: AndroidWidgetProps,
  info: WidgetInfo,
  rtl = false
): WidgetRepresentation {
  const plan = bestPlan(props, {
    width: info.width,
    height: info.height,
    rtl,
    lineFactor: lineFactorOf(props),
  });
  return {
    light: plan.draw(LIGHT) as React.JSX.Element,
    dark: plan.draw(DARK) as React.JSX.Element,
  };
}
