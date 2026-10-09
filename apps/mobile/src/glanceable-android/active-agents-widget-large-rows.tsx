'use no memo';

import { countLines, type Entry } from './active-agents-widget-card';
import {
  dot,
  estimateWidth,
  type Frame,
  label,
  shape,
  textRow,
} from './active-agents-widget-parts';
import { stackedStatus } from './active-agents-widget-status';

/** The Large cell's building blocks: its status with the other counts, headings and list rows. */

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
  const clear = Math.ceil(16 + estimateWidth(f.copy.primaryCount, spec.countSize, true) + 16);
  const x = Math.max(Math.round(f.width * 0.621), clear);
  const counts = f.copy.secondaryCounts.length > 0 && f.width - 16 - (x + 12) >= 48;
  return [
    ...stackedStatus(f, {
      x: 16,
      countBaseline: spec.countBaseline + dy,
      countSize: spec.countSize,
      labelBaseline: spec.labelBaseline + dy,
      labelSize: spec.labelSize,
      r: spec.r,
      width: (counts ? x - 10 : f.width - 16) - 16,
    }),
    ...(counts
      ? countLines(f, {
          x,
          baseline: spec.countsBaseline + dy,
          step: spec.step,
          width: f.width - 16 - (x + 12),
        })
      : []),
  ];
}

export function divider(f: Frame, y: number) {
  return shape(f, 'divider', { x: 16, y, width: f.width - 32, height: 1, fill: 'divider' });
}

export function heading(f: Frame, key: string, spec: { value: string; baseline: number }) {
  return label(f, key, {
    ...spec,
    x: 16,
    width: f.width - 32,
    size: 12,
    weight: '600',
    ink: 'muted',
  });
}

/** A waiting row: dot, 14dp title, 12dp reason, 46dp apart. */
export function waitRow(f: Frame, entry: Entry, spec: { index: number; baseline: number }) {
  const { index, baseline } = spec;
  return [
    dot(f, `row-${index}-dot`, { cx: 21, cy: baseline - 5, r: 4, fill: entry.ink }),
    label(f, `row-${index}-title`, {
      x: 33,
      baseline,
      width: f.width - 49,
      value: entry.title,
      size: 14,
    }),
    ...(entry.sub === null
      ? []
      : [
          label(f, `row-${index}-sub`, {
            x: 33,
            baseline: baseline + 17,
            width: f.width - 49,
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
    dot(f, `row-${index}-dot`, { cx: 21, cy: baseline - 5, r: 4, fill: 'info' }),
    textRow(f, `row-${index}`, {
      x: 33,
      baseline,
      width: f.width - 49,
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
