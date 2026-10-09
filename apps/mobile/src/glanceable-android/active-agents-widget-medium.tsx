'use no memo';

import { type ReactNode } from 'react';

import { canCreate, newAgentPill, pillActions } from './active-agents-widget-actions';
import {
  brand,
  cardEdges,
  countLines,
  entries,
  type Entry,
  footer,
  HEADER_BOTTOM,
  locked,
} from './active-agents-widget-card';
import { bar, boxTop, dot, type Frame, label } from './active-agents-widget-parts';
import { stackedStatus } from './active-agents-widget-status';
import { fitRows, phaseOf, stack } from './active-agents-widget-stack';

/** Medium (3x2, 4x2) at the 364x170 design; its right column starts at 172dp and scales. */

const DESIGN = { top: HEADER_BOTTOM, bottom: 140.4 };

/** A Medium row: dot, 13dp title, 11dp reason or time, 42dp apart. */
function mediumRow(f: Frame, entry: Entry, spec: { index: number; x: number; baseline: number }) {
  const { index, baseline } = spec;
  const x = spec.x + 12;
  const width = f.width - 16 - x;
  return [
    dot(f, `row-${index}-dot`, { cx: spec.x, cy: baseline - 4, r: 4, fill: entry.ink }),
    label(f, `row-${index}-title`, { x, baseline, width, value: entry.title, size: 13 }),
    ...(entry.sub === null || entry.sub === ''
      ? []
      : [
          label(f, `row-${index}-sub`, {
            x,
            baseline: baseline + 16,
            width,
            value: entry.sub,
            size: 11,
            ink: 'muted',
          }),
        ]),
  ];
}

function placeholders(f: Frame, x: number) {
  return stack({
    blocks: [
      {
        top: 62,
        bottom: 138,
        shrink: 10,
        draw: dy => [
          bar(f, 'bar-count', { x: 16, y: 62 + dy, width: 44, height: 34 }),
          bar(f, 'bar-label', { x: 16, y: 104 + dy, width: 96, height: 12 }),
          bar(f, 'bar-row-0', { x: x + 4, y: 66 + dy, width: 150, height: 12 }),
          bar(f, 'bar-row-0-sub', { x: x + 4, y: 86 + dy, width: 100, height: 10 }),
          bar(f, 'bar-row-1', { x: x + 4, y: 108 + dy, width: 140, height: 12 }),
          bar(f, 'bar-row-1-sub', { x: x + 4, y: 128 + dy, width: 90, height: 10 }),
        ],
      },
    ],
    design: DESIGN,
    edges: cardEdges(f),
  }).nodes;
}

function empty(f: Frame) {
  const value = f.copy.status ?? '';
  return stack({
    blocks: [
      {
        top: boxTop(value, 20, 92),
        bottom: 134,
        shrink: 12,
        draw: dy => [
          label(f, 'status', {
            x: 16,
            baseline: 92 + dy,
            width: f.width - 32,
            value,
            size: 20,
            weight: '600',
          }),
          ...newAgentPill(f, { x: 16, y: 106 + dy, height: 28, size: 13, arm: 6, centred: false }),
        ],
      },
    ],
    design: DESIGN,
    edges: cardEdges(f),
    tailShrink: 2,
  }).nodes;
}

/** The right column: waiting/scheduled rows, else the other counts, else the latest title. */
function column(
  f: Frame,
  spec: { x: number; rows: Entry[]; count: number },
  dy: number
): ReactNode[] {
  const { copy } = f;
  const { x } = spec;
  if (spec.rows.length > 0) {
    return spec.rows
      .slice(0, spec.count)
      .flatMap((entry, index) => mediumRow(f, entry, { index, x, baseline: 74 + index * 42 + dy }));
  }
  if (copy.secondaryCounts.length > 0) {
    return countLines(f, { x: x + 4, baseline: 78 + dy, step: 24, width: f.width - 16 - (x + 16) });
  }
  if (copy.title === null) {
    return [];
  }
  const width = f.width - 16 - (x + 4);
  return [
    label(f, 'recent-heading', {
      x: x + 4,
      baseline: 88 + dy,
      width,
      value: copy.headings.recent,
      size: 11,
      weight: '600',
      ink: 'muted',
    }),
    label(f, 'recent-title', { x: x + 4, baseline: 106 + dy, width, value: copy.title, size: 13 }),
  ];
}

export function medium(f: Frame): ReactNode[] {
  const phase = phaseOf(f.copy);
  if (phase === 'locked') {
    return locked(f, {
      height: 170,
      lockY: 83,
      lockSize: 28,
      baseline: 118,
      size: 15,
      wrap: false,
    });
  }
  const x = Math.round(f.width * 0.4725);
  if (phase === 'updating') {
    return [...brand(f), ...placeholders(f, x), footer(f, true)];
  }
  if (phase === 'empty') {
    // The pill is the one create control here: the header `+` is hidden.
    return [...brand(f), ...empty(f), footer(f, true)];
  }
  const rows = entries(f.copy);
  let bottom = 115.7;
  if (rows.length === 0 && f.copy.secondaryCounts.length > 0) {
    bottom = 130.4;
  }
  const band = (count: number) =>
    stack({
      blocks: [
        {
          top: 45.5,
          bottom: 134.9,
          height: (rows.length > 0 ? Math.max(bottom, 92.9 + (count - 1) * 42) : bottom) - 45.5,
          shrink: 8,
          draw: dy => [
            ...stackedStatus(f, {
              x: 16,
              countBaseline: 92 + dy,
              countSize: 44,
              labelBaseline: 112 + dy,
              labelSize: 14,
              r: 4,
              width: x - 28,
            }),
            ...column(f, { x, rows, count }, dy),
          ],
        },
      ],
      design: DESIGN,
      edges: cardEdges(f),
      tailShrink: 4,
    });
  const count = fitRows(Math.min(3, rows.length), band);
  return [...brand(f), ...pillActions(f, canCreate(f)), ...band(count).nodes, footer(f, true)];
}
