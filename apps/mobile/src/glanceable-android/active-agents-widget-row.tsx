'use no memo';

import { type ReactNode } from 'react';

import { actionsStart, canCreate, roundActions } from './active-agents-widget-actions';
import { lock, logo } from './active-agents-widget-glyphs';
import {
  bar,
  baselineAbove,
  centredBaseline,
  estimateWidth,
  type Frame,
  label,
  lineBox,
  PAD,
} from './active-agents-widget-parts';
import { statusRow } from './active-agents-widget-status';
import { type Block, phaseOf, stack } from './active-agents-widget-stack';

/**
 * Row (3x1, 4x1) at the 360x104 design, inside the 14dp band: a header line
 * (mark, Kilo, checked time), the status with the round actions, and one
 * muted line. Taller bands split the extra height across the gaps; a band too
 * short for the muted line drops it.
 */

/** The header line's centre, and where its tallest box (a taller-script time) ends. */
const HEADER_CY = PAD + 9;
const HEADER_BOTTOM = 31;
/** The design's content bottom: the padding line of the 104dp band. */
const DESIGN = { top: HEADER_BOTTOM, bottom: 104 - PAD };
/** The status band and the actions centred on it. */
const STATUS = { top: 35, bottom: 70 };
const STATUS_CY = (STATUS.top + STATUS.bottom) / 2;
const ACTION_R = 18;

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
  const baseline = centredBaseline(12, HEADER_CY);
  const nodes = [
    logo(f, { x: PAD, y: HEADER_CY - 7, size: 14 }),
    label(f, 'brand', { x: PAD + 20, baseline, width: 26, value: 'Kilo', size: 12, weight: '600' }),
  ];
  if ((phase === 'content' || phase === 'empty') && copy.footer !== null) {
    nodes.push(
      label(f, 'footer', {
        x: PAD + 48,
        baseline,
        width: f.width - 2 * PAD - 48,
        value: `· ${copy.footer}`,
        size: 11,
        ink: 'muted',
      })
    );
  }
  return nodes;
}

/** The bottom line (muted, or the warn failure), its box ending on the design's padding line. */
function lineBlock(f: Frame, value: string, spec: { key: string; warn?: boolean }) {
  const size = 12;
  return {
    top: DESIGN.bottom - lineBox(value, size),
    bottom: DESIGN.bottom,
    shrink: 4,
    draw: (dy: number) => [
      label(f, spec.key, {
        x: PAD,
        baseline: baselineAbove(value, size, DESIGN.bottom) + dy,
        width: f.width - 2 * PAD,
        value,
        size,
        ...(spec.warn === true
          ? { ink: 'warn' as const, weight: '600' as const }
          : { ink: 'muted' as const }),
      }),
    ],
  } satisfies Block;
}

function lockedBlocks(f: Frame): Block[] {
  const value = f.copy.status ?? '';
  const size = 15;
  const width = f.width - PAD - 34 - PAD;
  const lines = estimateWidth(value, size, true) > width ? 2 : 1;
  const line = lineBox(value, size);
  // The copy is centred as it is expected to wrap, but its box always keeps a
  // second line inside the band: an instruction never ellipsizes.
  const top = Math.min((DESIGN.top + DESIGN.bottom - lines * line) / 2, DESIGN.bottom - 2 * line);
  return [
    {
      top,
      bottom: top + 2 * line,
      shrink: 1,
      draw: dy => [
        ...lock(f, { cx: PAD + 10, cy: top + (lines * line) / 2 + dy, size: 20 }),
        label(f, 'status', {
          x: PAD + 34,
          baseline: baselineAbove(value, size, top + line) + dy,
          width,
          value,
          size,
          weight: '600',
          lines: 2,
        }),
      ],
    },
  ];
}

function blocksFor(f: Frame): Block[] {
  const { copy } = f;
  const phase = phaseOf(copy);
  const actions = (dy: number) =>
    roundActions(f, { cy: STATUS_CY + dy, r: ACTION_R, create: canCreate(f) });
  // The copy ends a gap before the first drawn action.
  const end = actionsStart(f, ACTION_R) - 12;
  if (phase === 'locked') {
    return lockedBlocks(f);
  }
  if (phase === 'updating') {
    return [
      {
        ...STATUS,
        shrink: 4,
        draw: dy => [
          bar(f, 'bar-count', { x: PAD, y: STATUS_CY - 13 + dy, width: 30, height: 26 }),
          bar(f, 'bar-label', { x: PAD + 40, y: STATUS_CY - 7 + dy, width: 110, height: 14 }),
        ],
      },
      {
        top: 74,
        bottom: DESIGN.bottom,
        shrink: 4,
        draw: dy => [bar(f, 'bar-line', { x: PAD, y: 77 + dy, width: 180, height: 10 })],
      },
    ];
  }
  if (phase === 'empty') {
    const value = copy.status ?? '';
    return [
      {
        ...STATUS,
        shrink: 4,
        draw: dy => [
          label(f, 'status', {
            x: PAD,
            baseline: centredBaseline(17, STATUS_CY) + dy,
            width: end - PAD,
            value,
            size: 17,
            weight: '600',
          }),
          ...actions(dy),
        ],
      },
      lineBlock(f, f.props.actions.newAgentLabel, { key: 'hint' }),
    ];
  }
  const failed = approveFailed(f);
  const line = failed ? copy.actionLine : agentLine(f);
  return [
    {
      ...STATUS,
      shrink: 4,
      draw: dy => [
        statusRow(f, {
          x: PAD,
          baseline: centredBaseline(26, STATUS_CY) + dy,
          width: end - PAD,
          countSize: 26,
          labelSize: 15,
          r: 4,
        }),
        ...actions(dy),
      ],
    },
    ...(line === null ? [] : [lineBlock(f, line, { key: 'line', warn: failed })]),
  ];
}

export function row(f: Frame): ReactNode[] {
  const blocks = blocksFor(f);
  const layout = (shown: Block[]) => {
    const last = shown.at(-1);
    // A gap left under the last block shrinks with it; a block on the bottom line has none.
    const tail = last === undefined || last.bottom >= DESIGN.bottom ? 0 : (last.shrink ?? 0);
    return stack({
      blocks: shown,
      design: DESIGN,
      edges: { top: HEADER_BOTTOM, bottom: f.height - PAD },
      tailShrink: tail,
    });
  };
  let laid = layout(blocks);
  // A band too short for the muted line keeps the status and drops the line.
  if (laid.slack < 0 && blocks.length > 1) {
    laid = layout(blocks.slice(0, 1));
  }
  return [...header(f), ...laid.nodes];
}
