/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import { FlexWidget, type HexColor, TextWidget } from 'react-native-android-widget';

import { type AndroidWidgetHomeCopy } from './home-copy';
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

const TALL_SCRIPT = /[\u0600-\u08FF\u0900-\u0DFF]/u;

/** Roboto's ascent plus font padding above the baseline, per unit of font size. */
const BASELINE = 1.056;

const LATIN_LINE = 1.32;

/**
 * The line box a TextView draws one line in: Roboto with font padding (1.32em),
 * or the taller fallback box Arabic-Indic and Devanagari need (1.62em).
 */
export function lineBox(value: string, size: number): number {
  return Math.ceil(size * (TALL_SCRIPT.test(value) ? 1.62 : LATIN_LINE));
}

/** Top of the box whose Latin baseline sits at `baseline`; a taller script keeps the same centre. */
export function boxTop(value: string, size: number, baseline: number): number {
  return baseline - BASELINE * size - (lineBox(value, size) - Math.ceil(size * LATIN_LINE)) / 2;
}

/** The baseline whose line box (Latin or taller script) ends at `bottom`. */
export function baselineAbove(value: string, size: number, bottom: number): number {
  return bottom - lineBox(value, size) - boxTop(value, size, 0);
}

/** The baseline that centres a line of `size` on `cy`; a taller script grows evenly about it. */
export function centredBaseline(size: number, cy: number): number {
  return cy + BASELINE * size - Math.ceil(size * LATIN_LINE) / 2;
}

/** Rough advance width, only for choices with slack (pill widths, one line or two). */
export function estimateWidth(value: string, size: number, bold = false): number {
  let ems = 0;
  for (const char of value) {
    if (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFF60]/u.test(char)) {
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
  }
) {
  const height = Math.max(...spec.parts.map(part => lineBox(part.value, spec.size)));
  const tallest = spec.parts.find(part => lineBox(part.value, spec.size) === height)?.value ?? '';
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
    y: boxTop(tallest, spec.size, spec.baseline),
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
