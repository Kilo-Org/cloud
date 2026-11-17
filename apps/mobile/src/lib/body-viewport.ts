/**
 * The smallest body viewport a screen keeps on screen.
 *
 * A reserved band — the tab bar's height, or the IME occlusion while the
 * keyboard is up — is a margin or a pad on a `flex-1` frame. A window shorter
 * than the band therefore leaves the frame zero points tall: nothing below the
 * header renders, nothing can be scrolled, and the body reads as blank with no
 * rows, skeleton, empty state or error to explain it. In that window the screen
 * gives up part of the band instead: the lowest `MIN_BODY_VIEWPORT` points of
 * the viewport can then sit under the translucent bar or the keyboard, which is
 * the lesser cost. Any window that can afford the whole band keeps it unchanged.
 *
 * Both reservations read this one number, so they cannot drift apart:
 * `@/components/tab-screen` clamps its scroll frame by it, and
 * `@/components/agents/owned-keyboard-lift` clamps the keyboard pad by it.
 */
export const MIN_BODY_VIEWPORT = 88;
