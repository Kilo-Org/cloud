'use no memo';

import { type ReactNode } from 'react';

import { canCreate, newAgentPill, pillActions } from './active-agents-widget-actions';
import {
  brand,
  cardEdges,
  entries,
  footer,
  HEADER_BOTTOM,
  locked,
} from './active-agents-widget-card';
import {
  divider,
  heading,
  largeStatus,
  runRow,
  type Status,
  waitRow,
} from './active-agents-widget-large-rows';
import { bar, boxTop, estimateWidth, type Frame, label } from './active-agents-widget-parts';
import { stackedStatus } from './active-agents-widget-status';
import { type Block, fitRows, phaseOf, stack } from './active-agents-widget-stack';

/** Large (3x3, 4x3, 4x4) at the 364x382 design. */

const DESIGN = { top: HEADER_BOTTOM, bottom: 352.4 };

/** Needs input (rounds 2/6) and scheduled (round 4): the count block, then a titled list. */
function listed(f: Frame) {
  const { copy } = f;
  const rows = entries(copy);
  const scheduled = copy.primaryKind === 'scheduled';
  const step = scheduled ? 34 : 46;
  const status: Status = scheduled
    ? { countBaseline: 128, countSize: 80, labelBaseline: 158, labelSize: 19, r: 5 }
    : { countBaseline: 106, countSize: 64, labelBaseline: 131, labelSize: 17, r: 4.5 };
  const short = scheduled ? (copy.wake ?? copy.title) : null;
  const list = scheduled
    ? { top: 206, bottom: 329.7, heading: 232, first: 258, value: copy.headings.nextScheduled }
    : { top: 152, bottom: 314.1, heading: 176, first: 202, value: copy.headings.waitingForYou };
  const layout = (count: number) =>
    stack({
      blocks: [
        {
          top: scheduled ? 43.5 : 38.4,
          bottom: scheduled ? 185.4 : 135.5,
          shrink: 4,
          draw: dy => [
            ...largeStatus(f, { ...status, countsBaseline: 74, step: 22 }, dy),
            ...(short === null
              ? []
              : [
                  label(f, 'short', {
                    x: 16,
                    baseline: 182 + dy,
                    width: f.width - 32,
                    value: short,
                    size: 13,
                    ink: 'muted',
                  }),
                ]),
          ],
        },
        {
          top: list.top,
          bottom: list.bottom,
          height: list.bottom - list.top - (3 - count) * step,
          shrink: 8,
          ...(count === 0
            ? {}
            : {
                draw: (dy: number) => [
                  divider(f, list.top + dy),
                  heading(f, 'section', { value: list.value, baseline: list.heading + dy }),
                  ...rows.slice(0, count).flatMap((entry, index) => {
                    const row = { index, baseline: list.first + index * step + dy };
                    return scheduled ? runRow(f, entry, row) : waitRow(f, entry, row);
                  }),
                ],
              }),
        },
      ],
      design: DESIGN,
      edges: cardEdges(f),
      tailShrink: 20,
    });
  return layout(fitRows(Math.min(3, rows.length), layout)).nodes;
}

/** Working or idle (round 3): the latest title, and the next wake when one is scheduled. */
function latest(f: Frame) {
  const { copy } = f;
  const mixed = copy.secondaryCounts.length > 0;
  const next = copy.scheduledAgents[0];
  const recent = (top: number, headingBaseline: number, titleBaseline: number): Block => ({
    top,
    bottom: titleBaseline + 4,
    shrink: 10,
    ...(copy.title === null
      ? {}
      : {
          draw: (dy: number) => [
            divider(f, top + dy),
            heading(f, 'recent-heading', {
              value: copy.headings.recent,
              baseline: headingBaseline + dy,
            }),
            label(f, 'recent-title', {
              x: 16,
              baseline: titleBaseline + dy,
              width: f.width - 32,
              value: copy.title ?? '',
              size: 15,
            }),
          ],
        }),
  });
  const blocks: Block[] = mixed
    ? [
        {
          top: 52.4,
          bottom: 149.5,
          shrink: 8,
          draw: dy =>
            largeStatus(
              f,
              {
                countBaseline: 120,
                countSize: 64,
                labelBaseline: 145,
                labelSize: 17,
                r: 4.5,
                countsBaseline: 92,
                step: 24,
              },
              dy
            ),
        },
        recent(178, 210, 234),
        {
          top: 271.3,
          bottom: 329.1,
          shrink: 12,
          ...(next === undefined
            ? {}
            : {
                draw: (dy: number) => [
                  heading(f, 'next-heading', {
                    value: copy.headings.nextScheduled,
                    baseline: 284 + dy,
                  }),
                  ...waitRow(
                    f,
                    { title: next.title, sub: next.time, ink: 'info' },
                    { index: 0, baseline: 308 + dy }
                  ),
                ],
              }),
        },
      ]
    : [
        {
          top: 75.1,
          bottom: 208.3,
          shrink: 14,
          draw: dy =>
            stackedStatus(f, {
              x: 16,
              countBaseline: 168 + dy,
              countSize: 88,
              labelBaseline: 203 + dy,
              labelSize: 20,
              r: 5,
              width: f.width - 32,
            }),
        },
        recent(238, 268, 292),
      ];
  return stack({ blocks, design: DESIGN, edges: cardEdges(f), tailShrink: mixed ? 10 : 20 }).nodes;
}

function placeholders(f: Frame) {
  const bars = [
    ['bar-count', 80, 70, 60],
    ['bar-label', 152, 140, 16],
    ['bar-row-0', 210, 300, 14],
    ['bar-row-0-sub', 232, 180, 11],
    ['bar-row-1', 262, 260, 14],
    ['bar-row-1-sub', 284, 160, 11],
  ] as const;
  return stack({
    blocks: [
      {
        top: 80,
        bottom: 295,
        shrink: 20,
        draw: dy =>
          bars.map(([key, y, width, height]) => bar(f, key, { x: 16, y: y + dy, width, height })),
      },
    ],
    design: DESIGN,
    edges: cardEdges(f),
    tailShrink: 20,
  }).nodes;
}

function empty(f: Frame) {
  const value = f.copy.status ?? '';
  const lines = estimateWidth(value, 22, true) > f.width - 32 ? 2 : 1;
  const extra = (lines - 1) * 26;
  return stack({
    blocks: [
      {
        top: boxTop(value, 22, 176),
        bottom: 234 + extra,
        shrink: 40,
        draw: dy => [
          label(f, 'status', {
            x: 16,
            baseline: 176 + dy,
            width: f.width - 32,
            value,
            size: 22,
            weight: '600',
            lines,
            align: 'center',
          }),
          ...newAgentPill(f, {
            x: 0,
            y: 198 + extra + dy,
            height: 36,
            size: 14,
            arm: 7,
            centred: true,
          }),
        ],
      },
    ],
    design: DESIGN,
    edges: cardEdges(f),
    tailShrink: 40,
  }).nodes;
}

export function large(f: Frame): ReactNode[] {
  const { copy } = f;
  const phase = phaseOf(copy);
  if (phase === 'locked') {
    return locked(f, {
      height: 382,
      lockY: 168,
      lockSize: 40,
      baseline: 236,
      size: 20,
      wrap: false,
    });
  }
  if (phase === 'updating') {
    return [...brand(f), ...placeholders(f), footer(f, true)];
  }
  if (phase === 'empty') {
    return [...brand(f), ...empty(f), footer(f, true)];
  }
  const body =
    copy.primaryKind === 'needsInput' || copy.primaryKind === 'scheduled' ? listed(f) : latest(f);
  return [...brand(f), ...pillActions(f, canCreate(f)), ...body, footer(f, true)];
}
