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
  type Ink,
  label,
  lineBox,
  PAD,
  textRow,
} from './active-agents-widget-parts';
import { approveFailed } from './active-agents-widget-row';
import { statusRow } from './active-agents-widget-status';
import { type Block, phaseOf, stack } from './active-agents-widget-stack';

/**
 * Narrow (2x1: 172x104, rounds 5b/5c) and Landscape (~62dp rows, round 2b)
 * cells, inside the 14dp band. Both are short, so they compress: smaller
 * action glyphs, and fewer lines — Narrow drops its last line in a band too
 * short for it, Landscape is one line.
 */

/** Narrow: the header's 24dp glyphs sit on the padding line; the status band under them. */
const NARROW_HEADER = { cy: PAD + 12, r: 12 } as const;
const NARROW_DESIGN = { top: NARROW_HEADER.cy + NARROW_HEADER.r, bottom: 104 - PAD };
const NARROW_STATUS = { top: 41, bottom: 71 };
const NARROW_STATUS_CY = (NARROW_STATUS.top + NARROW_STATUS.bottom) / 2;

/** The 2x1 cell's last line: a failed approve, the scheduled wake, or the checked time. */
function narrowFoot(f: Frame): { value: string; ink: Ink } | null {
  const { copy } = f;
  const phase = phaseOf(copy);
  if (phase === 'updating') {
    return { value: copy.status ?? '', ink: 'muted' };
  }
  if (approveFailed(f)) {
    return { value: copy.actionLine ?? '', ink: 'warn' };
  }
  const value = (phase === 'content' ? copy.wake : null) ?? copy.footer;
  return value === null ? null : { value, ink: 'muted' };
}

function narrowFirst(f: Frame): Block {
  const { width: W, copy } = f;
  const phase = phaseOf(copy);
  const cy = NARROW_STATUS_CY;
  if (phase === 'updating') {
    return {
      ...NARROW_STATUS,
      draw: dy => [
        bar(f, 'bar-count', { x: PAD, y: cy - 10 + dy, width: 24, height: 20 }),
        bar(f, 'bar-label', { x: PAD + 32, y: cy - 6 + dy, width: 80, height: 12 }),
      ],
    };
  }
  if (phase === 'empty') {
    return {
      ...NARROW_STATUS,
      draw: dy => [
        label(f, 'status', {
          x: PAD,
          baseline: centredBaseline(14, cy) + dy,
          width: W - 2 * PAD,
          value: copy.emptyShort,
          size: 14,
          weight: '600',
        }),
      ],
    };
  }
  return {
    ...NARROW_STATUS,
    draw: dy => [
      statusRow(f, {
        x: PAD,
        baseline: centredBaseline(22, cy) + dy,
        width: W - 2 * PAD,
        countSize: 22,
        labelSize: 13,
        r: 3.5,
      }),
    ],
  };
}

function narrowLocked(f: Frame): Block {
  const value = f.copy.status ?? '';
  const size = 12;
  const width = f.width - 2 * PAD - 26;
  const lines = estimateWidth(value, size, true) > width ? 2 : 1;
  const line = lineBox(value, size);
  // Centred as it is expected to wrap; the box always keeps a second line in the band.
  const top = Math.min(
    (NARROW_DESIGN.top + NARROW_DESIGN.bottom - lines * line) / 2,
    NARROW_DESIGN.bottom - 2 * line
  );
  return {
    top,
    bottom: top + 2 * line,
    shrink: 1,
    draw: dy => [
      ...lock(f, { cx: PAD + 9, cy: top + (lines * line) / 2 + dy, size: 18 }),
      label(f, 'status', {
        x: PAD + 26,
        baseline: baselineAbove(value, size, top + lineBox(value, size)) + dy,
        width,
        value,
        size,
        weight: '600',
        lines: 2,
      }),
    ],
  };
}

export function narrow(f: Frame): ReactNode[] {
  const { width: W, height: H, copy } = f;
  const phase = phaseOf(copy);
  const brand = [
    logo(f, { x: PAD, y: NARROW_HEADER.cy - 8, size: 16 }),
    label(f, 'brand', {
      x: PAD + 22,
      baseline: centredBaseline(12, NARROW_HEADER.cy),
      width: 40,
      value: 'Kilo',
      size: 12,
      weight: '600',
    }),
  ];
  const edges = { top: NARROW_DESIGN.top, bottom: H - PAD };
  if (phase === 'locked') {
    const block = narrowLocked(f);
    const laid = stack({ blocks: [block], design: NARROW_DESIGN, edges, tailShrink: 1 });
    return [...brand, ...laid.nodes];
  }
  const actions = roundActions(f, { ...NARROW_HEADER, create: canCreate(f) });
  const foot = narrowFoot(f);
  const first: Block = { ...narrowFirst(f), shrink: 4 };
  const footBlock = (value: string, ink: Ink): Block => ({
    top: NARROW_DESIGN.bottom - lineBox(value, 11),
    bottom: NARROW_DESIGN.bottom,
    shrink: 4,
    draw: dy => [
      label(f, 'footer', {
        x: PAD,
        baseline: baselineAbove(value, 11, NARROW_DESIGN.bottom) + dy,
        width: W - 2 * PAD,
        value,
        size: 11,
        ink,
        ...(ink === 'warn' ? { weight: '600' as const } : {}),
      }),
    ],
  });
  const layout = (blocks: Block[]) =>
    stack({ blocks, design: NARROW_DESIGN, edges, tailShrink: blocks.length > 1 ? 0 : 4 });
  let laid = layout(foot === null ? [first] : [first, footBlock(foot.value, foot.ink)]);
  // A band too short for the last line keeps the status and drops the line.
  if (laid.slack < 0 && foot !== null) {
    laid = layout([first]);
  }
  return [...brand, ...actions, ...laid.nodes];
}

/** Landscape's action glyphs: 32dp, inside a 34dp band at the 62dp height. */
const LANDSCAPE_R = 16;
/** The mark at the leading start of the line, and the gap after it. */
const LANDSCAPE_LOGO = 18;
const LANDSCAPE_LOGO_GAP = 6;
const LANDSCAPE_GAP = 12;

/** The line's lead: what it draws and the width it needs at most. */
type Lead = { width: number; draw: (x: number, width: number) => ReactNode[] };

function landscapeLead(f: Frame, cy: number): Lead {
  const { copy } = f;
  const phase = phaseOf(copy);
  if (phase === 'updating') {
    return {
      width: 122,
      draw: x => [
        bar(f, 'bar-count', { x, y: cy - 10, width: 22, height: 20 }),
        bar(f, 'bar-label', { x: x + 32, y: cy - 6, width: 90, height: 12 }),
      ],
    };
  }
  if (phase === 'empty') {
    const value = copy.status ?? '';
    return {
      width: Math.ceil(estimateWidth(value, 14, true)) + 4,
      draw: (x, width) => [
        label(f, 'status', {
          x,
          baseline: centredBaseline(14, cy),
          width,
          value,
          size: 14,
          weight: '600',
        }),
      ],
    };
  }
  const r = 3.5;
  const natural =
    estimateWidth(copy.primaryCount, 20, true) +
    2 * r +
    estimateWidth(copy.primaryLabel ?? '', 14, true) +
    12;
  return {
    width: Math.ceil(natural) + 4,
    draw: (x, width) => [
      statusRow(f, {
        x,
        baseline: centredBaseline(20, cy),
        width,
        countSize: 20,
        labelSize: 14,
        r,
      }),
    ],
  };
}

/** What follows the lead: the failure, or the title (from 400dp) and the checked time or wake. */
function landscapeTail(f: Frame) {
  const { copy } = f;
  const phase = phaseOf(copy);
  if (approveFailed(f)) {
    return [
      { value: copy.actionLine ?? '', ink: 'warn' as const, weight: '600' as const, flex: true },
    ];
  }
  const tail =
    phase === 'updating' ? copy.status : ((phase === 'content' ? copy.wake : null) ?? copy.footer);
  if (tail === null || tail === '') {
    return [];
  }
  const title = phase === 'content' && f.width >= 400 ? copy.title : null;
  const muted = 'muted' as const;
  return title === null
    ? [{ value: tail, ink: muted, flex: true }]
    : [
        { value: title, ink: muted, flex: true },
        { value: '·', ink: muted },
        { value: tail, ink: muted },
      ];
}

function landscapeLocked(f: Frame, x: number, cy: number) {
  const size = 16;
  return [
    // The body (86% of the box) starts the lead, like the status does in the other states.
    ...lock(f, { cx: x + size * 0.43, cy, size }),
    label(f, 'status', {
      x: x + size + LANDSCAPE_LOGO_GAP,
      baseline: centredBaseline(14, cy),
      width: f.width - PAD - (x + size + LANDSCAPE_LOGO_GAP),
      value: f.copy.status ?? '',
      size: 14,
      weight: '600',
    }),
  ];
}

export function landscape(f: Frame): ReactNode[] {
  const { width: W, height: H, copy } = f;
  const phase = phaseOf(copy);
  const cy = H / 2;
  const mark = logo(f, { x: PAD, y: cy - LANDSCAPE_LOGO / 2, size: LANDSCAPE_LOGO });
  const x = PAD + LANDSCAPE_LOGO + LANDSCAPE_LOGO_GAP;
  if (phase === 'locked') {
    return [mark, ...landscapeLocked(f, x, cy)];
  }
  const actions =
    phase === 'updating' ? [] : roundActions(f, { cy, r: LANDSCAPE_R, create: canCreate(f) });
  const end = phase === 'updating' ? W - PAD : actionsStart(f, LANDSCAPE_R) - LANDSCAPE_GAP;
  const lead = landscapeLead(f, cy);
  const leadWidth = Math.min(lead.width, end - x);
  const tailX = x + leadWidth + LANDSCAPE_GAP;
  const parts = landscapeTail(f);
  // The tail shows only when it keeps a readable width beside the whole lead.
  const tail =
    parts.length > 0 && end - tailX >= 48
      ? [
          textRow(f, 'line', {
            x: tailX,
            baseline: centredBaseline(12, cy),
            width: end - tailX,
            size: 12,
            gap: 6,
            fill: false,
            parts,
          }),
        ]
      : [];
  return [mark, ...lead.draw(x, leadWidth), ...tail, ...actions];
}
