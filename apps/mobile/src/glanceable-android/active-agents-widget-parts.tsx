/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import { FlexWidget, type HexColor, TextWidget } from 'react-native-android-widget';

import { type AndroidWidgetHomeCopy } from './home-copy';
import { ascent, BASELINE, LATIN_LINE, lineBox, wideAdvance } from './script-metrics';
import { type AndroidWidgetProps } from './widget-props';

/**
 * Every layout here draws on one absolute canvas: the library renders the whole
 * tree to a bitmap and overlays the clickable views by their bounds, so each
 * element is placed by its design coordinate (dp from the top-left, LTR) and RTL
 * mirrors that rectangle about the vertical axis.
 */

export type Palette = {
  background: HexColor;
  foreground: HexColor;
  muted: HexColor;
  warn: HexColor;
  good: HexColor;
  info: HexColor;
  idle: HexColor;
  primary: HexColor;
  primaryForeground: HexColor;
  secondary: HexColor;
  divider: HexColor;
};

export type Paint = { palette: Palette; rtl: boolean };

export type Copy = AndroidWidgetHomeCopy;

/** One placed widget in one palette. */
export type Frame = {
  props: AndroidWidgetProps;
  copy: Copy;
  paint: Paint;
  width: number;
  height: number;
};

export type Rect = { x: number; y: number; width: number; height: number };

export type Ink = 'foreground' | 'muted' | 'warn' | 'primaryForeground';

export type Weight = 'normal' | '600' | 'bold';

const DOT_INK = {
  needsInput: 'warn',
  running: 'good',
  scheduled: 'info',
  idle: 'idle',
} as const satisfies Record<NonNullable<Copy['primaryKind']>, keyof Palette>;

export function dotInk(kind: Copy['primaryKind']): keyof Palette {
  return kind === null ? 'idle' : DOT_INK[kind];
}

/**
 * The empty band every cell keeps on all four sides; no ink enters it. The
 * short classes (Row, Narrow, Landscape) keep 14dp, the cards (Small, Medium,
 * Large) the approved 16dp.
 */
export const PAD = 14;
export const CARD_PAD = 16;

/**
 * The line box a TextView draws one line in: Roboto with font padding (1.32em),
 * or the box of the fallback font the line's script draws in.
 */
export { lineBox };

/**
 * Top of the box whose baseline sits at `baseline`. The box starts one ascent
 * above the baseline whatever script draws: a taller fallback font raises the
 * box's top by its own ascent, and the rest of its taller box hangs below the
 * baseline as descent. Adding a share of the extra height here would lift the
 * box off its ink and leave the glyphs' descent outside the box.
 */
export function boxTop(value: string, size: number, baseline: number): number {
  return baseline - ascent(value, size);
}

/** The baseline whose line box (Latin or taller script) ends exactly at `bottom`. */
export function baselineAbove(value: string, size: number, bottom: number): number {
  return bottom - lineBox(value, size) + ascent(value, size);
}

/** The baseline whose line box (Latin or taller script) starts exactly at `top`. */
function baselineIn(value: string, size: number, top: number): number {
  return top + ascent(value, size);
}

/** Float noise below a twentieth of a dp is not an overflow; the design grid is in whole dp. */
const BAND_SLACK = 0.05;

/** One line placed inside a band: which edge it must stay clear of, and how many lines it draws. */
type BandSpec = {
  value: string;
  size: number;
  baseline: number;
  lines?: number;
  top?: number;
  bottom?: number;
};

/**
 * A design baseline moved inside its band. A fallback font's taller box would
 * otherwise rise above the top edge or end below the bottom one, and one box
 * can overflow both at once, so both edges are corrected: down off the top edge
 * first, then up off the bottom edge, and the top edge is checked again last —
 * lifting a box clear of the bottom can raise it back through the top. When the
 * band is shorter than the box no baseline clears both edges, so the top edge
 * wins: a clipped first line is worse than a last line that ends a little below
 * the band. Latin text, whose box is the design's own, keeps the baseline it
 * was given, to the tenth of a dp.
 */
export function insideBand(spec: BandSpec): number {
  const { value, size, baseline } = spec;
  const lines = spec.lines ?? 1;
  // The lowest baseline whose box starts on the top edge, and the highest whose
  // box ends on the bottom one.
  const floor = spec.top === undefined ? null : baselineIn(value, size, spec.top);
  const ceiling =
    spec.bottom === undefined
      ? null
      : baselineAbove(value, size, spec.bottom) - lineBox(value, size) * (lines - 1);
  let placed = baseline;
  if (floor !== null && floor - placed > BAND_SLACK) {
    placed = floor;
  }
  if (ceiling !== null && placed - ceiling > BAND_SLACK) {
    placed = ceiling;
  }
  // A band too short for the box cannot hold both edges: the top one wins.
  if (floor !== null && placed < floor) {
    placed = floor;
  }
  return placed;
}

/**
 * The baseline that centres `value`'s own line box on `cy`. The box runs from
 * `baseline - ascent` to that plus `lineBox`, so its centre is on `cy` when the
 * baseline is `cy + ascent - lineBox / 2`. For Latin, `lineBox` is exactly
 * `ceil(size * LATIN_LINE)`, so this is the number `centredBaseline` gives.
 */
export function centredLineBaseline(value: string, size: number, cy: number): number {
  return cy + ascent(value, size) - lineBox(value, size) / 2;
}

/** The baseline that centres a shared row on `cy`: its box is its tallest part's. */
export function centredRowBaseline(parts: readonly string[], size: number, cy: number): number {
  let tallest = '';
  let height = 0;
  for (const part of parts) {
    const box = lineBox(part, size);
    if (box > height) {
      tallest = part;
      height = box;
    }
  }
  return centredLineBaseline(tallest, size, cy);
}

/**
 * The design's own centred slot: a `size` line on `cy`, whose box grows evenly
 * about the design line whatever script draws in it. The extra ascent of a
 * taller fallback then lifts the box centre off `cy`, so a label that must be
 * centred in its own box uses `centredLineBaseline`.
 */
export function centredBaseline(size: number, cy: number): number {
  return cy + BASELINE * size - Math.ceil(size * LATIN_LINE) / 2;
}

/** Rough advance width, only for choices with slack (pill widths, one line or two). */
export function estimateWidth(value: string, size: number, bold = false): number {
  let ems = 0;
  for (const char of value) {
    if (wideAdvance(char)) {
      ems += 1;
    } else if (/[\s.,:;'|!ilI]/u.test(char)) {
      ems += 0.28;
    } else if (/\p{Lu}/u.test(char)) {
      ems += 0.66;
    } else {
      ems += 0.56;
    }
  }
  return ems * size * (bold ? 1.06 : 1);
}

export const tenth = (value: number) => Math.round(value * 10) / 10;

/** The native placement of an LTR design rectangle; RTL mirrors the rounded rectangle exactly. */
export function place(f: Frame, rect: Rect) {
  const x = tenth(rect.x);
  const width = tenth(rect.width);
  return {
    marginLeft: f.paint.rtl ? tenth(f.width - x - width) : x,
    marginTop: tenth(rect.y),
    width,
    height: tenth(rect.height),
  };
}

export function textAlign(f: Frame, align: 'start' | 'center' | 'end') {
  if (align === 'center') {
    return 'center';
  }
  return (align === 'end') === f.paint.rtl ? 'left' : 'right';
}

export function shape(
  f: Frame,
  key: string,
  spec: Rect & { fill: keyof Palette; radius?: number }
) {
  return (
    <FlexWidget
      key={key}
      style={{
        ...place(f, spec),
        backgroundColor: f.paint.palette[spec.fill],
        borderRadius: spec.radius ?? 0,
      }}
    />
  );
}

export function dot(
  f: Frame,
  key: string,
  spec: { cx: number; cy: number; r: number; fill: keyof Palette }
) {
  const { cx, cy, r } = spec;
  return shape(f, key, {
    x: cx - r,
    y: cy - r,
    width: r * 2,
    height: r * 2,
    fill: spec.fill,
    radius: r,
  });
}

/** A grey placeholder bar, its width clamped to the class's content edge (`pad`, 14dp unless given). */
export function bar(f: Frame, key: string, spec: Rect & { pad?: number }) {
  const { pad = PAD, ...rect } = spec;
  const width = Math.max(8, Math.min(rect.width, f.width - rect.x - pad));
  return shape(f, key, { ...rect, width, fill: 'secondary', radius: rect.height / 2 });
}

export type LabelSpec = {
  x: number;
  baseline: number;
  width: number;
  value: string;
  size: number;
  weight?: Weight;
  ink?: Ink;
  lines?: number;
  align?: 'start' | 'center' | 'end';
};

/** One text, ellipsized at its width; `lines` only lets copy that must read whole wrap. */
export function label(f: Frame, key: string, spec: LabelSpec) {
  const lines = spec.lines ?? 1;
  const rect = {
    x: spec.x,
    y: boxTop(spec.value, spec.size, spec.baseline),
    width: spec.width,
    height: lineBox(spec.value, spec.size) * lines,
  };
  return (
    <TextWidget
      key={key}
      text={spec.value}
      maxLines={lines}
      truncate="END"
      allowFontScaling={false}
      style={{
        ...place(f, rect),
        fontSize: spec.size,
        fontWeight: spec.weight ?? 'normal',
        color: f.paint.palette[spec.ink ?? 'foreground'],
        textAlign: textAlign(f, spec.align ?? 'start'),
      }}
    />
  );
}

type Part = { value: string; weight?: Weight; ink?: Ink; flex?: boolean };

/** A one-line text inside a weighted slot: it takes the room left and ellipsizes. */
export function flexText(
  f: Frame,
  key: string,
  spec: { value: string; size: number; weight?: Weight; ink?: Ink }
) {
  return (
    <FlexWidget key={key} style={{ width: 0, flex: 1 }}>
      <TextWidget
        text={spec.value}
        maxLines={1}
        truncate="END"
        allowFontScaling={false}
        style={{
          width: 'match_parent',
          fontSize: spec.size,
          fontWeight: spec.weight ?? 'normal',
          color: f.paint.palette[spec.ink ?? 'foreground'],
          textAlign: textAlign(f, 'start'),
        }}
      />
    </FlexWidget>
  );
}

/**
 * Texts sharing one baseline row; the one `flex` part ellipsizes. `fill` lets it
 * take every spare dp (a trailing time at the content edge); otherwise the row
 * hugs its copy, and the flex part only shrinks when the row would overflow.
 * Reversed in RTL so reading order holds.
 */
export function textRow(
  f: Frame,
  key: string,
  spec: {
    x: number;
    baseline: number;
    width: number;
    size: number;
    gap: number;
    fill: boolean;
    parts: Part[];
    /** The band's top edge; a taller fallback box moves down into it instead of above it. */
    top?: number;
  }
) {
  const height = Math.max(...spec.parts.map(part => lineBox(part.value, spec.size)));
  const tallest = spec.parts.find(part => lineBox(part.value, spec.size) === height)?.value ?? '';
  const baseline =
    spec.top === undefined
      ? spec.baseline
      : insideBand({ value: tallest, size: spec.size, baseline: spec.baseline, top: spec.top });
  const children = spec.parts.map((part, index) =>
    part.flex === true ? (
      flexText(f, `${key}-${index}`, { ...part, size: spec.size })
    ) : (
      <TextWidget
        key={`${key}-${index}`}
        text={part.value}
        maxLines={1}
        truncate="END"
        allowFontScaling={false}
        style={{
          fontSize: spec.size,
          fontWeight: part.weight ?? 'normal',
          color: f.paint.palette[part.ink ?? 'foreground'],
        }}
      />
    )
  );
  const ordered = f.paint.rtl ? children.toReversed() : children;
  const row = { flexDirection: 'row', alignItems: 'center', flexGap: spec.gap } as const;
  const rect = place(f, {
    x: spec.x,
    y: boxTop(tallest, spec.size, baseline),
    width: spec.width,
    height,
  });
  if (spec.fill) {
    return (
      <FlexWidget key={key} style={{ ...rect, ...row }}>
        {ordered}
      </FlexWidget>
    );
  }
  // A wrap-width row measured against the fixed slot: LinearLayout gives the weighted
  // part its natural width, and takes only the overflow back from it.
  return (
    <FlexWidget
      key={key}
      style={{
        ...rect,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: f.paint.rtl ? 'flex-end' : 'flex-start',
      }}
    >
      <FlexWidget style={row}>{ordered}</FlexWidget>
    </FlexWidget>
  );
}
