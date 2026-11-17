/**
 * The launch splash's own mark, in dp. The branded splash plugin paints it
 * natively from these numbers and `AnimatedSplashOverlay` paints the same one
 * while the native splash hides, so the handover never moves or resizes it.
 */
export const SPLASH_LOGO_SIZE = 100;

/** The ring the overlay paints around the mark, on each side of it. */
const SPLASH_DISC_RING = 10;

/** The reveal disc: the mark plus its ring, the halo the wipe grows from. */
export const SPLASH_DISC_SIZE = SPLASH_LOGO_SIZE + SPLASH_DISC_RING * 2;
