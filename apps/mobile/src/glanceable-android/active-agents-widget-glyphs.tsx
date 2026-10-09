/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import { type ReactNode } from 'react';
import { FlexWidget, type HexColor, OverlapWidget } from 'react-native-android-widget';

import { type Frame, place, shape, tenth } from './active-agents-widget-parts';

/** The brand tile: a foreground square (22% corners) with a background inner square. */
export function logo(f: Frame, spec: { x: number; y: number; size: number }) {
  const inner = tenth(spec.size * 0.44);
  return (
    <FlexWidget
      key="logo"
      style={{
        ...place(f, { x: spec.x, y: spec.y, width: spec.size, height: spec.size }),
        borderRadius: tenth(spec.size * 0.22),
        backgroundColor: f.paint.palette.foreground,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <FlexWidget
        style={{
          width: inner,
          height: inner,
          borderRadius: 1,
          backgroundColor: f.paint.palette.background,
        }}
      />
    </FlexWidget>
  );
}

/** A round-capped stroke inside a glyph box: centre, length and angle in degrees. */
function stroke(
  key: string,
  spec: { cx: number; cy: number; length: number; angle: number; color: HexColor; width?: number }
) {
  const width = spec.width ?? 2.2;
  const long = spec.length + width;
  return (
    <FlexWidget
      key={key}
      style={{
        marginLeft: tenth(spec.cx - long / 2),
        marginTop: tenth(spec.cy - width / 2),
        width: tenth(long),
        height: width,
        borderRadius: width / 2,
        backgroundColor: spec.color,
        ...(spec.angle === 0 ? {} : { rotation: spec.angle }),
      }}
    />
  );
}

/** A `+` drawn from two strokes, centred in a box of `size`. */
export function plusStrokes(
  key: string,
  spec: { size: number; arm: number; color: HexColor; width?: number }
) {
  const centre = spec.size / 2;
  const base = {
    cx: centre,
    cy: centre,
    length: spec.arm * 2,
    color: spec.color,
    width: spec.width,
  };
  return [stroke(`${key}-h`, { ...base, angle: 0 }), stroke(`${key}-v`, { ...base, angle: 90 })];
}

export type GlyphKind = 'create' | 'approve' | 'approving';

function glyphStrokes(f: Frame, kind: GlyphKind, r: number): ReactNode[] {
  const { palette } = f.paint;
  if (kind === 'create') {
    return plusStrokes('plus', { size: r * 2, arm: r / 2, color: palette.foreground });
  }
  if (kind === 'approve') {
    // The design path: from (-a, 0) down to (-0.2a, 0.8a), then up to (1.2a, -0.8a).
    const a = r * 0.42;
    const color = palette.primaryForeground;
    return [
      stroke('check-short', {
        cx: r - 0.6 * a,
        cy: r + 0.4 * a,
        length: Math.hypot(0.8 * a, 0.8 * a),
        angle: 45,
        color,
      }),
      stroke('check-long', {
        cx: r + 0.5 * a,
        cy: r,
        length: Math.hypot(1.4 * a, 1.6 * a),
        angle: -49,
        color,
      }),
    ];
  }
  return [-5, 0, 5].map(dx => (
    <FlexWidget
      key={`dot-${dx}`}
      style={{
        marginLeft: tenth(r + dx - 1.8),
        marginTop: tenth(r - 1.8),
        width: 3.6,
        height: 3.6,
        borderRadius: 1.8,
        backgroundColor: palette.muted,
      }}
    />
  ));
}

/**
 * The round action glyphs: `+` on the secondary fill, a checkmark on primary,
 * and three muted dots while an approve is in flight. Glyph strokes are not
 * mirrored in RTL; only the circle's position is.
 */
export function glyph(f: Frame, kind: GlyphKind, spec: { cx: number; cy: number; r: number }) {
  const { cx, cy, r } = spec;
  const fill = kind === 'approve' ? f.paint.palette.primary : f.paint.palette.secondary;
  return (
    <OverlapWidget
      key={`${kind}-glyph`}
      style={{
        ...place(f, { x: cx - r, y: cy - r, width: r * 2, height: r * 2 }),
        backgroundColor: fill,
        borderRadius: r,
      }}
    >
      {glyphStrokes(f, kind, r)}
    </OverlapWidget>
  );
}

/** A padlock from two shapes: a stroked shackle sitting on a rounded body. */
export function lock(f: Frame, spec: { cx: number; cy: number; size: number }) {
  const { cx, cy, size } = spec;
  const body = size * 0.62;
  const weight = Math.max(2, size * 0.13);
  const shackle = size * 0.56;
  const bodyTop = cy - size / 2 + size - body;
  const rise = (size - body) * 0.45 + (shackle - weight) / 2 + weight / 2;
  return [
    <FlexWidget
      key="lock-shackle"
      style={{
        // The legs run into the body by one stroke so the two shapes read as one.
        ...place(f, {
          x: cx - shackle / 2,
          y: bodyTop - rise,
          width: shackle,
          height: rise + weight,
        }),
        borderWidth: tenth(weight),
        borderBottomWidth: 0,
        borderColor: f.paint.palette.foreground,
        borderTopLeftRadius: tenth(shackle / 2),
        borderTopRightRadius: tenth(shackle / 2),
      }}
    />,
    shape(f, 'lock-body', {
      x: cx - size * 0.43,
      y: bodyTop,
      width: size * 0.86,
      height: body,
      fill: 'foreground',
      radius: tenth(size * 0.14),
    }),
  ];
}
