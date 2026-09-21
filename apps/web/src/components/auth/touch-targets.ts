/**
 * A link that runs inside a sentence cannot reserve the 44pt touch target
 * without pushing its line apart, so it clears Apple's hit-region bar with
 * coarse-pointer vertical padding instead: `py-4` is 16px a side, which puts
 * the smallest copy box (`text-xs`) at 2 x 16 + 12 = 44px while the line box
 * keeps its height. The padding is invisible (the link paints only its
 * underline). Shared so the sign-in form, the error notifications and the
 * blocked notice cannot drift apart.
 */
export const INLINE_LINK_TOUCH_TARGET = 'pointer-coarse:py-4';
