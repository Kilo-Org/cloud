import { expect } from 'vitest';

/** A control below this on a side reports an accessibility node too small to tap reliably. */
const MIN_CONTROL_BOX = 28;

/** DESIGN.md: "preserve at least a 44px target even when the visual control is compact". */
const MIN_TOUCH_TARGET = 44;

type ControlProps = { className?: unknown; hitSlop?: unknown };

type HitSlop = { top: number; bottom: number; left: number; right: number };

/** Parses the `h-[<n>px] w-[<n>px]` box out of a rendered control's className. */
function controlBoxSize(className: unknown): number {
  const match = /h-\[(\d+)px\] w-\[(\d+)px\]/.exec(String(className));
  const size = match?.[1];
  if (size == null) {
    throw new Error(`control has no px box in className: ${String(className)}`);
  }
  return Number(size);
}

/**
 * Asserts a rendered control clears both tap-target minimums: its own box the
 * 28dp accessibility minimum, and its box plus `hitSlop` the 44pt touch target.
 */
export function expectReliableTapTarget({ className, hitSlop }: ControlProps): number {
  const box = controlBoxSize(className);
  const slop = hitSlop as HitSlop | undefined;
  if (slop == null) {
    throw new Error('control has no hitSlop');
  }
  expect(box).toBeGreaterThanOrEqual(MIN_CONTROL_BOX);
  expect(box + slop.left + slop.right).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  expect(box + slop.top + slop.bottom).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  return box;
}
