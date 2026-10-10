'use no memo';

import { type ReactNode } from 'react';

import { canCreate, HEADER_GLYPH, roundActions } from './active-agents-widget-actions';
import { lock, logo } from './active-agents-widget-glyphs';
import {
  bar,
  baselineAbove,
  boxTop,
  CARD_PAD,
  centredBaseline,
  type Copy,
  dot,
  dotInk,
  estimateWidth,
  type Frame,
  type Ink,
  label,
  lineBox,
} from './active-agents-widget-parts';
import { stackedStatus } from './active-agents-widget-status';
import { fitRows, phaseOf, stack } from './active-agents-widget-stack';

/**
 * Small (2x2, 2x3), plus what Medium and Large share. Cards draw at the design
 * coordinates of a 170x170 / 364x170 / 364x382 widget inside a 14dp band on
 * every side. A taller cell keeps the layout: the extra height first buys agent
 * rows (up to 3), then splits evenly across the gaps; the footer's box ends on
 * the bottom padding line.
 */

/** Header ink ends where the 24dp glyphs, their tops on the padding line, end. */
export const HEADER_BOTTOM = HEADER_GLYPH.cy + HEADER_GLYPH.r;

/** The Kilo mark and "Kilo", centred on the header glyphs. */
export function brand(f: Frame) {
  const size = 18;
  return [
    logo(f, { x: CARD_PAD, y: HEADER_GLYPH.cy - size / 2, size }),
    label(f, 'brand', {
      x: CARD_PAD + size + 6,
      baseline: centredBaseline(13, HEADER_GLYPH.cy),
      width: 40,
      value: 'Kilo',
      size: 13,
      weight: '600',
    }),
  ];
}

/** The content edges: under the header, down to the top of the footer line on the padding. */
export function cardEdges(f: Frame) {
  return {
    top: HEADER_BOTTOM,
    bottom: f.height - CARD_PAD - lineBox(f.copy.footer ?? f.copy.status ?? '', 11),
  };
}

/** "Checked …" / "Last known · …", "Updating agents", or (`long`) the failed-approve sentence. */
export function footer(f: Frame, long: boolean) {
  const phase = phaseOf(f.copy);
  const failed = long && f.props.actionFeedback === 'couldNotApprove' && phase === 'content';
  let value = f.copy.footer ?? '';
  if (phase === 'updating') {
    value = f.copy.status ?? '';
  } else if (failed) {
    value = f.copy.approveFailed;
  }
  if (value === '') {
    return null;
  }
  return label(f, 'footer', {
    x: CARD_PAD,
    baseline: baselineAbove(value, 11, f.height - CARD_PAD),
    width: f.width - 2 * CARD_PAD,
    value,
    size: 11,
    ...(failed ? { weight: '600' as const, ink: 'warn' as const } : { ink: 'muted' as const }),
  });
}

/**
 * The locked composition: logo + Kilo, a centred lock and the copy under it; no
 * actions, no footer. The copy may always wrap to a second line (an instruction
 * never ellipsizes); `wrap` centres the block for two lines, as Small is drawn.
 */
export function locked(
  f: Frame,
  spec: {
    height: number;
    lockY: number;
    lockSize: number;
    baseline: number;
    size: number;
    wrap: boolean;
  }
) {
  const value = f.copy.status ?? '';
  const lines = spec.wrap || estimateWidth(value, spec.size, true) > f.width - 2 * CARD_PAD ? 2 : 1;
  const { nodes } = stack({
    blocks: [
      {
        top: spec.lockY - spec.lockSize / 2 - 2,
        bottom: boxTop(value, spec.size, spec.baseline) + lineBox(value, spec.size) * lines,
        shrink: 10,
        draw: dy => [
          ...lock(f, { cx: f.width / 2, cy: spec.lockY + dy, size: spec.lockSize }),
          label(f, 'status', {
            x: CARD_PAD,
            baseline: spec.baseline + dy,
            width: f.width - 2 * CARD_PAD,
            value,
            size: spec.size,
            weight: '600',
            lines: 2,
            align: 'center',
          }),
        ],
      },
    ],
    design: { top: HEADER_BOTTOM, bottom: spec.height - CARD_PAD },
    edges: { top: HEADER_BOTTOM, bottom: f.height - CARD_PAD },
    tailShrink: 10,
  });
  return [...brand(f), ...nodes];
}

export type Entry = { title: string; sub: string | null; ink: 'warn' | 'info' };

/** The agents a card lists: earliest waits while input is needed, else the next wakes. */
export function entries(copy: Copy): Entry[] {
  if (copy.primaryKind === 'needsInput') {
    return copy.waitingAgents.map(agent => ({
      title: agent.title,
      sub: agent.reason,
      ink: 'warn',
    }));
  }
  if (copy.primaryKind === 'scheduled') {
    return copy.scheduledAgents.map(agent => ({
      title: agent.title,
      sub: agent.time,
      ink: 'info',
    }));
  }
  return [];
}

/** Secondary counts as "3 Working" lines, each with its dot. */
export function countLines(
  f: Frame,
  spec: { x: number; baseline: number; step: number; width: number }
) {
  return f.copy.secondaryCounts.flatMap((line, index) => {
    const baseline = spec.baseline + index * spec.step;
    return [
      dot(f, `count-${line.kind}-dot`, {
        cx: spec.x,
        cy: baseline - 4,
        r: 4,
        fill: dotInk(line.kind),
      }),
      label(f, `count-${line.kind}`, {
        x: spec.x + 12,
        baseline,
        width: spec.width,
        value: `${line.count} ${line.label}`,
        size: 13,
      }),
    ];
  });
}

type Line = { value: string; ink: Ink; weight?: '600' };

/**
 * The Small cell's agent lines: a failed approve first, else the scheduled wake
 * or the lead title; a taller cell adds the next waiting or scheduled titles.
 */
function smallLines(f: Frame): Line[] {
  const { copy } = f;
  const lines: Line[] = [];
  if (f.props.actionFeedback === 'couldNotApprove') {
    lines.push({ value: copy.actionLine ?? '', ink: 'warn', weight: '600' });
  }
  if (copy.primaryKind === 'needsInput' && copy.waitingAgents.length > 0) {
    lines.push(
      ...copy.waitingAgents.map(agent => ({ value: agent.title, ink: 'foreground' as const }))
    );
  } else if (copy.primaryKind === 'scheduled') {
    if (copy.wake !== null) {
      lines.push({ value: copy.wake, ink: copy.wakeOverdue ? 'muted' : 'foreground' });
    }
    lines.push(
      ...copy.scheduledAgents.map(agent => ({ value: agent.title, ink: 'foreground' as const }))
    );
  } else if (copy.title !== null) {
    lines.push({ value: copy.title, ink: 'foreground' });
  }
  return lines.slice(0, 3);
}

/** The cards' design content bottom: the footer box top at the 170dp frame. */
export const CARD_DESIGN_BOTTOM = 170 - CARD_PAD - 15;

function smallBody(f: Frame): ReactNode[] {
  const { width: W, copy } = f;
  const design = { top: HEADER_BOTTOM, bottom: CARD_DESIGN_BOTTOM };
  const edges = cardEdges(f);
  const phase = phaseOf(copy);
  const width = W - 2 * CARD_PAD;
  if (phase === 'updating') {
    return stack({
      blocks: [
        {
          top: 62,
          bottom: 114,
          shrink: 10,
          draw: dy => [
            bar(f, 'bar-count', { x: CARD_PAD, y: 62 + dy, width: 44, height: 30, pad: CARD_PAD }),
            bar(f, 'bar-label', { x: CARD_PAD, y: 102 + dy, width: 96, height: 12, pad: CARD_PAD }),
          ],
        },
      ],
      design,
      edges,
      tailShrink: 10,
    }).nodes;
  }
  if (phase === 'empty') {
    const value = copy.status ?? '';
    const status = {
      x: CARD_PAD,
      baseline: 104,
      width,
      value,
      size: 17,
      weight: '600',
      lines: 2,
    } as const;
    return stack({
      blocks: [
        {
          top: boxTop(value, 17, 104),
          bottom: 128.5,
          height: lineBox(value, 17) * 2,
          shrink: 20,
          draw: dy => [label(f, 'status', { ...status, baseline: 104 + dy })],
        },
      ],
      design,
      edges,
      tailShrink: 4,
    }).nodes;
  }
  const lines = smallLines(f);
  const layout = (count: number) =>
    stack({
      blocks: [
        {
          top: 31.5,
          bottom: 101.7,
          shrink: 4,
          draw: dy =>
            stackedStatus(f, {
              x: CARD_PAD,
              countBaseline: 78 + dy,
              countSize: 44,
              labelBaseline: 98 + dy,
              labelSize: 14,
              r: 4,
              width,
            }),
        },
        {
          top: 103.3,
          bottom: 120.5,
          height: 17.2 + Math.max(0, count - 1) * 19,
          ...(count === 0
            ? {}
            : {
                draw: (dy: number) =>
                  lines.slice(0, count).map((line, index) =>
                    label(f, `line-${index}`, {
                      x: CARD_PAD,
                      baseline: 117 + index * 19 + dy,
                      width,
                      value: line.value,
                      size: 13,
                      ink: line.ink,
                      ...(line.weight === undefined ? {} : { weight: line.weight }),
                    })
                  ),
              }),
        },
      ],
      design,
      edges,
      tailShrink: 12,
    });
  return layout(fitRows(lines.length, layout)).nodes;
}

export function small(f: Frame): ReactNode[] {
  if (phaseOf(f.copy) === 'locked') {
    return locked(f, { height: 170, lockY: 76, lockSize: 26, baseline: 108, size: 13, wrap: true });
  }
  const actions = roundActions(f, { ...HEADER_GLYPH, create: canCreate(f) });
  return [...brand(f), ...actions, ...smallBody(f), footer(f, false)];
}
