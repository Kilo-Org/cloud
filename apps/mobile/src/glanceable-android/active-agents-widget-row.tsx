'use no memo';

import { type ReactNode } from 'react';

import { approveSlot, canCreate, roundActions } from './active-agents-widget-actions';
import { lock, logo } from './active-agents-widget-glyphs';
import {
  bar,
  boxTop,
  estimateWidth,
  type Frame,
  label,
  lineBox,
} from './active-agents-widget-parts';
import { statusRow } from './active-agents-widget-status';
import { type Block, phaseOf, stack } from './active-agents-widget-stack';

/** Row (3x1, 4x1) at the 360x104 design; taller bands split the extra height across the gaps. */

const DESIGN = { top: 27.2, bottom: 90 };

export const approveFailed = (f: Frame) =>
  f.props.actionFeedback === 'couldNotApprove' && phaseOf(f.copy) === 'content';

/** The agent line a short cell shows: the lead title, with the scheduled wake after it. */
function agentLine(f: Frame): string | null {
  const { copy } = f;
  if (copy.primaryKind === 'scheduled') {
    return [copy.title, copy.wake].filter(Boolean).join('  ·  ') || null;
  }
  return copy.title;
}

function header(f: Frame) {
  const { copy } = f;
  const phase = phaseOf(copy);
  const nodes = [
    logo(f, { x: 14, y: 13, size: 14 }),
    label(f, 'brand', { x: 34, baseline: 24, width: 26, value: 'Kilo', size: 12, weight: '600' }),
  ];
  if ((phase === 'content' || phase === 'empty') && copy.footer !== null) {
    const value = `· ${copy.footer}`;
    nodes.push(
      label(f, 'footer', {
        x: 62,
        baseline: 24,
        width: f.width - 76,
        value,
        size: 11,
        ink: 'muted',
      })
    );
  }
  return nodes;
}

function lockedBlocks(f: Frame): Block[] {
  const value = f.copy.status ?? '';
  const lines = estimateWidth(value, 15, true) > f.width - 62 ? 2 : 1;
  const baseline = 72 - (lines - 1) * 9;
  return [
    {
      top: Math.min(55, boxTop(value, 15, baseline)),
      bottom: boxTop(value, 15, baseline) + lineBox(value, 15) * lines,
      shrink: 14,
      draw: dy => [
        ...lock(f, { cx: 28, cy: 66 + dy, size: 20 }),
        // Always room for a second line: an instruction never ellipsizes.
        label(f, 'status', {
          x: 48,
          baseline: baseline + dy,
          width: f.width - 62,
          value,
          size: 15,
          weight: '600',
          lines: 2,
        }),
      ],
    },
  ];
}

function blocksFor(f: Frame): Block[] {
  const { width: W, copy } = f;
  const phase = phaseOf(copy);
  const actions = (dy: number) =>
    roundActions(f, {
      cy: 52 + dy,
      r: 18,
      plus: W - 32,
      approve: W - 76,
      plusTarget: W - 50,
      create: canCreate(f),
    });
  // The label ends before the Approve slot only while that slot draws.
  const end = approveSlot(f) === null ? W - 58 : W - 102;
  if (phase === 'locked') {
    return lockedBlocks(f);
  }
  if (phase === 'updating') {
    return [
      {
        top: 40,
        bottom: 66,
        shrink: 8,
        draw: dy => [
          bar(f, 'bar-count', { x: 14, y: 40 + dy, width: 30, height: 26 }),
          bar(f, 'bar-label', { x: 54, y: 46 + dy, width: 110, height: 14 }),
        ],
      },
      {
        top: 78,
        bottom: 88,
        shrink: 6,
        draw: dy => [bar(f, 'bar-line', { x: 14, y: 78 + dy, width: 180, height: 10 })],
      },
    ];
  }
  if (phase === 'empty') {
    const value = copy.status ?? '';
    const hint = f.props.actions.newAgentLabel;
    return [
      {
        top: boxTop(value, 17, 62),
        bottom: 66.5,
        shrink: 10,
        draw: dy => [
          label(f, 'status', {
            x: 14,
            baseline: 62 + dy,
            width: end - 14,
            value,
            size: 17,
            weight: '600',
          }),
          ...actions(dy),
        ],
      },
      {
        top: 73.3,
        bottom: 89.1,
        shrink: 4,
        draw: dy => [
          label(f, 'hint', {
            x: 14,
            baseline: 86 + dy,
            width: end - 14,
            value: hint,
            size: 12,
            ink: 'muted',
          }),
        ],
      },
    ];
  }
  const failed = approveFailed(f);
  const line = failed ? copy.actionLine : agentLine(f);
  return [
    {
      top: 32.3,
      bottom: 72,
      shrink: 12,
      draw: dy => [
        statusRow(f, {
          x: 14,
          baseline: 64 + dy,
          width: end - 14,
          countSize: 30,
          labelSize: 15,
          r: 4,
        }),
        ...actions(dy),
      ],
    },
    {
      top: 74.3,
      bottom: 90.1,
      shrink: 8,
      ...(line === null
        ? {}
        : {
            draw: (dy: number) => [
              label(f, 'line', {
                x: 14,
                baseline: 87 + dy,
                width: W - 28,
                value: line,
                size: 12,
                ...(failed
                  ? { ink: 'warn' as const, weight: '600' as const }
                  : { ink: 'muted' as const }),
              }),
            ],
          }),
    },
  ];
}

export function row(f: Frame): ReactNode[] {
  const phase = phaseOf(f.copy);
  const { nodes } = stack({
    blocks: blocksFor(f),
    design: DESIGN,
    edges: { top: DESIGN.top, bottom: f.height - 14 },
    tailShrink: { locked: 8, updating: 2, empty: 6, content: 10 }[phase],
  });
  return [...header(f), ...nodes];
}
