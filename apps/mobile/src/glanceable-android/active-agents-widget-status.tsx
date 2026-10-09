/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import { FlexWidget, TextWidget } from 'react-native-android-widget';

import {
  boxTop,
  dotInk,
  flexText,
  type Frame,
  label,
  lineBox,
  place,
} from './active-agents-widget-parts';

/** Spec: count, dot and label share one row with fixed 6dp gaps; only the label ellipsizes. */
const STATUS_GAP = 6;

function statusDot(f: Frame, r: number) {
  return (
    <FlexWidget
      key="dot"
      style={{
        width: r * 2,
        height: r * 2,
        borderRadius: r,
        backgroundColor: f.paint.palette[dotInk(f.copy.primaryKind)],
      }}
    />
  );
}

/**
 * Count → dot → label on one row, centred on the count. The count keeps its
 * natural width; the label takes what is left up to `width` and ellipsizes.
 */
export function statusRow(
  f: Frame,
  spec: {
    x: number;
    baseline: number;
    width: number;
    countSize: number;
    labelSize: number;
    r: number;
  }
) {
  const count = f.copy.primaryCount;
  const value = f.copy.primaryLabel ?? '';
  const countBox = lineBox(count, spec.countSize);
  const height = Math.max(countBox, lineBox(value, spec.labelSize));
  const top = boxTop(count, spec.countSize, spec.baseline) - (height - countBox) / 2;
  const children = [
    <TextWidget
      key="count"
      text={count}
      maxLines={1}
      allowFontScaling={false}
      style={{ fontSize: spec.countSize, fontWeight: 'bold', color: f.paint.palette.foreground }}
    />,
    statusDot(f, spec.r),
    flexText(f, 'label', { value, size: spec.labelSize, weight: '600' }),
  ];
  return (
    <FlexWidget
      key="status"
      style={{
        ...place(f, { x: spec.x, y: top, width: spec.width, height }),
        flexDirection: 'row',
        alignItems: 'center',
        flexGap: STATUS_GAP,
      }}
    >
      {f.paint.rtl ? children.toReversed() : children}
    </FlexWidget>
  );
}

/** The stacked count (Small/Medium/Large): the number on its own line, then dot → label. */
export function stackedStatus(
  f: Frame,
  spec: {
    x: number;
    countBaseline: number;
    countSize: number;
    labelBaseline: number;
    labelSize: number;
    r: number;
    width: number;
  }
) {
  const value = f.copy.primaryLabel ?? '';
  const children = [
    statusDot(f, spec.r),
    flexText(f, 'label', { value, size: spec.labelSize, weight: '600' }),
  ];
  // The dot's centre sits 5dp in from the count's leading edge.
  const rect = {
    x: spec.x + 5 - spec.r,
    y: boxTop(value, spec.labelSize, spec.labelBaseline),
    width: spec.width - 5 + spec.r,
    height: lineBox(value, spec.labelSize),
  };
  return [
    label(f, 'count', {
      x: spec.x,
      baseline: spec.countBaseline,
      width: spec.width,
      value: f.copy.primaryCount,
      size: spec.countSize,
      weight: 'bold',
    }),
    <FlexWidget
      key="status"
      style={{ ...place(f, rect), flexDirection: 'row', alignItems: 'center', flexGap: STATUS_GAP }}
    >
      {f.paint.rtl ? children.toReversed() : children}
    </FlexWidget>,
  ];
}
