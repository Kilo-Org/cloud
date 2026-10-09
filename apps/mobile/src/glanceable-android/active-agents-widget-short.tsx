'use no memo';

import { type ReactNode } from 'react';

import { approveSlot, canCreate, roundActions } from './active-agents-widget-actions';
import { lock, logo } from './active-agents-widget-glyphs';
import { bar, boxTop, type Frame, type Ink, label, textRow } from './active-agents-widget-parts';
import { statusRow } from './active-agents-widget-status';
import { approveFailed } from './active-agents-widget-row';
import { type Block, phaseOf, stack } from './active-agents-widget-stack';

/** Narrow (2x1: 172x104, rounds 5b/5c) and Landscape (~62dp rows, round 2b) cells. */

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
  if (phase === 'updating') {
    return {
      top: 50,
      bottom: 70,
      draw: dy => [
        bar(f, 'bar-count', { x: 14, y: 50 + dy, width: 24, height: 20 }),
        bar(f, 'bar-label', { x: 46, y: 54 + dy, width: 80, height: 12 }),
      ],
    };
  }
  if (phase === 'empty') {
    const value = copy.emptyShort;
    return {
      top: boxTop(value, 14, 66),
      bottom: 69.7,
      draw: dy => [
        label(f, 'status', {
          x: 14,
          baseline: 66 + dy,
          width: W - 28,
          value,
          size: 14,
          weight: '600',
        }),
      ],
    };
  }
  return {
    top: 40.5,
    bottom: 74.9,
    draw: dy => [
      statusRow(f, {
        x: 14,
        baseline: 68 + dy,
        width: W - 28,
        countSize: 26,
        labelSize: 13,
        r: 3.5,
      }),
    ],
  };
}

export function narrow(f: Frame): ReactNode[] {
  const { width: W, height: H, copy } = f;
  const phase = phaseOf(copy);
  const brand = [
    logo(f, { x: 14, y: 14, size: 16 }),
    label(f, 'brand', { x: 36, baseline: 27, width: 40, value: 'Kilo', size: 12, weight: '600' }),
  ];
  const design = { top: 36, bottom: 90 };
  const edges = { top: 36, bottom: H - 14 };
  if (phase === 'locked') {
    const value = copy.status ?? '';
    const status = {
      x: 42,
      baseline: 62,
      width: W - 56,
      value,
      size: 12,
      weight: '600',
      lines: 2,
    } as const;
    const block: Block = {
      top: boxTop(value, 12, 62),
      bottom: 80,
      shrink: 10,
      draw: dy => [
        ...lock(f, { cx: 24, cy: 66 + dy, size: 18 }),
        label(f, 'status', { ...status, baseline: 62 + dy }),
      ],
    };
    return [...brand, ...stack({ blocks: [block], design, edges, tailShrink: 8 }).nodes];
  }
  const actions = roundActions(f, {
    cy: 22,
    r: 14,
    plus: W - 28,
    approve: W - 60,
    plusTarget: W - 48,
    create: canCreate(f),
  });
  const foot = narrowFoot(f);
  const footBlock: Block = {
    top: 78.4,
    bottom: 92.9,
    shrink: 4,
    ...(foot === null
      ? {}
      : {
          draw: (dy: number) => [
            label(f, 'footer', {
              x: 14,
              baseline: 90 + dy,
              width: W - 28,
              value: foot.value,
              size: 11,
              ink: foot.ink,
              ...(foot.ink === 'warn' ? { weight: '600' as const } : {}),
            }),
          ],
        }),
  };
  const blocks = [{ ...narrowFirst(f), shrink: 10 }, footBlock];
  return [...brand, ...actions, ...stack({ blocks, design, edges, tailShrink: 6 }).nodes];
}

function landscapeFirst(f: Frame, end: number): Block {
  const { copy } = f;
  const phase = phaseOf(copy);
  if (phase === 'updating') {
    return {
      top: 13,
      bottom: 33,
      draw: dy => [
        bar(f, 'bar-count', { x: 14, y: 13 + dy, width: 22, height: 20 }),
        bar(f, 'bar-label', { x: 46, y: 17 + dy, width: 90, height: 12 }),
      ],
    };
  }
  if (phase === 'empty') {
    const value = copy.status ?? '';
    return {
      top: boxTop(value, 14, 28),
      bottom: 31.7,
      draw: dy => [
        label(f, 'status', {
          x: 14,
          baseline: 28 + dy,
          width: end - 14,
          value,
          size: 14,
          weight: '600',
        }),
      ],
    };
  }
  return {
    top: 7.8,
    bottom: 36.9,
    draw: dy => [
      statusRow(f, {
        x: 14,
        baseline: 31 + dy,
        width: end - 14,
        countSize: 22,
        labelSize: 14,
        r: 3.5,
      }),
    ],
  };
}

/** The second line: logo + checked time (with the title first from 400dp), or the failure. */
function landscapeSecond(f: Frame, end: number): Block {
  const { copy } = f;
  const phase = phaseOf(copy);
  const tail =
    phase === 'updating' ? copy.status : ((phase === 'content' ? copy.wake : null) ?? copy.footer);
  const title = phase === 'content' && f.width >= 400 ? copy.title : null;
  const block = { top: 37.4, bottom: 51.9 };
  if (approveFailed(f)) {
    const value = copy.actionLine ?? '';
    return {
      ...block,
      draw: dy => [
        label(f, 'line', {
          x: 14,
          baseline: 49 + dy,
          width: end - 14,
          value,
          size: 11,
          weight: '600',
          ink: 'warn',
        }),
      ],
    };
  }
  if (tail === null) {
    return block;
  }
  const muted = 'muted' as const;
  const parts = [
    ...(title === null
      ? []
      : [
          { value: title, ink: muted, flex: true },
          { value: '·', ink: muted },
        ]),
    { value: tail, ink: muted, ...(title === null ? { flex: true } : {}) },
  ];
  return {
    ...block,
    draw: dy => [
      logo(f, { x: 14, y: 40 + dy, size: 11 }),
      textRow(f, 'line', {
        x: 33,
        baseline: 49 + dy,
        width: end - 33,
        size: 11,
        gap: 8,
        fill: false,
        parts,
      }),
    ],
  };
}

export function landscape(f: Frame): ReactNode[] {
  const { width: W, height: H, copy } = f;
  const phase = phaseOf(copy);
  const design = { top: 0, bottom: 62 };
  const edges = { top: 0, bottom: H };
  if (phase === 'locked') {
    const value = copy.status ?? '';
    const block: Block = {
      top: 21,
      bottom: 40,
      shrink: 8,
      draw: dy => [
        ...lock(f, { cx: 26, cy: 31 + dy, size: 18 }),
        label(f, 'status', {
          x: 46,
          baseline: 36 + dy,
          width: W - 60,
          value,
          size: 14,
          weight: '600',
        }),
      ],
    };
    return stack({ blocks: [block], design, edges, tailShrink: 8 }).nodes;
  }
  const end = approveSlot(f) === null ? W - 60 : W - 102;
  const actions =
    phase === 'updating'
      ? []
      : roundActions(f, {
          cy: H / 2,
          r: 18,
          plus: W - 32,
          approve: W - 74,
          plusTarget: W - 50,
          create: canCreate(f),
        });
  const blocks = [{ ...landscapeFirst(f, end), shrink: 4 }, landscapeSecond(f, end)];
  return [...actions, ...stack({ blocks, design, edges, tailShrink: 4 }).nodes];
}
