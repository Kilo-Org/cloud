/**
 * Tap-target geometry shared by the compact controls in the sessions headers:
 * the filter button and the search field's clear X.
 *
 * The box clears 28dp on its own. A compact control cannot rely on `hitSlop`
 * for that bar: the layout bounds are what a control is measured by, and
 * `hitSlop` never widens them, so a Pressable sized to its icon is read as too
 * small however far its slop reaches.
 *
 * The box is written as an arbitrary px value, never `h-7 w-7`: rem resolves to
 * 14px here (`react-native-css` root variable, and the device measurements in
 * `session-context-metrics.tsx`), so the spacing scale renders 24.5pt and would
 * still sit under the bar.
 *
 * 28pt plus 8pt of slop on every side is the 44pt touch target. The slop stops
 * at 8pt because a wider one would cross the 16px gap these controls share with
 * their neighbour and steal its taps, which puts Android's 48dp bar out of
 * reach for a header control.
 */
export const COMPACT_CONTROL_BOX_CLASS = 'h-[28px] w-[28px]';

/** `COMPACT_CONTROL_BOX_CLASS` in points, for the 44pt arithmetic. */
export const COMPACT_CONTROL_BOX_SIZE = 28;

/** Slop on every side of the box; the neighbours sit 16pt apart. */
export const COMPACT_CONTROL_HIT_SLOP = 8;
