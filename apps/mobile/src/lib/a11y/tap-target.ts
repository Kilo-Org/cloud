// Tap-target geometry for compact controls.
//
// A control's accessibility node is its laid-out box. `hitSlop` widens the
// touch region but never the reported bounds, so an icon that leans on
// `hitSlop` alone is still exposed to screen readers — and to the platform's
// target-size audit — as a sub-minimum control. Lay the icon out inside a
// `MIN_TAP_TARGET_CLASS` box, then top the touch region up to the design
// minimum (DESIGN.md: 44px on touch surfaces) with `hitSlopPerSide`.

/** Minimum side of a control's own layout box, in dp. */
export const MIN_TAP_TARGET_DP = 28;

/**
 * Literal NativeWind classes that lay a compact icon out inside a
 * `MIN_TAP_TARGET_DP` box. Kept literal so the class scanner sees them.
 */
export const MIN_TAP_TARGET_CLASS = 'min-h-[28px] min-w-[28px] items-center justify-center';

/** The design minimum touch target, in dp (DESIGN.md). */
export const TOUCH_TARGET_DP = 44;

/** Per-side `hitSlop` that lifts a `visualDp` box to `targetDp`; never negative. */
export function hitSlopPerSide(visualDp: number, targetDp: number = TOUCH_TARGET_DP): number {
  return Math.max(0, Math.ceil((targetDp - visualDp) / 2));
}
