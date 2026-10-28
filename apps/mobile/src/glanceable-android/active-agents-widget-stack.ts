import { type ReactNode } from 'react';

import { type Copy, tenth } from './active-agents-widget-parts';

export type Phase = 'locked' | 'updating' | 'empty' | 'content';

const PHASES = {
  privacy: 'locked',
  unavailable: 'locked',
  signed_out: 'locked',
  waiting: 'updating',
  empty: 'empty',
  content: 'content',
} as const satisfies Record<Copy['statusKind'], Phase>;

export function phaseOf(copy: Copy): Phase {
  return PHASES[copy.statusKind];
}

/**
 * A vertical band of the design: `top`/`bottom` are its design extent (with
 * every optional block present), `height` what it draws now. `draw` gets the
 * offset from its design position; an absent `draw` omits the block.
 */
export type Block = {
  top: number;
  bottom: number;
  height?: number;
  shrink?: number;
  draw?: (dy: number) => ReactNode[];
};

type Edges = { top: number; bottom: number };

/**
 * Lay blocks between two edges. Gaps keep their design size; free height (also
 * the room an omitted block leaves) splits evenly across every gap so it never
 * pools in one hole, and a short cell takes the shortfall from each gap's
 * shrinkable share. `slack` is the free height before it is spread.
 */
export function stack(spec: { blocks: Block[]; design: Edges; edges: Edges; tailShrink?: number }) {
  const { blocks, design, edges } = spec;
  const gaps = blocks.map((block, index) => block.top - (blocks[index - 1]?.bottom ?? design.top));
  const tail = design.bottom - (blocks.at(-1)?.bottom ?? design.top);
  const present = blocks.flatMap((block, index) =>
    block.draw === undefined ? [] : [{ block, gap: gaps[index] ?? 0 }]
  );
  const natural =
    present.reduce(
      (sum, { block, gap }) => sum + gap + (block.height ?? block.bottom - block.top),
      0
    ) + tail;
  // Tenths absorb float noise, so an exact fit is not read as a shortfall.
  const slack = tenth(edges.bottom - edges.top - natural);
  const shrinks = [...present.map(({ block }) => block.shrink ?? 0), spec.tailShrink ?? 0];
  const shrinkable = shrinks.reduce((sum, value) => sum + value, 0);
  const deltas = shrinks.map(value =>
    slack >= 0 || shrinkable === 0 ? slack / shrinks.length : (slack * value) / shrinkable
  );
  let y = edges.top;
  const nodes = present.flatMap(({ block, gap }, index) => {
    y += gap + (deltas[index] ?? 0);
    const drawn = block.draw?.(y - block.top) ?? [];
    y += block.height ?? block.bottom - block.top;
    return drawn;
  });
  return { slack, nodes };
}

/** The most rows (from `most` down to one) whose layout still fits without shrinking. */
export function fitRows(most: number, layout: (rows: number) => { slack: number }): number {
  let rows = most;
  while (rows > 1 && layout(rows).slack < 0) {
    rows -= 1;
  }
  return rows;
}
