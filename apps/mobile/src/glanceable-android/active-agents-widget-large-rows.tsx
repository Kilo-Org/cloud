'use no memo';

import { countLines, type Entry } from './active-agents-widget-card';
import {
  CARD_PAD,
  dot,
  estimateWidth,
  type Frame,
  label,
  shape,
  textRow,
} from './active-agents-widget-parts';
import { stackedStatus } from './active-agents-widget-status';

/** The Large cell's building blocks: its status with the other counts, headings and list rows. */

/** A list row's dot centre and the start of its copy. */
const ROW_DOT_CX = CARD_PAD + 5;
const ROW_TEXT_X = CARD_PAD + 17;

export type Status = {
  countBaseline: number;
  countSize: number;
  labelBaseline: number;
  labelSize: number;
  r: number;
};

/** The count, with the other counts top-right (from 226dp of 364) when they clear a wide count. */
export function largeStatus(
  f: Frame,
  spec: Status & { countsBaseline: number; step: number },
  dy: number
) {
  const clear = Math.ceil(CARD_PAD + estimateWidth(f.copy.primaryCount, spec.countSize, true) + 16);
  const x = Math.max(Math.round(f.width * 0.621), clear);
  const counts = f.copy.secondaryCounts.length > 0 && f.width - CARD_PAD - (x + 12) >= 48;
  return [
    ...stackedStatus(f, {
      x: CARD_PAD,
      countBaseline: spec.countBaseline + dy,
      countSize: spec.countSize,
      labelBaseline: spec.labelBaseline + dy,
      labelSize: spec.labelSize,
      r: spec.r,
      width: (counts ? x - 10 : f.width - CARD_PAD) - CARD_PAD,
    }),
    ...(counts
      ? countLines(f, {
          x,
          baseline: spec.countsBaseline + dy,
          step: spec.step,
          width: f.width - CARD_PAD - (x + 12),
        })
      : []),
  ];
}

export function divider(f: Frame, y: number) {
  return shape(f, 'divider', {
    x: CARD_PAD,
    y,
    width: f.width - 2 * CARD_PAD,
    height: 1,
    fill: 'divider',
  });
}

export function heading(f: Frame, key: string, spec: { value: string; baseline: number }) {
  return label(f, key, {
    ...spec,
    x: CARD_PAD,
    width: f.width - 2 * CARD_PAD,
    size: 12,
    weight: '600',
    ink: 'muted',
  });
}

/** A waiting row: dot, 14dp title, 12dp reason, 46dp apart. */
export function waitRow(f: Frame, entry: Entry, spec: { index: number; baseline: number }) {
  const { index, baseline } = spec;
  return [
    dot(f, `row-${index}-dot`, { cx: ROW_DOT_CX, cy: baseline - 5, r: 4, fill: entry.ink }),
    label(f, `row-${index}-title`, {
      x: ROW_TEXT_X,
      baseline,
      width: f.width - ROW_TEXT_X - CARD_PAD,
      value: entry.title,
      size: 14,
    }),
    ...(entry.sub === null
      ? []
      : [
          label(f, `row-${index}-sub`, {
            x: ROW_TEXT_X,
            baseline: baseline + 17,
            width: f.width - ROW_TEXT_X - CARD_PAD,
            value: entry.sub,
            size: 12,
            ink: 'muted',
          }),
        ]),
  ];
}

/** A scheduled row: dot, title, and its time at the trailing edge, 34dp apart. */
export function runRow(f: Frame, entry: Entry, spec: { index: number; baseline: number }) {
  const { index, baseline } = spec;
  return [
    dot(f, `row-${index}-dot`, { cx: ROW_DOT_CX, cy: baseline - 5, r: 4, fill: 'info' }),
    textRow(f, `row-${index}`, {
      x: ROW_TEXT_X,
      baseline,
      width: f.width - ROW_TEXT_X - CARD_PAD,
      size: 14,
      gap: 8,
      fill: true,
      parts: [
        { value: entry.title, flex: true },
        ...(entry.sub === null ? [] : [{ value: entry.sub, ink: 'muted' as const }]),
      ],
    }),
  ];
}
